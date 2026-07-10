import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { MemoryAgentJournalOutput } from "@socrates/contracts"
import { afterEach, describe, expect, it } from "vitest"
import { openDatabase, runMigrations } from "../../db/client"
import { memoryAgentJournal } from "../../db/schema"
import { normalizeMemoryJournalOutput } from "./memoryAgentJournal"
import { MemoryStore } from "./memoryStore"

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const output = (summary: string, title = "Verification gate"): MemoryAgentJournalOutput => ({
  summary,
  patternsObserved: [{ name: "Context first", finding: "Investigation precedes implementation.", evidenceTurnIds: ["turn-1"] }],
  skillsAffected: [],
  decisions: ["Wait for more evidence."],
  openInvestigations: [{ title, currentUnderstanding: "The gate repeats.", evidenceTurnIds: ["turn-1"], nextStep: "Inspect another turn." }],
  nextRunFocus: ["Inspect another workflow."],
})

describe("Memory Agent journal continuity", () => {
  it("reuses investigation ids for the same normalized title", () => {
    const first = normalizeMemoryJournalOutput(output("first"))
    const second = normalizeMemoryJournalOutput(output("second", "  VERIFICATION   gate "), first)
    expect(first.openInvestigations[0]?.investigationId).toMatch(/^meminv_/)
    expect(second.openInvestigations[0]?.investigationId).toBe(first.openInvestigations[0]?.investigationId)
  })

  it("bounds list/read output and renders only the latest three summaries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-memory-journal-"))
    tempRoots.push(root)
    const handle = openDatabase(path.join(root, "test.sqlite"))
    runMigrations(handle)
    const socratesHome = path.join(root, "home")
    const memory = new MemoryStore({ handle, appendEvent: () => undefined }, { socratesHome })
    for (let index = 1; index <= 4; index += 1) {
      const normalized = normalizeMemoryJournalOutput(output(`summary-${index} ${"x".repeat(700)}`))
      handle.db.insert(memoryAgentJournal).values({
        id: `journal-${index}`,
        jobId: `job-${index}`,
        summary: normalized.summary,
        patternsObservedJson: JSON.stringify(normalized.patternsObserved),
        skillsAffectedJson: JSON.stringify(normalized.skillsAffected),
        decisionsJson: JSON.stringify(normalized.decisions),
        openInvestigationsJson: JSON.stringify(normalized.openInvestigations),
        nextRunFocusJson: JSON.stringify(normalized.nextRunFocus),
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        thinkingEnabled: true,
        thinkingEffort: "high",
        status: "completed",
        createdAt: `2026-07-10T00:00:0${index}.000Z`,
        metadataJson: "{}",
      }).run()
    }
    handle.sqlite.prepare(
      "INSERT INTO memory_agent_actions (id, job_id, project_id, target_kind, target_path, status, requires_confirmation, patch_json, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("action-1", "job-4", "global-memory-agent", "skill_request", "/tmp/context-first/SKILL.md", "applied", 1, "{}", "2026-07-10T00:00:05.000Z", JSON.stringify({ operation: "create", scope: "global", skillName: "context-first" }))
    handle.sqlite.prepare(
      "INSERT INTO skill_writer_jobs (id, scope, operation, skill_name, source_kind, status, provider_id, model_id, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("writer-1", "global", "create", "context-first", "memory_agent", "completed", "deepseek", "deepseek-v4-flash", "2026-07-10T00:00:05.000Z", "2026-07-10T00:00:06.000Z")

    const listed = memory.runReadMemoryJournalTool({ operation: "list", limit: 10, charLimit: 1_000 })
    expect(listed.runs.length).toBeLessThanOrEqual(4)
    expect(listed.truncation.charLimit).toBe(1_000)
    expect(listed.truncation.returnedLength).toBeLessThanOrEqual(1_000)
    expect(() => memory.runReadMemoryJournalTool({ operation: "read", runId: "missing" })).toThrow(/not found/)
    const read = memory.runReadMemoryJournalTool({ operation: "read", runId: "job-4", charLimit: 1_000 })
    expect(read.content?.length).toBe(1_000)
    expect(read.truncation.truncated).toBe(true)

    const internal = memory as unknown as { writeMemoryAgentLedger(): void; buildMemoryAgentBriefing(): string }
    internal.writeMemoryAgentLedger()
    const ledger = fs.readFileSync(path.join(socratesHome, "memory_agent", "MEMORY_AGENT_LEDGER.md"), "utf8")
    expect(ledger).toContain("summary-4")
    expect(ledger).toContain("summary-2")
    expect(ledger).not.toContain("summary-1")
    expect(ledger).toContain("Skill proposals recorded: 1")
    expect(ledger).toContain("Memory proposal create global:context-first — applied")
    expect(ledger).toContain("Skill Writer create global:context-first — completed")
    const briefing = internal.buildMemoryAgentBriefing()
    expect(briefing).toContain("Previous Handoff")
    expect(briefing).toContain("summary-4")
    expect(briefing).toContain(normalizedInvestigationId(memory, "job-4"))
    handle.close()
  })
})

const normalizedInvestigationId = (memory: MemoryStore, runId: string): string => {
  const read = memory.runReadMemoryJournalTool({ operation: "read", runId })
  const parsed = JSON.parse(read.content ?? "{}") as MemoryAgentJournalOutput
  return parsed.openInvestigations[0]?.investigationId ?? "missing"
}
