import { describe, expect, it } from "vitest"
import {
  DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS,
  buildCompressorUserMessageContent,
  type CompleteCompactionSnapshotInput,
  precomputeContextSnapshot,
  prepareContextForModelCall,
  type ContextCompactionSummary,
  type StartCompactionSnapshotInput,
} from "../index"
import type { ChatCompaction, MemoryCompaction } from "@socrates/contracts"
import type { ModelProvider, ModelRequest, StructuredModelRequest, StructuredModelResult } from "@socrates/providers"

const runtimeConfig = {
  providerId: "openai" as const,
  modelId: "gpt-5.4-mini",
  thinkingEnabled: false,
  thinkingEffort: "none" as const,
  approvalMode: "manual" as const,
  sandboxMode: "read_only" as const,
}

const SLOW_COMPRESSION_TEST_TIMEOUT_MS = 20_000

describe("context compression", () => {
  it("uses one v1 trigger and tail/tool pressure defaults", () => {
    expect(DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS).toEqual({
      triggerTokens: 170_000,
      postCompactionTargetTokens: 120_000,
      hardLimitTokens: 180_000,
      minimumReductionTokens: 20_000,
      recentTailTargetTokens: 50_000,
      currentTurnToolTailTargetTokens: 50_000,
      currentTurnToolResultFloor: 5,
    })
  })

  it("does not compact below the trigger", async () => {
    const provider = structuredProvider({ counts: [169_999] })
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
    expect(prepared.compactionEvents).toEqual([])
    expect(provider.structuredRequests).toHaveLength(0)
  })

  it("compacts at 170k through structured generation instead of streamed JSON parsing", async () => {
    const provider = structuredProvider({ counts: [170_000, 60_000], outputs: [validChat({ anchors: ["Turn 1: inspect old implementation decision."] })] })
    const startedTargets: number[] = []
    const streamEvents: string[] = []
    provider.onStream = () => streamEvents.push("stream")

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: threeTurnMessages(),
      compression: {
        enabled: true,
        thresholds: { triggerTokens: 170_000, recentTailTargetTokens: 1 },
        startSnapshot: (input) => {
          startedTargets.push(input.targetTokens)
        },
      },
    })

    expect(streamEvents).toEqual([])
    expect(provider.structuredRequests).toHaveLength(1)
    expect(provider.structuredRequests[0]).toMatchObject({ providerId: "openrouter", modelId: "deepseek/deepseek-v4-flash" })
    expect(prepared.compactionEvents.map((event) => event.type)).toEqual([
      "context.compaction.started",
      "context.compaction.completed",
    ])
    expect(prepared.compactionEvents[0]).toMatchObject({ targetTokens: 120_000 })
    expect(startedTargets).toEqual([120_000])
    expect(String(prepared.messages[0]?.content)).toContain("<socrates_internal_context_compaction>")
    expect(String(prepared.messages[0]?.content)).toContain("# Anchors")
    expect(prepared.estimatedTokens).toBe(60_000)
  })

  it("uses the memory compressor schema and prompt in memory mode at the same 170k trigger", async () => {
    const provider = structuredProvider({
      counts: [170_000, 60_000],
      outputs: [validMemory({ anchors: ["Turn 1: inspect old memory-agent evidence."] })],
    })

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: threeTurnMessages(),
      compression: {
        enabled: true,
        mode: "memory",
        thresholds: { triggerTokens: 170_000, recentTailTargetTokens: 1 },
      },
    })

    expect(provider.structuredRequests).toHaveLength(1)
    expect(provider.structuredRequests[0]?.system).toContain("Socrates Memory Agent Compressor")
    expect(String(provider.structuredRequests[0]?.messages[0]?.content)).toContain("# Old Memory-Agent Manifest Head")
    expect(String(provider.structuredRequests[0]?.messages[0]?.content)).not.toContain("# Old Head Turns To Compress")
    expect(String(prepared.messages[0]?.content)).toContain("<socrates_internal_memory_context_compaction>")
    expect(String(prepared.messages[0]?.content)).toContain("# Manifest Scope")
    expect(prepared.estimatedTokens).toBe(60_000)
  })

  it("can compact an initial oversized memory-agent manifest instead of requiring a completed chat head", async () => {
    const provider = structuredProvider({
      counts: [170_000, 60_000],
      outputs: [validMemory({ manifestScope: ["Covered the initial oversized memory-agent manifest."] })],
    })

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: [{ role: "user", content: "initial memory manifest " + "x".repeat(1000) }],
      compression: {
        enabled: true,
        mode: "memory",
        thresholds: { triggerTokens: 170_000 },
      },
    })

    expect(provider.structuredRequests).toHaveLength(1)
    expect(String(provider.structuredRequests[0]?.messages[0]?.content)).toContain("initial memory manifest")
    expect(JSON.stringify(prepared.messages)).toContain("Continue the Global Memory Agent run")
  })

  it("summarizes only the old head and keeps raw recent tail by whole Q&A turn", async () => {
    const provider = structuredProvider({ counts: [10, 5], outputs: [validChat()] })
    const messages = [
      { role: "user", content: "head user " + "x".repeat(5000), id: "msg_hu", turnId: "turn_1" },
      { role: "assistant", content: "head assistant", id: "msg_ha", turnId: "turn_1" },
      { role: "user", content: "tail user", id: "msg_tu", turnId: "turn_2" },
      { role: "assistant", content: "tail assistant", id: "msg_ta", turnId: "turn_2" },
      { role: "user", content: "active user", id: "msg_active", turnId: "turn_3" },
    ] as const

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: [...messages],
      compression: {
        enabled: true,
        thresholds: { triggerTokens: 10, recentTailTargetTokens: 500 },
      },
    })

    const compressorInput = String(provider.structuredRequests[0]?.messages[0]?.content)
    expect(compressorInput).toContain("head user")
    expect(compressorInput).not.toContain("tail user")
    expect(prepared.messages).toEqual([
      expect.objectContaining({ role: "developer" }),
      { role: "user", content: "tail user", id: "msg_tu", turnId: "turn_2" },
      { role: "assistant", content: "tail assistant", id: "msg_ta", turnId: "turn_2" },
      { role: "user", content: "active user", id: "msg_active", turnId: "turn_3" },
    ])
  }, SLOW_COMPRESSION_TEST_TIMEOUT_MS)

  it("carries the previous validated summary forward exactly once", async () => {
    const previous = "# Goal\nPrevious compacted context"
    const provider = structuredProvider({ counts: [10, 5], outputs: [validChat()] })

    await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: threeTurnMessages(),
      compression: {
        enabled: true,
        thresholds: { triggerTokens: 10, recentTailTargetTokens: 1 },
        getLatestSnapshot: () => ({
          snapshotId: "ctxcmp_prev",
          summary: validChat({ goal: "Previous compacted context" }),
          renderedSummary: previous,
          sourceHandles: [],
          outputTokensEstimate: 10,
        }),
      },
    })

    const compressorInput = String(provider.structuredRequests[0]?.messages[0]?.content)
    expect(countOccurrences(compressorInput, previous)).toBe(1)
  })

  it("repairs only invalid anchors when the rest of the object validates", async () => {
    const badAnchors = validChat({ anchors: ["inspect turn one without prefix"] })
    const provider = structuredProvider({
      counts: [10, 5],
      outputs: [badAnchors, { anchors: ["Turn 1: inspect the repaired anchor."] }],
    })
    const completed: ContextCompactionSummary[] = []

    await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: threeTurnMessages(),
      compression: {
        enabled: true,
        thresholds: { triggerTokens: 10, recentTailTargetTokens: 1 },
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

    expect(provider.structuredRequests).toHaveLength(2)
    expect(String(provider.structuredRequests[1]?.system)).toContain("repair only")
    expect(completed[0]?.summary.goal).toBe(badAnchors.goal)
    expect(completed[0]?.summary.anchors).toEqual(["Turn 1: inspect the repaired anchor."])
  })

  it("never activates malformed structured output", async () => {
    const provider = structuredProvider({
      counts: [10],
      outputs: [
        { decisions: [{ decision: "bad", handles: [] }] },
        { decisions: [{ decision: "still bad", handles: [] }] },
        { decisions: [{ decision: "fallback bad", handles: [] }] },
        { decisions: [{ decision: "second fallback bad", handles: [] }] },
      ],
    })
    const completed: string[] = []
    const failed: string[] = []

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: threeTurnMessages(),
      compression: {
        enabled: true,
        thresholds: { triggerTokens: 10, recentTailTargetTokens: 1 },
        compressorFallbacks: [
          { providerId: "openrouter", authMode: "api_key", modelId: "xiaomi/mimo-v2.5-pro" },
          { providerId: "openrouter", authMode: "api_key", modelId: "z-ai/glm-5.2" },
        ],
        completeSnapshot: (input) => {
          completed.push(input.snapshotId)
        },
        failSnapshot: (input) => {
          failed.push(input.snapshotId)
        },
      },
    })

    expect(provider.structuredRequests.map((request) => `${request.providerId}:${request.modelId}`)).toEqual([
      "openrouter:deepseek/deepseek-v4-flash",
      "openrouter:deepseek/deepseek-v4-flash",
      "openrouter:xiaomi/mimo-v2.5-pro",
      "openrouter:z-ai/glm-5.2",
    ])
    expect(completed).toEqual([])
    expect(failed).toEqual([expect.stringMatching(/^ctxcmp_/)])
    expect(prepared.compactionEvents.map((event) => event.type)).toEqual(["context.compaction.failed"])
  })

  it("recounts packed context before returning and activating it", async () => {
    const countedMessages: unknown[] = []
    const provider = structuredProvider({
      counts: [10, 4],
      outputs: [validChat()],
      onCount: (request) => countedMessages.push(request.messages),
    })

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: threeTurnMessages(),
      compression: {
        enabled: true,
        thresholds: { triggerTokens: 10, recentTailTargetTokens: 1 },
      },
    })

    expect(countedMessages).toHaveLength(2)
    expect(JSON.stringify(countedMessages[1])).toContain("socrates_internal_context_compaction")
    expect(prepared.estimatedTokens).toBe(4)
    expect(prepared.tokenCount.inputTokens).toBe(4)
  })

  it("preserves the full chat compaction surface, anchors, source handles, tail, and active tool state", async () => {
    const fullSummary = validChat({
      goal: "Continue the full compressor regression test.",
      constraints: ["Preserve active context as raw model-visible messages."],
      done: ["Created the compressor regression fixture."],
      inProgress: ["Running the focused context compressor verification."],
      blocked: ["No blocker in the compressed head."],
      decisions: ["Use a single test to cover fields, anchors, handles, and active tool state."],
      nextSteps: ["Run the focused Vitest file."],
      criticalContext: ["The active turn contains tool results that must not be lost."],
      relevantFiles: ["packages/core/src/context/contextCompression.ts: compaction selection and packing."],
      toolState: [
        "Older active-turn tool result digest captured.",
        "Exact historical command: pnpm --filter @socrates/core test failed in packages/core/src/test/contextCompression.test.ts",
      ],
      anchors: [
        "Turn 1: inspect the durable user objective.",
        "Turn 2: inspect the exact failed command and relevant file path.",
      ],
    })
    const provider = structuredProvider({ counts: [170_000, 65_000], outputs: [fullSummary] })
    const started: StartCompactionSnapshotInput[] = []
    const completed: CompleteCompactionSnapshotInput[] = []
    const messages = [
      {
        role: "user" as const,
        content: "HEAD_OBJECTIVE_SENTINEL: user wants the compressor to preserve anchors and all fields.",
        id: "msg_head_1u",
        turnId: "turn_head_1",
      },
      {
        role: "assistant" as const,
        content: "HEAD_REPLY_SENTINEL: acknowledged the compressor objective.",
        id: "msg_head_1a",
        turnId: "turn_head_1",
      },
      {
        role: "user" as const,
        content: "HEAD_FAILURE_SENTINEL: pnpm --filter @socrates/core test failed in packages/core/src/test/contextCompression.test.ts. " + "x".repeat(5000),
        id: "msg_head_2u",
        turnId: "turn_head_2",
      },
      {
        role: "assistant" as const,
        content: "HEAD_FILE_SENTINEL: inspected packages/core/src/context/contextCompression.ts before patching.",
        id: "msg_head_2a",
        turnId: "turn_head_2",
      },
      {
        role: "user" as const,
        content: "TAIL_RAW_SENTINEL: this recent completed turn must stay raw.",
        id: "msg_tail_3u",
        turnId: "turn_tail_3",
      },
      {
        role: "assistant" as const,
        content: "TAIL_ASSISTANT_SENTINEL: recent assistant answer stays raw too.",
        id: "msg_tail_3a",
        turnId: "turn_tail_3",
      },
      {
        role: "user" as const,
        content: "ACTIVE_CONTEXT_SENTINEL: current request should remain raw outside the compressor summary.",
        id: "msg_active_4u",
        turnId: "turn_active_4",
      },
      {
        role: "assistant" as const,
        id: "msg_active_4a",
        turnId: "turn_active_4",
        content: Array.from({ length: 7 }, (_, index) => {
          const number = index + 1
          return [
            {
              type: "tool-call" as const,
              toolCallId: `active_tool_${number}`,
              toolName: "read",
              input: { path: `workspace/old${number}.md` },
            },
            {
              type: "tool-result" as const,
              toolCallId: `active_tool_${number}`,
              toolName: "read",
              output: {
                path: `workspace/old${number}.md`,
                content: `${"x".repeat(700)} ACTIVE_TOOL_OMIT_SENTINEL_${number} ACTIVE_TOOL_RAW_SENTINEL_${number}`,
              },
            },
          ]
        }).flat(),
      },
    ]

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages,
      compression: {
        enabled: true,
        thresholds: {
          triggerTokens: 170_000,
          recentTailTargetTokens: 500,
          currentTurnToolTailTargetTokens: 1,
          currentTurnToolResultFloor: 5,
        },
        startSnapshot: (input) => {
          started.push(input)
        },
        completeSnapshot: (input) => {
          completed.push(input)
        },
      },
    })

    const compressorInput = String(provider.structuredRequests[0]?.messages[0]?.content)
    expect(compressorInput).toContain("# Old Head Turns To Compress")
    expect(compressorInput).toContain("HEAD_OBJECTIVE_SENTINEL")
    expect(compressorInput).toContain("HEAD_FAILURE_SENTINEL")
    expect(compressorInput).not.toContain("TAIL_RAW_SENTINEL")
    expect(compressorInput).not.toContain("ACTIVE_CONTEXT_SENTINEL")
    expect(compressorInput).toContain("# Current Turn Tool Digest")
    expect(compressorInput).toContain("older tool result read")
    expect(compressorInput).toContain("workspace/old1.md")
    expect(compressorInput).toContain("ACTIVE_TOOL_OMIT_SENTINEL_1")

    expect(started[0]?.sourceMessageIds).toEqual(["msg_head_1u", "msg_head_1a", "msg_head_2u", "msg_head_2a"])
    expect(started[0]?.sourceTurnIds).toEqual(["turn_head_1", "turn_head_2"])
    expect(completed[0]?.summary).toEqual(fullSummary)
    expect(Object.keys(completed[0]?.summary ?? {}).sort()).toEqual([
      "anchors",
      "blocked",
      "constraints",
      "criticalContext",
      "decisions",
      "done",
      "goal",
      "inProgress",
      "nextSteps",
      "relevantFiles",
      "schemaVersion",
      "toolState",
    ].sort())
    for (const header of ["# Goal", "# Constraints", "# Done", "# In Progress", "# Blocked", "# Decisions", "# Next Steps", "# Critical Context", "# Relevant Files", "# Tool State", "# Anchors"]) {
      expect(completed[0]?.renderedSummary).toContain(header)
    }
    expect(completed[0]?.sourceHandles).toEqual([
      { turnNo: 1, turnId: "turn_head_1", retrieve: "trace_retrieve({ turnNo: 1 })" },
      { turnNo: 2, turnId: "turn_head_2", retrieve: "trace_retrieve({ turnNo: 2 })" },
      { anchor: "Turn 1: inspect the durable user objective.", turnNo: 1, turnId: "turn_head_1" },
      { anchor: "Turn 2: inspect the exact failed command and relevant file path.", turnNo: 2, turnId: "turn_head_2" },
    ])

    const packed = JSON.stringify(prepared.messages)
    expect(packed).toContain("socrates_internal_context_compaction")
    expect(packed).toContain("TAIL_RAW_SENTINEL")
    expect(packed).toContain("ACTIVE_CONTEXT_SENTINEL")
    expect(packed).toContain("contextCompacted")
    expect(packed).toContain("ACTIVE_TOOL_RAW_SENTINEL_7")
    expect(packed).toContain("ACTIVE_TOOL_RAW_SENTINEL_3")
    expect(packed).not.toContain("ACTIVE_TOOL_OMIT_SENTINEL_1")
    expect(prepared.compactionEvents.map((event) => event.type)).toEqual(["context.compaction.started", "context.compaction.completed"])
  }, SLOW_COMPRESSION_TEST_TIMEOUT_MS)

  it("keeps the latest five tool results and compacts older current-turn tool results", async () => {
    const provider = structuredProvider({ counts: [170_000, 80_000], outputs: [validChat({ toolState: ["Older tool digest captured."], anchors: [] })] })
    const messages = [
      {
        role: "user" as const,
        content: "First active turn needs lots of tools.",
        id: "msg_user",
        turnId: "turn_1",
      },
      {
        role: "assistant" as const,
        id: "msg_assistant",
        turnId: "turn_1",
        content: Array.from({ length: 7 }, (_, index) => [
          { type: "tool-call" as const, toolCallId: `tool_${index + 1}`, toolName: "read", input: { path: `src/file${index + 1}.ts` } },
          {
            type: "tool-result" as const,
            toolCallId: `tool_${index + 1}`,
            toolName: "read",
            output: { path: `src/file${index + 1}.ts`, content: `result ${index + 1} ${"x".repeat(1200)}` },
          },
        ]).flat(),
      },
    ]

    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages,
      compression: {
        enabled: true,
        thresholds: {
          triggerTokens: 170_000,
          currentTurnToolTailTargetTokens: 1,
          currentTurnToolResultFloor: 5,
        },
      },
    })

    const packed = JSON.stringify(prepared.messages)
    expect(packed).toContain("tool_7")
    expect(packed).toContain("result 7")
    expect(packed).toContain("tool_3")
    expect(packed).toContain("result 3")
    expect(packed).toContain("tool_1")
    expect(packed).toContain("contextCompacted")
    expect(packed).not.toContain("result 1 " + "x".repeat(900))
    expect(String(provider.structuredRequests[0]?.messages[0]?.content)).toContain("older tool result read")
  })

  it("precomputes at the same 170k trigger", async () => {
    const provider = structuredProvider({ counts: [170_000, 70_000], outputs: [validChat()] })
    const completed: string[] = []

    const events = await precomputeContextSnapshot({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: threeTurnMessages(),
      compression: {
        enabled: true,
        thresholds: { recentTailTargetTokens: 1 },
        completeSnapshot: (input) => {
          completed.push(input.snapshotId)
        },
      },
    })

    expect(events.map((event) => event.type)).toEqual(["context.compaction.started", "context.compaction.completed"])
    expect(events[0]).toMatchObject({ reason: "precompute", targetTokens: 120_000 })
    expect(completed).toEqual([expect.stringMatching(/^ctxcmp_/)])
  })

  it("omits image bytes from compressor input while keeping image metadata", () => {
    const content = buildCompressorUserMessageContent({
      messages: [
        { role: "user", id: "msg_old", turnId: "turn_1", content: "old head" },
        {
          role: "user",
          id: "msg_image",
          turnId: "turn_2",
          content: [
            { type: "text", text: "What do you see?" },
            { type: "image", mediaType: "image/png", fileName: "screenshot.png", data: "a".repeat(1_000_000) },
          ],
        },
        { role: "user", id: "msg_active", turnId: "turn_3", content: "active" },
      ],
      thresholds: { recentTailTargetTokens: 1 },
    })

    expect(content).toContain("screenshot.png")
    expect(content).toContain("image:")
    expect(content).not.toContain("a".repeat(500))
  })

  it("applies an active snapshot without re-sending already compacted raw turns", async () => {
    const provider = structuredProvider({ counts: [50] })
    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: threeTurnMessages(),
      compression: {
        enabled: true,
        thresholds: { triggerTokens: 1_000 },
        getLatestSnapshot: () => ({
          snapshotId: "ctxcmp_existing",
          summary: validChat({ goal: "EXISTING_SUMMARY_SENTINEL" }),
          renderedSummary: "# Goal\nEXISTING_SUMMARY_SENTINEL",
          sourceHandles: [{ turnNo: 1, turnId: "turn_1" }],
          outputTokensEstimate: 20,
        }),
      },
    })

    const packed = JSON.stringify(prepared.messages)
    expect(packed).toContain("EXISTING_SUMMARY_SENTINEL")
    expect(packed).not.toContain("old user")
    expect(packed).toContain("middle user")
    expect(packed).toContain("current user")
    expect(provider.structuredRequests).toHaveLength(0)
  })

  it("rejects anchors whose turns are absent from compressor input", async () => {
    const provider = structuredProvider({
      counts: [170_000],
      outputs: [validChat({ anchors: ["Turn 99: invented anchor."] }), validChat({ anchors: ["Turn 99: still invented."] })],
    })
    const prepared = await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: threeTurnMessages(),
      compression: { enabled: true, thresholds: { recentTailTargetTokens: 1 } },
    })

    expect(prepared.compactionEvents[0]).toMatchObject({
      type: "context.compaction.failed",
      error: { code: "compressor_anchor_turn_not_in_input" },
    })
  })

  it("deterministically carries exact source attachment paths when the model omits them", async () => {
    const provider = structuredProvider({ counts: [170_000, 60_000], outputs: [validChat({ relevantFiles: [] })] })
    const completed: ContextCompactionSummary[] = []
    const attachmentPath = ".socrates/attachments/pasted-text-eval.txt"
    const exactCommand = "pnpm --filter @socrates/core test -- contextCompression.test.ts"
    const unresolvedInstruction = "The unresolved task is to prove exact trace recovery. Do not mark it completed until the original evidence is retrieved."

    await prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: [
        { role: "user", content: `Read ${attachmentPath} before answering. The failing command is ${exactCommand} and the file is packages/core/src/context/contextCompression.ts. ${unresolvedInstruction}`, id: "msg_1u", turnId: "turn_1" },
        { role: "assistant", content: "I will inspect the source attachment.", id: "msg_1a", turnId: "turn_1" },
        { role: "user", content: "current user", id: "msg_2u", turnId: "turn_2" },
      ],
      compression: {
        enabled: true,
        thresholds: { recentTailTargetTokens: 1 },
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

    expect(completed[0]?.summary).toMatchObject({
      relevantFiles: [expect.stringContaining(attachmentPath)],
    })
    expect(completed[0]?.renderedSummary).toContain(attachmentPath)
    expect(completed[0]?.summary).toMatchObject({ toolState: [expect.stringContaining(exactCommand)] })
    expect(completed[0]?.renderedSummary).toContain(exactCommand)
    expect(completed[0]?.summary).toMatchObject({ blocked: [expect.stringContaining(unresolvedInstruction)] })
    expect(completed[0]?.renderedSummary).toContain(unresolvedInstruction)
  })

  it("refuses provider context above the hard limit when compaction is disabled", async () => {
    const provider = structuredProvider({ counts: [180_001] })
    await expect(prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: threeTurnMessages(),
      compression: { enabled: false },
    })).rejects.toMatchObject({ code: "context_hard_limit_exceeded" })
  })

  it("rejects a compaction that remains above the 120k target", async () => {
    const provider = structuredProvider({ counts: [170_000, 130_000], outputs: [validChat()] })
    await expect(prepareContextForModelCall({
      provider,
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig,
      system: "system",
      messages: threeTurnMessages(),
      compression: { enabled: true, thresholds: { recentTailTargetTokens: 1 } },
    })).rejects.toMatchObject({ code: "context_compaction_target_not_met" })
  })
})

type StructuredTestProvider = ModelProvider & {
  structuredRequests: StructuredModelRequest<unknown>[]
  onStream?: () => void
}

const structuredProvider = (options: {
  counts: number[]
  outputs?: unknown[]
  onCount?: (request: ModelRequest) => void
}): StructuredTestProvider => {
  let countIndex = 0
  let outputIndex = 0
  const provider: StructuredTestProvider = {
    structuredRequests: [],
    countTokens: async (request) => {
      options.onCount?.(request)
      const inputTokens = options.counts[Math.min(countIndex, options.counts.length - 1)] ?? 0
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
    async generateStructured<TOutput>(request: StructuredModelRequest<TOutput>): Promise<StructuredModelResult<TOutput>> {
      provider.structuredRequests.push(request as StructuredModelRequest<unknown>)
      const output = options.outputs?.[outputIndex] ?? validChat()
      outputIndex += 1
      return { output: output as TOutput, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }
    },
    async *stream() {
      provider.onStream?.()
      yield { type: "model.failed" as const, error: new Error("stream should not be used by compressor") }
    },
  }
  return provider
}

const validChat = (overrides: Partial<ChatCompaction> = {}): ChatCompaction => ({
  schemaVersion: 1,
  goal: "Continue Socrates compression refactor.",
  constraints: [],
  done: ["Old work compressed."],
  inProgress: [],
  blocked: [],
  decisions: [],
  nextSteps: ["Continue implementation."],
  criticalContext: [],
  relevantFiles: [],
  toolState: [],
  anchors: ["Turn 1: inspect the original user request."],
  ...overrides,
})

const validMemory = (overrides: Partial<MemoryCompaction> = {}): MemoryCompaction => ({
  schemaVersion: 1,
  goal: "Continue memory-agent compaction.",
  manifestScope: ["Covered old memory-agent evidence."],
  investigated: ["Old memory-agent evidence compressed."],
  changed: [],
  skipped: [],
  blocked: [],
  decisions: [],
  nextSteps: ["Continue the memory-agent run."],
  criticalContext: [],
  toolState: [],
  anchors: ["Turn 1: inspect the original memory-agent evidence."],
  ...overrides,
})

const threeTurnMessages = () => [
  { role: "user" as const, content: "old user", id: "msg_1u", turnId: "turn_1" },
  { role: "assistant" as const, content: "old assistant", id: "msg_1a", turnId: "turn_1" },
  { role: "user" as const, content: "middle user", id: "msg_2u", turnId: "turn_2" },
  { role: "assistant" as const, content: "middle assistant", id: "msg_2a", turnId: "turn_2" },
  { role: "user" as const, content: "current user", id: "msg_3u", turnId: "turn_3" },
]

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1
