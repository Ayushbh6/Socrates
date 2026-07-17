import { describe, expect, it } from "vitest"
import type { MemorySearchOutput } from "@socrates/contracts"
import type { ModelProvider } from "@socrates/providers"
import { MemoryRouterAgent } from "../agent/MemoryRouterAgent"
import { POST_TURN_MEMORY_ROUTER_SYSTEM_PROMPT, PRE_TURN_MEMORY_ROUTER_SYSTEM_PROMPT } from "../prompts/memoryRoutingPrompt"
import type { ToolExecutors } from "../tools/types"

const context = {
  modelSettings: {
    providerId: "deepseek" as const,
    modelId: "deepseek-v4-flash",
    thinkingEnabled: false,
    thinkingEffort: "none" as const,
  },
  projectId: "proj_1",
  conversationId: "conv_1",
  sessionId: "sess_1",
  turnId: "turn_1",
  workspacePath: "/tmp",
  userMessage: "Let us activate slow mode and discuss the implementation plan before touching files.",
  recentMessages: [{ role: "user" as const, content: "Let us activate slow mode and discuss the implementation plan before touching files." }],
}

const slowModeResult = (): MemorySearchOutput => ({
  results: [{
    resultNumber: 1,
    content: "Slow Mode: pause and discuss the plan before implementation.",
    surface: "user_profile",
    fileName: "user_profile.md",
    sectionId: "collaboration_style",
    sectionHeading: "Collaboration Style",
    scope: "global",
  }],
  totalMatches: 1,
})

describe("MemoryRouterAgent", () => {
  it("keeps genuine memory opt-outs out of recall routing and final reconciliation", () => {
    expect(PRE_TURN_MEMORY_ROUTER_SYSTEM_PROMPT).toContain("Interpret it from the full semantic meaning")
    expect(PRE_TURN_MEMORY_ROUTER_SYSTEM_PROMPT).toContain("treat the entire latest user message as opted out")
    expect(PRE_TURN_MEMORY_ROUTER_SYSTEM_PROMPT).toContain("Keep workspace-artifact restrictions distinct from memory opt-outs")
    expect(PRE_TURN_MEMORY_ROUTER_SYSTEM_PROMPT).toContain("does not by itself opt content out")
    expect(POST_TURN_MEMORY_ROUTER_SYSTEM_PROMPT).toContain("blocks reconciliation")
    expect(POST_TURN_MEMORY_ROUTER_SYSTEM_PROMPT).toContain("Never preserve opted-out content indirectly")
    expect(POST_TURN_MEMORY_ROUTER_SYSTEM_PROMPT).toContain("still allows bounded `.socrates` reconciliation")
  })

  it("prefetches the full prompt, caps explicit search at three calls, and returns exact routes", async () => {
    let streamCall = 0
    let automaticCalls = 0
    let explicitCalls = 0
    const structuredMessages: unknown[] = []
    const provider: ModelProvider = {
      countTokens: async (request) => ({
        providerId: request.providerId,
        modelId: request.modelId,
        inputTokens: 1,
        baseTokens: 1,
        method: "local_tiktoken",
        safetyMarginPercent: 0,
      }),
      async *stream() {
        streamCall += 1
        for (let index = 0; index < 2; index += 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: `memory_search_${streamCall}_${index}`,
              toolName: "memory_search",
              input: { query: index === 0 ? "slow mode" : "implementation approval", mode: "combined", scope: "all", limit: 8 },
            },
          }
        }
        yield { type: "model.completed", finishReason: "tool-calls" }
      },
      async generateStructured(request) {
        structuredMessages.push(request.messages)
        return {
          output: {
            readTargets: [{
              surface: "user_profile",
              fileName: "user_profile.md",
              sectionId: "collaboration_style",
              reason: "The prompt explicitly invokes the stored slow-mode collaboration behavior.",
            }],
            reason: "Recall the exact collaboration section before Socrates plans the work.",
          } as never,
        }
      },
    }
    const executors = {
      memory_search: async () => {
        explicitCalls += 1
        return slowModeResult()
      },
    } as unknown as ToolExecutors
    const output = await new MemoryRouterAgent(provider).routePreTurn({
      ...context,
      toolExecutors: executors,
      automaticMemorySearch: async () => {
        automaticCalls += 1
        return slowModeResult()
      },
    })

    expect(automaticCalls).toBe(1)
    expect(explicitCalls).toBe(3)
    expect(streamCall).toBe(2)
    expect(JSON.stringify(structuredMessages)).toContain("Slow Mode")
    expect(JSON.stringify(structuredMessages).match(/tool-result/g)).toHaveLength(3)
    expect(output.readTargets[0]).toMatchObject({ fileName: "user_profile.md", sectionId: "collaboration_style" })
  })

  it("rejects a final object that does not satisfy the strict routing schema", async () => {
    let structuredCalls = 0
    const provider: ModelProvider = {
      countTokens: async (request) => ({ providerId: request.providerId, modelId: request.modelId, inputTokens: 1, baseTokens: 1, method: "local_tiktoken", safetyMarginPercent: 0 }),
      async *stream() {
        yield { type: "model.completed" }
      },
      async generateStructured() {
        structuredCalls += 1
        return { output: { readTargets: [{ surface: "user_profile", fileName: "MEMORY.md", sectionId: "collaboration_style", reason: "invalid ownership" }], reason: "invalid" } as never }
      },
    }
    await expect(new MemoryRouterAgent(provider).routePreTurn({
      ...context,
      toolExecutors: {} as ToolExecutors,
    })).rejects.toMatchObject({ code: "structured_agent_output_invalid" })
    expect(structuredCalls).toBe(2)
  })

  it("records failed status and all observed usage after the bounded repair is exhausted", async () => {
    const runs: unknown[] = []
    const provider: ModelProvider = {
      countTokens: async (request) => ({ providerId: request.providerId, modelId: request.modelId, inputTokens: 1, baseTokens: 1, method: "local_tiktoken", safetyMarginPercent: 0 }),
      async *stream() {
        yield { type: "model.usage", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }
        yield { type: "model.completed" }
      },
      async generateStructured() {
        return {
          output: { readTargets: [], reason: "" } as never,
          usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        }
      },
    }

    await expect(
      new MemoryRouterAgent(provider).routePreTurn({
        ...context,
        toolExecutors: {} as ToolExecutors,
        recordRun: (run) => {
          runs.push(run)
        },
      }),
    ).rejects.toMatchObject({ code: "structured_agent_output_invalid" })

    expect(runs).toEqual([
      expect.objectContaining({
        phase: "pre_turn",
        status: "failed",
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        usages: [
          { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
          { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
          { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
        ],
        error: expect.objectContaining({ code: "structured_agent_output_invalid", recoverable: true }),
      }),
    ])
  })

  it("repairs one invalid structured result using bounded validation feedback", async () => {
    let structuredCalls = 0
    const repairMessages: unknown[] = []
    const provider: ModelProvider = {
      countTokens: async (request) => ({ providerId: request.providerId, modelId: request.modelId, inputTokens: 1, baseTokens: 1, method: "local_tiktoken", safetyMarginPercent: 0 }),
      async *stream() {
        yield { type: "model.completed" }
      },
      async generateStructured(request) {
        structuredCalls += 1
        repairMessages.push(request.messages)
        if (structuredCalls === 1) return { output: { readTargets: [], reason: "" } as never }
        return { output: { readTargets: [], reason: "No project context is needed." } as never }
      },
    }
    const output = await new MemoryRouterAgent(provider).routePreTurn({
      ...context,
      toolExecutors: {} as ToolExecutors,
    })
    expect(output).toEqual({ readTargets: [], reason: "No project context is needed." })
    expect(structuredCalls).toBe(2)
    expect(JSON.stringify(repairMessages[1])).toContain("failed validation")
  })
})
