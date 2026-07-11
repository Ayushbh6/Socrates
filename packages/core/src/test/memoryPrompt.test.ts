import { describe, expect, it } from "vitest"
import { buildMemoryAgentSystemPrompt, createMemoryToolRegistry, createSkillWriterToolRegistry, memoryAgentBasePrompt } from "../index"

describe("memory agent prompt", () => {
  it("defines the backend memory-agent operating contract", () => {
    expect(memoryAgentBasePrompt).toContain("You are the Socrates Global Memory Agent")
    expect(memoryAgentBasePrompt).toContain("manifest of completed turns since your durable events.sequence watermark")
    expect(memoryAgentBasePrompt).toContain("trace_retrieve")
    expect(memoryAgentBasePrompt).toContain("same retrieval system as main Socrates")
    expect(memoryAgentBasePrompt).toContain("no legacy exact mode or trace-document handles exist")
    expect(memoryAgentBasePrompt).toContain("current_time")
    expect(memoryAgentBasePrompt).toContain("projects: list_projects or list_conversations")
    expect(memoryAgentBasePrompt).toContain("edit_files: the only write tool")
    expect(memoryAgentBasePrompt).toContain("Project-level writing belongs to Socrates")
    expect(memoryAgentBasePrompt).toContain("skills: list/search/read builtin/global/project skills")
    expect(memoryAgentBasePrompt).toContain('memory_notes: list/read/mark_done Socrates-to-Memory-Agent notes')
    expect(memoryAgentBasePrompt).toContain("then mark it done with outcome plus a one-line resolution")
    expect(memoryAgentBasePrompt).toContain("applied, already_represented, skipped, and proposed_skill")
    expect(memoryAgentBasePrompt).toContain("active_context: short-lived but currently useful user-life context")
    expect(memoryAgentBasePrompt).toContain("project-specific active context belongs in project notes")
    expect(memoryAgentBasePrompt).toContain("Mixed turns must be split strictly")
    expect(memoryAgentBasePrompt).toContain("update the content section and the evidence_index together")
    expect(memoryAgentBasePrompt).toContain('target="skill"')
    expect(memoryAgentBasePrompt).toContain("read_memory_journal: read-only access")
    expect(memoryAgentBasePrompt).toContain("strict structured journal object enforced by the runtime")
    expect(memoryAgentBasePrompt).toContain("openInvestigations: at most 10")
    expect(memoryAgentBasePrompt).toContain("Skill maturation is a core responsibility")
    expect(memoryAgentBasePrompt).toContain('skillsAffected action="already_represented" only after reading the current skill')
    expect(memoryAgentBasePrompt).not.toContain("Deep evidence comes from trace_documents")
  })

  it("adds runtime target context without changing the base prompt contract", () => {
    const prompt = buildMemoryAgentSystemPrompt({
      socratesHome: "/tmp/socrates-home",
    })

    expect(prompt).toContain(memoryAgentBasePrompt)
    expect(prompt).toContain("Current memory run:")
    expect(prompt).toContain("Global Socrates home: /tmp/socrates-home")
    expect(prompt).not.toContain("Project workspace:")
  })

  it("exposes the clean global trace contract to the Memory Agent", () => {
    const trace = createMemoryToolRegistry().get("trace_retrieve")
    expect(trace?.description).toContain("same retrieval behavior as the main agent")
    expect(trace?.inputSchema.safeParse({ mode: "lexical", query: "slow mode" }).success).toBe(true)
    expect(trace?.inputSchema.safeParse({ mode: "exact", query: "slow mode" }).success).toBe(false)
    expect(trace?.inputSchema.safeParse({ mode: "semantic", query: "how slow mode works", scope: "all_projects" }).success).toBe(true)
  })

  it("exposes only bounded read operations for prior journal history", () => {
    const journal = createMemoryToolRegistry().get("read_memory_journal")
    expect(journal?.permission).toBe("read")
    expect(journal?.inputSchema.safeParse({ operation: "list", limit: 10, charLimit: 20_000 }).success).toBe(true)
    expect(journal?.inputSchema.safeParse({ operation: "list", limit: 11 }).success).toBe(false)
    expect(journal?.inputSchema.safeParse({ operation: "read", runId: "run-1", charLimit: 20_001 }).success).toBe(false)
    expect(journal?.inputSchema.safeParse({ operation: "write", runId: "run-1" }).success).toBe(false)
  })

  it("keeps skill installation exclusive to main Socrates", () => {
    const skills = createMemoryToolRegistry().get("skills")
    expect(skills?.permission).toBe("read")
    expect(skills?.inputSchema.safeParse({ operation: "search", query: "review" }).success).toBe(true)
    expect(skills?.inputSchema.safeParse({ operation: "preview_import", url: "https://example.com/review.zip" }).success).toBe(false)
    expect(skills?.inputSchema.safeParse({ operation: "commit_import", previewId: `skillimp_${"a".repeat(32)}` }).success).toBe(false)
    expect(createSkillWriterToolRegistry().get("skills")?.inputSchema.safeParse({ operation: "preview_import", url: "https://example.com/review.zip" }).success).toBe(false)
  })
})
