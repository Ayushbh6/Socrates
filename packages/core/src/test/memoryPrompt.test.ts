import { describe, expect, it } from "vitest"
import { buildMemoryAgentSystemPrompt, memoryAgentBasePrompt } from "../index"

describe("memory agent prompt", () => {
  it("defines the backend memory-agent operating contract", () => {
    expect(memoryAgentBasePrompt).toContain("You are the Socrates Global Memory Agent")
    expect(memoryAgentBasePrompt).toContain("manifest of completed turns since your durable events.sequence watermark")
    expect(memoryAgentBasePrompt).toContain("trace_retrieve")
    expect(memoryAgentBasePrompt).toContain("projects: list_projects or list_conversations")
    expect(memoryAgentBasePrompt).toContain("edit_files: the only write tool")
    expect(memoryAgentBasePrompt).toContain("Project-level writing belongs to Socrates")
    expect(memoryAgentBasePrompt).toContain("Scheduled runs may read skills for guidance, but must not create or update them")
    expect(memoryAgentBasePrompt).toContain("exactly these four flat markdown sections")
    expect(memoryAgentBasePrompt).toContain("No chatty narration, nested subheaders, JSON, or patch proposals")
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
})
