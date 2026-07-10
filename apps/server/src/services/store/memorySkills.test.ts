import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { EditFilesToolOutput, SkillWriteToolInput, SkillWriteToolOutput } from "@socrates/contracts"
import { afterEach, describe, expect, it } from "vitest"
import { openDatabase, runMigrations } from "../../db/client"
import { MemoryStore } from "./memoryStore"
import { discoverSkills, validateSkillWriteMarkdown } from "./memorySkills"

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const skillContent = (name: string): string => [
  "---",
  `name: ${name}`,
  "description: Use when a repeatable context-first implementation workflow is required.",
  "---",
  "",
  "# Context-first delivery",
  "",
  "Use this workflow to keep investigation, authorization, implementation, and verification explicit.",
  "",
  "## Workflow",
  "",
  "- Inspect the relevant context and current state.",
  "- Clarify assumptions and wait for the implementation gate.",
  "- Implement the agreed plan and verify the observable result.",
  "",
].join("\n")

describe("skill write quality and identity", () => {
  it("requires a substantive procedural body for new writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-skill-parse-"))
    tempRoots.push(root)
    const skillFile = path.join(root, "context-first", "SKILL.md")
    expect(validateSkillWriteMarkdown("---\nname: context-first\ndescription: Too shallow.\n---\n# Title\n", skillFile)).toBeUndefined()
    expect(validateSkillWriteMarkdown(skillContent("context-first"), skillFile)).toMatchObject({ name: "context-first" })
  })

  it("uses canonical scoped ids, writes safe supporting files, and rejects no-op updates", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-skill-write-"))
    tempRoots.push(root)
    const handle = openDatabase(path.join(root, "test.sqlite"))
    runMigrations(handle)
    const socratesHome = path.join(root, "home")
    const memory = new MemoryStore({ handle, appendEvent: () => undefined }, { socratesHome })
    const writer = memory as unknown as {
      runSkillWriteTool: (
        input: SkillWriteToolInput,
        constraints: { expectedScope: "global"; expectedOperation: "create" | "update"; expectedName: string },
      ) => SkillWriteToolOutput
    }
    const content = `${skillContent("context-first")}\nSee [the checklist](references/checklist.md).\n`
    const created = writer.runSkillWriteTool({
      scope: "global",
      operation: "create",
      name: "context-first",
      content,
      changeSummary: "Create the approved context-first workflow and verification checklist.",
      evidenceTurnIds: ["turn-1", "turn-2"],
      files: [{ path: "references/checklist.md", content: "# Checklist\n\n- Confirm the implementation gate.\n" }],
    }, { expectedScope: "global", expectedOperation: "create", expectedName: "context-first" })
    expect(created.changedFiles).toEqual(["skills/context-first/SKILL.md", "skills/context-first/references/checklist.md"])
    expect(discoverSkills("global", path.join(socratesHome, "skills")).map((skill) => `${skill.scope}:${skill.name}`)).toEqual(["global:context-first"])
    const proposalStore = memory as unknown as {
      proposeSkillWrite: (input: unknown, resolved: unknown, context: { jobId: string; turnId?: string }) => EditFilesToolOutput
    }
    const proposed = proposalStore.proposeSkillWrite({
      target: "skill",
      name: "context-first",
      scope: "global",
      editMode: "create",
      newText: "Preserve the existing workflow and add a clean handoff gate after verification.",
      rationale: "A model may mistakenly say create while proposing maturation of an existing canonical skill.",
      sourceTurnIds: ["turn-3"],
    }, {
      path: path.join(socratesHome, "skills", "context-first", "SKILL.md"),
      targetKind: "skills",
      scope: "global",
    }, { jobId: "memjob-test" })
    expect(proposed.status).toBe("proposed")
    const proposalMetadata = handle.sqlite.prepare("SELECT metadata_json AS metadataJson FROM memory_agent_actions WHERE id = ?").get(proposed.actionId) as { metadataJson: string }
    expect(JSON.parse(proposalMetadata.metadataJson)).toMatchObject({ operation: "update", scope: "global", skillName: "context-first" })
    expect(() => writer.runSkillWriteTool({
      scope: "global",
      operation: "update",
      name: "context-first",
      content,
      changeSummary: "Claim an update without changing the approved workflow.",
      evidenceTurnIds: ["turn-3"],
      files: [{ path: "references/checklist.md", content: "# Checklist\n\n- Confirm the implementation gate.\n" }],
    }, { expectedScope: "global", expectedOperation: "update", expectedName: "context-first" })).toThrow(/meaningful file change/)
    expect(() => writer.runSkillWriteTool({
      scope: "global",
      operation: "update",
      name: "context-first",
      content,
      changeSummary: "Attempt an unsafe supporting file.",
      files: [{ path: "../outside.md", content: "unsafe" }],
    }, { expectedScope: "global", expectedOperation: "update", expectedName: "context-first" })).toThrow(/references\/.*scripts\/.*assets\//)
    handle.close()
  })
})
