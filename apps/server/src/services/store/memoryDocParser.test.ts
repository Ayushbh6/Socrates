import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { memoryDocRequiredSections } from "@socrates/contracts"
import { buildStructuredMemoryDoc, ensureStructuredMemoryDoc, parseMemoryDoc, patchMemoryDocSection, type MemoryDocProfile } from "./memoryDocParser"

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "socrates-memory-doc-test-"))
const bundledToolUsageDir = path.resolve(process.cwd(), "src/memory/defaults/primary/tool_usage")

const projectProfile: MemoryDocProfile = {
  docType: "project_memory",
  ownerTool: "project_docs",
  scope: "workspace",
  path: ".socrates/MEMORY.md",
  projectId: "proj_test",
  indexTags: ["memory", "project"],
}

describe("memory doc parser", () => {
  it("builds and parses a structured section index", () => {
    const content = buildStructuredMemoryDoc(projectProfile)
    const index = parseMemoryDoc(content, projectProfile)

    expect(index.warnings).toBeUndefined()
    expect(index.sections.map((section) => section.sectionId)).toEqual([
      "current_state",
      "durable_decisions",
      "constraints",
      "project_preferences",
      "blockers",
      "handoff",
      "evidence_anchors",
    ])
    expect(index.sections[0]?.lineStart).toBeGreaterThan(0)
    expect(index.sections[0]?.contentHash).toHaveLength(64)
  })

  it("patches only the requested section and rejects ambiguous section-local edits", () => {
    const content = buildStructuredMemoryDoc(projectProfile)
    const next = patchMemoryDocSection(
      content,
      projectProfile,
      "handoff",
      "- Restart-ready handoff facts belong here.",
      "- Restart from project_docs.read_index first.\n- Restart from project_docs.read_index first.",
    )
    const index = parseMemoryDoc(next, projectProfile)

    expect(index.sections.find((section) => section.sectionId === "handoff")?.content).toContain("project_docs.read_index")
    expect(index.sections.find((section) => section.sectionId === "current_state")?.content).toContain("Current project standing")
    expect(() => patchMemoryDocSection(next, projectProfile, "handoff", "project_docs.read_index", "project_docs.read_section")).toThrow(/matched more than once/)
  })

  it("wraps legacy markdown without losing the original text", () => {
    const filePath = path.join(tempDir(), ".socrates", "MEMORY.md")
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, "# Old Memory\n\nLegacy durable note.\n")

    ensureStructuredMemoryDoc(filePath, projectProfile)

    const content = fs.readFileSync(filePath, "utf8")
    const index = parseMemoryDoc(content, projectProfile)
    expect(content).toContain("socrates_doc: project_memory")
    expect(content).toContain("Legacy durable note.")
    expect(index.sections.some((section) => section.sectionId === "legacy_content")).toBe(true)
  })

  it("keeps bundled tool docs in the five-section structured format", () => {
    const files = listMarkdownFiles(bundledToolUsageDir)
    expect(files.map((filePath) => path.relative(bundledToolUsageDir, filePath).replaceAll(path.sep, "/")).sort()).toEqual([
      "current_time.md",
      "edit_apply_patch.md",
      "memory_agent/edit_files.md",
      "memory_agent/projects.md",
      "memory_agent/skills.md",
      "memory_agent/soul.md",
      "memory_agent/tool_docs.md",
      "memory_agent/trace_retrieve.md",
      "project_docs.md",
      "read_search.md",
      "repo_docs.md",
      "skills.md",
      "soul.md",
      "terminal.md",
      "tool_docs.md",
      "trace_retrieve.md",
    ])

    for (const filePath of files) {
      const relativePath = path.relative(bundledToolUsageDir, filePath).replaceAll(path.sep, "/")
      const content = fs.readFileSync(filePath, "utf8")
      const index = parseMemoryDoc(content, {
        docType: "tool_doc",
        ownerTool: "tool_docs",
        scope: "global",
        path: `tool_usage/${relativePath}`,
        projectId: "global",
        indexTags: ["tool_usage"],
      })
      expect(index.warnings, relativePath).toBeUndefined()
      expect(index.sections.map((section) => section.sectionId), relativePath).toEqual(memoryDocRequiredSections.tool_doc)
      expect(content, relativePath).not.toContain("Legacy Content")
      expect(content, relativePath).not.toContain("legacy_content")
      expect(content, relativePath).not.toContain("What this tool guidance is for")
      for (const section of index.sections) {
        expect(section.content.trim(), `${relativePath}:${section.sectionId}`).not.toBe("")
      }
    }
  })
})

const listMarkdownFiles = (root: string): string[] =>
  fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      return listMarkdownFiles(absolutePath)
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [absolutePath] : []
  })
