import { describe, expect, it } from "vitest"
import { buildMemoryAgentSystemPrompt, createMemoryToolRegistry, memoryAgentBasePrompt } from "../index"

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
    expect(memoryAgentBasePrompt).toContain("exactly these four flat markdown sections")
    expect(memoryAgentBasePrompt).toContain("No chatty narration, nested subheaders, JSON, or patch proposals")
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
})
