import { describe, expect, it } from "vitest"
import { DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS, precomputeContextSnapshot, prepareContextForModelCall, type ContextCompactionSummary } from "../index"
import type { ModelEvent, ModelProvider, ModelRequest } from "@socrates/providers"

const runtimeConfig = {
  providerId: "openai" as const,
  modelId: "gpt-5.4-mini",
  thinkingEnabled: false,
  thinkingEffort: "none" as const,
  approvalMode: "manual" as const,
  sandboxMode: "read_only" as const,
}

describe("context compression", () => {
  it("uses the raised default threshold constants", () => {
    expect(DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS).toMatchObject({
      precomputeTokens: 145_000,
      synchronousTokens: 160_000,
      targetTokens: 120_000,
      hardCapTokens: 180_000,
    })
  })

  it("does not compact below the default synchronous threshold", async () => {
    const provider = providerWithCounts([159_999])
    const messages = [{ role: "user" as const, content: "small", id: "msg_1", turnId: "turn_1" }]

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages,
      compression: { enabled: true },
    })

    expect(prepared.messages).toEqual(messages)
    expect(prepared.estimatedTokens).toBe(159_999)
    expect(prepared.compactionEvents).toEqual([])
  })

  it("compacts at the default synchronous threshold and passes the raised packed target", async () => {
    const requests: ModelRequest[] = []
    const startedTargets: number[] = []
    const provider = providerWithCounts([160_000, 119_000], requests)

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: [{ role: "user", content: "large", id: "msg_1", turnId: "turn_1" }],
      compression: {
        enabled: true,
        startSnapshot: (input) => {
          startedTargets.push(input.targetTokens)
        },
      },
    })

    expect(prepared.compactionEvents.map((event) => event.type)).toEqual([
      "context.compaction.started",
      "context.compaction.completed",
    ])
    expect(prepared.compactionEvents[0]).toMatchObject({ targetTokens: 120_000 })
    expect(prepared.estimatedTokens).toBe(119_000)
    expect(startedTargets).toEqual([120_000])
    const compressorContent = requests[0]?.messages[0]?.content
    expect(JSON.parse(typeof compressorContent === "string" ? compressorContent : "")).toMatchObject({ targetTokens: 120_000 })
  })

  it("precomputes at the default background threshold", async () => {
    const provider = providerWithCounts([145_000, 120_000])
    const startedTargets: number[] = []

    const events = await precomputeContextSnapshot({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: [{ role: "user", content: "large", id: "msg_1", turnId: "turn_1" }],
      compression: {
        enabled: true,
        startSnapshot: (input) => {
          startedTargets.push(input.targetTokens)
        },
      },
    })

    expect(events.map((event) => event.type)).toEqual(["context.compaction.started", "context.compaction.completed"])
    expect(events[0]).toMatchObject({ reason: "precompute", targetTokens: 120_000 })
    expect(startedTargets).toEqual([120_000])
  })

  it("does not compact below the synchronous threshold", async () => {
    const provider = providerFrom([{ type: "model.completed" }])
    const messages = [{ role: "user" as const, content: "small", id: "msg_1", turnId: "turn_1" }]

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages,
      compression: {
        enabled: true,
        thresholds: { synchronousTokens: 10_000 },
      },
    })

    expect(prepared.messages).toEqual(messages)
    expect(prepared.compactionEvents).toEqual([])
  })

  it("compacts over-threshold history into a hidden developer block while preserving recent typed messages", async () => {
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        requests.push(request)
        yield {
          type: "model.answer.delta",
          text: JSON.stringify({
            goals: ["finish contextual compression"],
            currentTaskState: { status: "testing" },
            decisions: ["Keep recent messages as real messages."],
            protectedAnchors: [{ messageId: "msg_old" }],
            filesAndArtifacts: [],
            failuresAndBlockers: [],
            openTasks: ["Run typecheck."],
            sourceHandles: [{ messageId: "msg_old" }, { turnId: "turn_old" }],
          }),
        }
        yield { type: "model.completed", usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 } }
      },
    }
    const completed: ContextCompactionSummary[] = []

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: [
        { role: "user", content: "old ".repeat(400), id: "msg_old", turnId: "turn_old" },
        { role: "assistant", content: "recent assistant", id: "msg_recent_a", turnId: "turn_recent" },
        { role: "user", content: "recent user", id: "msg_recent_u", turnId: "turn_recent" },
      ],
      compression: {
        enabled: true,
        thresholds: { synchronousTokens: 10, hardCapTokens: 10_000, recentMessageCount: 2 },
        completeSnapshot: (input) => {
          completed.push({
            snapshotId: input.snapshotId,
            summary: input.summary,
            renderedSummary: input.renderedSummary,
            sourceHandles: input.sourceHandles,
            outputTokensEstimate: input.outputTokensEstimate,
          })
        },
      },
    })

    expect(requests[0]?.providerId).toBe("openrouter")
    expect(requests[0]?.modelId).toBe("deepseek/deepseek-v4-flash")
    expect(requests[0]?.runtimeConfig).toMatchObject({ thinkingEnabled: false, thinkingEffort: "none" })
    expect(prepared.compactionEvents.map((event) => event.type)).toEqual([
      "context.compaction.started",
      "context.compaction.completed",
    ])
    expect(prepared.messages[0]).toMatchObject({ role: "developer" })
    expect(String(prepared.messages[0]?.content)).toContain("context_compaction_summary")
    expect(prepared.messages.slice(1)).toEqual([
      { role: "assistant", content: "recent assistant", id: "msg_recent_a", turnId: "turn_recent" },
      { role: "user", content: "recent user", id: "msg_recent_u", turnId: "turn_recent" },
    ])
    expect(completed[0]?.sourceHandles).toEqual([{ messageId: "msg_old" }, { turnId: "turn_old" }])
  })

  it("reports compressor failures as lifecycle events", async () => {
    const failedSnapshots: string[] = []
    const provider = providerFrom([
      {
        type: "model.failed",
        error: new Error("compressor unavailable"),
      },
      {
        type: "model.failed",
        error: new Error("fallback unavailable"),
      },
    ])

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: [{ role: "user", content: "large ".repeat(400), id: "msg_1", turnId: "turn_1" }],
      compression: {
        enabled: true,
        thresholds: { synchronousTokens: 10 },
        failSnapshot: (input) => {
          failedSnapshots.push(input.snapshotId)
        },
      },
    })

    expect(prepared.compactionEvents.map((event) => event.type)).toEqual(["context.compaction.failed"])
    expect(failedSnapshots).toEqual([expect.stringMatching(/^ctxcmp_/)])
    expect(prepared.messages[0]).toMatchObject({ role: "user", id: "msg_1" })
  })

  it("uses injected provider token counts for thresholds instead of character length", async () => {
    const provider: ModelProvider = {
      countTokens: async (request) => ({
        providerId: request.providerId,
        modelId: request.modelId,
        inputTokens: 20,
        baseTokens: 20,
        method: "local_tiktoken",
        safetyMarginPercent: 0,
      }),
      async *stream() {
        yield {
          type: "model.answer.delta",
          text: JSON.stringify({
            goals: ["count tokens"],
            currentTaskState: {},
            decisions: [],
            protectedAnchors: [],
            filesAndArtifacts: [],
            failuresAndBlockers: [],
            openTasks: [],
            sourceHandles: [{ messageId: "msg_1" }],
          }),
        }
        yield { type: "model.completed" }
      },
    }

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: [{ role: "user", content: "tiny", id: "msg_1", turnId: "turn_1" }],
      compression: {
        enabled: true,
        thresholds: { synchronousTokens: 10, hardCapTokens: 20_000 },
      },
    })

    expect(prepared.compactionEvents.map((event) => event.type)).toEqual([
      "context.compaction.started",
      "context.compaction.completed",
    ])
  })

  it("recounts packed context after compaction before returning it", async () => {
    const countedMessages: unknown[] = []
    let countCall = 0
    const provider: ModelProvider = {
      countTokens: async (request) => {
        countCall += 1
        countedMessages.push(request.messages)
        return {
          providerId: request.providerId,
          modelId: request.modelId,
          inputTokens: countCall === 1 ? 20 : 7,
          baseTokens: countCall === 1 ? 20 : 7,
          method: "local_tiktoken",
          safetyMarginPercent: 0,
        }
      },
      async *stream() {
        yield {
          type: "model.answer.delta",
          text: JSON.stringify({
            goals: ["recount"],
            currentTaskState: {},
            decisions: [],
            protectedAnchors: [],
            filesAndArtifacts: [],
            failuresAndBlockers: [],
            openTasks: [],
            sourceHandles: [{ messageId: "msg_1" }],
          }),
        }
        yield { type: "model.completed" }
      },
    }

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: [{ role: "user", content: "tiny", id: "msg_1", turnId: "turn_1" }],
      compression: {
        enabled: true,
        thresholds: { synchronousTokens: 10, hardCapTokens: 20_000 },
      },
    })

    expect(countedMessages).toHaveLength(2)
    expect(JSON.stringify(countedMessages[1])).toContain("context_compaction_summary")
    expect(prepared.estimatedTokens).toBe(7)
    expect(prepared.tokenCount.inputTokens).toBe(7)
  })

  it("uses Qwen fallback when the DeepSeek primary compressor fails", async () => {
    const requests: ModelRequest[] = []
    const completedModels: string[] = []
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        requests.push(request)
        if (request.modelId === "deepseek/deepseek-v4-flash") {
          yield { type: "model.failed", error: new Error("primary unavailable") }
          return
        }
        yield {
          type: "model.answer.delta",
          text: JSON.stringify({
            goals: ["fallback"],
            currentTaskState: {},
            decisions: [],
            protectedAnchors: [],
            filesAndArtifacts: [],
            failuresAndBlockers: [],
            openTasks: [],
            sourceHandles: [{ messageId: "msg_1" }],
          }),
        }
        yield { type: "model.completed" }
      },
    }

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: [{ role: "user", content: "large ".repeat(400), id: "msg_1", turnId: "turn_1" }],
      compression: {
        enabled: true,
        thresholds: { synchronousTokens: 10, hardCapTokens: 20_000 },
        completeSnapshot: (input) => {
          completedModels.push(`${input.compressorProviderId}:${input.compressorModelId}`)
        },
      },
    })

    expect(requests.map((request) => `${request.providerId}:${request.modelId}`)).toEqual([
      "openrouter:deepseek/deepseek-v4-flash",
      "openrouter:qwen/qwen3.6-35b-a3b",
    ])
    expect(prepared.compactionEvents.map((event) => event.type)).toEqual([
      "context.compaction.started",
      "context.compaction.completed",
    ])
    expect(completedModels).toEqual(["openrouter:qwen/qwen3.6-35b-a3b"])
  })

  it("precomputes a snapshot at the lower threshold without returning packed messages", async () => {
    const completed: string[] = []
    const provider = providerFrom([
      {
        type: "model.answer.delta",
        text: JSON.stringify({
          goals: ["precompute"],
          currentTaskState: {},
          decisions: [],
          protectedAnchors: [],
          filesAndArtifacts: [],
          failuresAndBlockers: [],
          openTasks: [],
          sourceHandles: [{ messageId: "msg_1" }],
        }),
      },
      { type: "model.completed" },
    ])

    const events = await precomputeContextSnapshot({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: [{ role: "user", content: "large ".repeat(400), id: "msg_1", turnId: "turn_1" }],
      compression: {
        enabled: true,
        thresholds: { precomputeTokens: 10, synchronousTokens: 10_000, hardCapTokens: 20_000 },
        completeSnapshot: (input) => {
          completed.push(input.snapshotId)
        },
      },
    })

    expect(events.map((event) => event.type)).toEqual(["context.compaction.started", "context.compaction.completed"])
    expect(events[0]).toMatchObject({ type: "context.compaction.started", reason: "precompute" })
    expect(completed).toEqual([expect.stringMatching(/^ctxcmp_/)])
  })
})

const providerWithCounts = (counts: number[], requests: ModelRequest[] = []): ModelProvider => {
  let countIndex = 0
  return {
    countTokens: async (request) => {
      const inputTokens = counts[Math.min(countIndex, counts.length - 1)] ?? 0
      countIndex += 1
      return {
        providerId: request.providerId,
        modelId: request.modelId,
        inputTokens,
        baseTokens: inputTokens,
        method: "local_tiktoken",
        safetyMarginPercent: 0,
      }
    },
    async *stream(request) {
      requests.push(request)
      yield {
        type: "model.answer.delta",
        text: JSON.stringify({
          goals: ["compress"],
          currentTaskState: {},
          decisions: [],
          protectedAnchors: [],
          filesAndArtifacts: [],
          failuresAndBlockers: [],
          openTasks: [],
          sourceHandles: [{ messageId: "msg_1" }],
        }),
      }
      yield { type: "model.completed" }
    },
  }
}

const providerFrom = (events: ModelEvent[]): ModelProvider => ({
  countTokens: fakeCountTokens,
  async *stream() {
    yield* events
  },
})

const fakeCountTokens: ModelProvider["countTokens"] = async (request) => {
  const baseTokens = Math.ceil(`${request.system}${JSON.stringify(request.messages)}${JSON.stringify(request.tools ?? [])}`.length / 4)
  return {
    providerId: request.providerId,
    modelId: request.modelId,
    inputTokens: baseTokens,
    baseTokens,
    method: "local_tiktoken",
    safetyMarginPercent: 0,
  }
}
