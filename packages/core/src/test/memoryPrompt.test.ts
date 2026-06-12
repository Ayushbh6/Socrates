import { describe, expect, it } from "vitest"
import { buildMemoryAgentSystemPrompt, memoryAgentBasePrompt } from "../index"

describe("memory agent prompt", () => {
  it("defines the backend memory-agent operating contract", () => {
    expect(memoryAgentBasePrompt).toContain("You are the Socrates backend memory agent")
    expect(memoryAgentBasePrompt).toContain("Your final JSON patch proposals are the only write channel")
    expect(memoryAgentBasePrompt).toContain("trace_retrieve")
    expect(memoryAgentBasePrompt).toContain("toolUsageDocPatches")
    expect(memoryAgentBasePrompt).toContain("skillPatches")
    expect(memoryAgentBasePrompt).toContain("soulPatchProposals")
    expect(memoryAgentBasePrompt).toContain("Project MEMORY.md, PROJECT_NOTES.md, repo_docs, diary entries, and project skills are not write targets")
  })

  it("adds runtime target context without changing the base prompt contract", () => {
    const prompt = buildMemoryAgentSystemPrompt({
      socratesHome: "/tmp/socrates-home",
      workspacePath: "/tmp/project",
    })

    expect(prompt).toContain(memoryAgentBasePrompt)
    expect(prompt).toContain("Current memory run:")
    expect(prompt).toContain("Global Socrates home: /tmp/socrates-home")
    expect(prompt).toContain("Project workspace: /tmp/project")
  })
})
