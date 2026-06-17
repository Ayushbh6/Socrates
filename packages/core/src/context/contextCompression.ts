import { chatCompactionSchema, memoryCompactionSchema, type ChatCompaction, type MemoryCompaction } from "@socrates/contracts"
import { estimateTextTokens, type ModelMessage, type ModelMessagePart, type ModelProvider, type ModelUsage, type TokenCountResult } from "@socrates/providers"
import type { ModelToolDefinition, ProviderId, RuntimeConfig } from "@socrates/contracts"
import { createId, SocratesError } from "@socrates/shared"
import { CompressorAgent } from "../agent/CompressorAgent"
import {
  SOCRATES_COMPRESSOR_SYSTEM_PROMPT,
  buildSocratesCompressorUserContent,
  renderChatCompactionMarkdown,
  type CompressorTurnInput,
} from "../prompts/socratesCompressorPrompt"
import {
  MEMORY_AGENT_COMPRESSOR_SYSTEM_PROMPT,
  buildMemoryAgentCompressorUserContent,
  renderMemoryCompactionMarkdown,
} from "../prompts/memoryAgentCompressorPrompt"

export type ContextCompressionMode = "chat" | "memory"

export const DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS = {
  triggerTokens: 170_000,
  recentTailTargetTokens: 50_000,
  currentTurnToolTailTargetTokens: 50_000,
  currentTurnToolResultFloor: 5,
} as const

export type ContextCompressionThresholds = {
  triggerTokens: number
  recentTailTargetTokens: number
  currentTurnToolTailTargetTokens: number
  currentTurnToolResultFloor: number
}

export const DEFAULT_COMPRESSOR_MODEL = {
  providerId: "openrouter" as ProviderId,
  modelId: "deepseek/deepseek-v4-flash",
} as const

export const DEFAULT_COMPRESSOR_FALLBACK_MODEL = {
  providerId: "openrouter" as ProviderId,
  modelId: "xiaomi/mimo-v2.5-pro",
} as const

export const DEFAULT_COMPRESSOR_SECOND_FALLBACK_MODEL = {
  providerId: "openrouter" as ProviderId,
  modelId: "z-ai/glm-5.1",
} as const

export type ContextCompressionReason = "precompute" | "threshold" | "emergency" | "manual"

export type ContextCompactionSummary = {
  snapshotId: string
  previousSnapshotId?: string
  summary: ChatCompaction | MemoryCompaction
  renderedSummary: string
  sourceHandles: Array<Record<string, unknown>>
  outputTokensEstimate: number
}

export type ContextCompactionStartedEvent = {
  type: "context.compaction.started"
  snapshotId: string
  reason: ContextCompressionReason
  contextUsedTokensEstimate: number
  targetTokens: number
}

export type ContextCompactionCompletedEvent = {
  type: "context.compaction.completed"
  snapshotId: string
  inputTokensEstimate: number
  outputTokensEstimate: number
  contextUsedTokensEstimate: number
}

export type ContextCompactionFailedEvent = {
  type: "context.compaction.failed"
  snapshotId?: string
  error: SocratesError
}

export type ContextCompactionLifecycleEvent =
  | ContextCompactionStartedEvent
  | ContextCompactionCompletedEvent
  | ContextCompactionFailedEvent

export type StartCompactionSnapshotInput = {
  snapshotId: string
  reason: ContextCompressionReason
  contextTokensEstimate: number
  targetTokens: number
  compressorProviderId: ProviderId
  compressorModelId: string
  sourceMessageIds: string[]
  sourceTurnIds: string[]
  previousSnapshotId?: string
}

export type CompleteCompactionSnapshotInput = {
  snapshotId: string
  summary: ChatCompaction | MemoryCompaction
  renderedSummary: string
  sourceHandles: Array<Record<string, unknown>>
  inputTokensEstimate: number
  outputTokensEstimate: number
  contextTokensAfter: number
  usage?: ModelUsage
  compressorProviderId?: ProviderId
  compressorModelId?: string
}

export type FailCompactionSnapshotInput = {
  snapshotId: string
  code: string
  message: string
  details?: unknown
}

export type ContextCompressionRuntime = {
  enabled: boolean
  mode?: ContextCompressionMode
  thresholds?: Partial<ContextCompressionThresholds>
  compressorProviderId?: ProviderId
  compressorModelId?: string
  compressorFallbackProviderId?: ProviderId
  compressorFallbackModelId?: string
  getLatestSnapshot?: () => Promise<ContextCompactionSummary | undefined> | ContextCompactionSummary | undefined
  startSnapshot?: (input: StartCompactionSnapshotInput) => Promise<void> | void
  completeSnapshot?: (input: CompleteCompactionSnapshotInput) => Promise<void> | void
  failSnapshot?: (input: FailCompactionSnapshotInput) => Promise<void> | void
}

export type PrepareContextInput = {
  provider: ModelProvider
  providerId: ProviderId
  modelId: string
  runtimeConfig: RuntimeConfig
  system: string
  messages: ModelMessage[]
  tools?: ModelToolDefinition[]
  compression?: ContextCompressionRuntime
  onCompactionStarted?: (event: ContextCompactionStartedEvent) => Promise<void> | void
}

export type PreparedContext = {
  system: string
  messages: ModelMessage[]
  estimatedTokens: number
  tokenCount: TokenCountResult
  compactionEvents: ContextCompactionLifecycleEvent[]
}

export const prepareContextForModelCall = async (input: PrepareContextInput): Promise<PreparedContext> => {
  const thresholds = { ...DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS, ...input.compression?.thresholds }
  const initialTokenCount = await countPreparedContext(input, thresholds)
  const initialTokens = initialTokenCount.inputTokens

  if (!input.compression?.enabled || initialTokens < thresholds.triggerTokens) {
    return {
      system: input.system,
      messages: input.messages,
      estimatedTokens: initialTokens,
      tokenCount: initialTokenCount,
      compactionEvents: [],
    }
  }

  let startedEmitted = false
  const result = await runContextCompaction(input, thresholds, initialTokens, "threshold", async (event) => {
    if (!input.onCompactionStarted) {
      return
    }
    startedEmitted = true
    await input.onCompactionStarted(event)
  })
  if (!result.ok) {
    return {
      system: input.system,
      messages: input.messages,
      estimatedTokens: initialTokens,
      tokenCount: initialTokenCount,
      compactionEvents: [result.failed],
    }
  }

  const finalTokenCount = await countPreparedContext({ ...input, messages: result.messages }, thresholds)
  const finalTokens = finalTokenCount.inputTokens
  if (finalTokens >= initialTokens) {
    const error = new SocratesError("context_compaction_not_reduced", "Compacted context was not smaller than the original context.", {
      details: { initialTokens, finalTokens },
      recoverable: true,
    })
    await input.compression.failSnapshot?.({
      snapshotId: result.snapshotId,
      code: error.code,
      message: error.message,
      details: error.details,
    })
    return {
      system: input.system,
      messages: input.messages,
      estimatedTokens: initialTokens,
      tokenCount: initialTokenCount,
      compactionEvents: [{ type: "context.compaction.failed", snapshotId: result.snapshotId, error }],
    }
  }

  await input.compression.completeSnapshot?.({
    snapshotId: result.snapshotId,
    summary: result.summary,
    renderedSummary: result.renderedSummary,
    sourceHandles: result.sourceHandles,
    inputTokensEstimate: initialTokens,
    outputTokensEstimate: result.outputTokensEstimate,
    contextTokensAfter: finalTokens,
    ...(result.usage ? { usage: result.usage } : {}),
    compressorProviderId: result.compressorProviderId,
    compressorModelId: result.compressorModelId,
  })

  return {
    system: input.system,
    messages: result.messages,
    estimatedTokens: finalTokens,
    tokenCount: finalTokenCount,
    compactionEvents: [
      ...(startedEmitted ? [] : [result.started]),
      {
        type: "context.compaction.completed",
        snapshotId: result.snapshotId,
        inputTokensEstimate: initialTokens,
        outputTokensEstimate: result.outputTokensEstimate,
        contextUsedTokensEstimate: finalTokens,
      },
    ],
  }
}

export const precomputeContextSnapshot = async (input: PrepareContextInput): Promise<ContextCompactionLifecycleEvent[]> => {
  const thresholds = { ...DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS, ...input.compression?.thresholds }
  const initialTokens = (await countPreparedContext(input, thresholds)).inputTokens
  if (!input.compression?.enabled || initialTokens < thresholds.triggerTokens) {
    return []
  }

  const result = await runContextCompaction(input, thresholds, initialTokens, "precompute")
  if (!result.ok) {
    return [result.failed]
  }

  const projectedTokenCount = await countPreparedContext({ ...input, messages: result.messages }, thresholds)
  const projectedTokens = projectedTokenCount.inputTokens
  if (projectedTokens >= initialTokens) {
    const error = new SocratesError("context_compaction_not_reduced", "Precomputed compaction was not smaller than the original context.", {
      details: { initialTokens, projectedTokens },
      recoverable: true,
    })
    await input.compression.failSnapshot?.({
      snapshotId: result.snapshotId,
      code: error.code,
      message: error.message,
      details: error.details,
    })
    return [{ type: "context.compaction.failed", snapshotId: result.snapshotId, error }]
  }

  await input.compression.completeSnapshot?.({
    snapshotId: result.snapshotId,
    summary: result.summary,
    renderedSummary: result.renderedSummary,
    sourceHandles: result.sourceHandles,
    inputTokensEstimate: initialTokens,
    outputTokensEstimate: result.outputTokensEstimate,
    contextTokensAfter: projectedTokens,
    ...(result.usage ? { usage: result.usage } : {}),
    compressorProviderId: result.compressorProviderId,
    compressorModelId: result.compressorModelId,
  })

  return [
    result.started,
    {
      type: "context.compaction.completed",
      snapshotId: result.snapshotId,
      inputTokensEstimate: initialTokens,
      outputTokensEstimate: result.outputTokensEstimate,
      contextUsedTokensEstimate: projectedTokens,
    },
  ]
}

type ContextCompactionResult =
  | {
      ok: true
      snapshotId: string
      started: ContextCompactionStartedEvent
      messages: ModelMessage[]
      summary: ChatCompaction | MemoryCompaction
      renderedSummary: string
      sourceHandles: Array<Record<string, unknown>>
      outputTokensEstimate: number
      usage?: ModelUsage
      compressorProviderId: ProviderId
      compressorModelId: string
    }
  | {
      ok: false
      failed: ContextCompactionFailedEvent
    }

type CompactionSelection = {
  headTurns: CompressorTurnInput[]
  tailTurns: CompressorTurnInput[]
  activeTurns: CompressorTurnInput[]
}

const runContextCompaction = async (
  input: PrepareContextInput,
  thresholds: ContextCompressionThresholds,
  initialTokens: number,
  reason: ContextCompressionReason,
  onStarted?: (event: ContextCompactionStartedEvent) => Promise<void> | void,
): Promise<ContextCompactionResult> => {
  const compression = input.compression as ContextCompressionRuntime
  const snapshotId = createId("ctxcmp")
  const compressorProviderId = compression.compressorProviderId ?? DEFAULT_COMPRESSOR_MODEL.providerId
  const compressorModelId = compression.compressorModelId ?? DEFAULT_COMPRESSOR_MODEL.modelId
  const compressorFallbackProviderId = compression.compressorFallbackProviderId ?? DEFAULT_COMPRESSOR_FALLBACK_MODEL.providerId
  const compressorFallbackModelId = compression.compressorFallbackModelId ?? DEFAULT_COMPRESSOR_FALLBACK_MODEL.modelId
  const mode = compression.mode ?? "chat"
  const latestSnapshot = validLatestSnapshot(await compression.getLatestSnapshot?.(), mode)
  const selection = selectCompactionWindow(input.messages, thresholds, mode)
  const keptRawMessages = [...selection.tailTurns, ...selection.activeTurns].flatMap((turn) => turn.messages)
  const toolPlan = buildToolCompactionPlan(keptRawMessages, thresholds)
  const sourceMessageIds = unique(selection.headTurns.flatMap((turn) => turn.messages.map((message) => message.id).filter(isString)))
  const sourceTurnIds = unique(selection.headTurns.map((turn) => turn.turnId).filter(isString))
  const started: ContextCompactionStartedEvent = {
    type: "context.compaction.started",
    snapshotId,
    reason,
    contextUsedTokensEstimate: initialTokens,
    targetTokens: thresholds.triggerTokens,
  }

  await compression.startSnapshot?.({
    snapshotId,
    reason,
    contextTokensEstimate: initialTokens,
    targetTokens: thresholds.triggerTokens,
    compressorProviderId,
    compressorModelId,
    sourceMessageIds,
    sourceTurnIds,
    ...(latestSnapshot?.snapshotId ? { previousSnapshotId: latestSnapshot.snapshotId } : {}),
  })
  await onStarted?.(started)

  try {
    if (selection.headTurns.length === 0 && toolPlan.digests.length === 0) {
      throw new SocratesError("context_compaction_no_safe_head", "Context is over the trigger but has no completed head turns or old tool results to compact safely.", {
        recoverable: true,
      })
    }

    const compressor = new CompressorAgent()
    const compressorResult = await compressor.run({
      provider: input.provider,
      mode,
      primary: { providerId: compressorProviderId, modelId: compressorModelId },
      fallbacks: [
        { providerId: compressorFallbackProviderId, modelId: compressorFallbackModelId },
        DEFAULT_COMPRESSOR_SECOND_FALLBACK_MODEL,
      ],
      system: compressorSystemPrompt(mode),
      userContent: compressorUserContent(mode, selection, latestSnapshot, toolPlan),
    })
    if (compressorResult.mode !== mode) {
      throw new SocratesError("context_compaction_wrong_mode", "Compressor returned the wrong output mode.", { recoverable: true })
    }

    const renderedSummary = renderCompactionMarkdown(compressorResult.output)
    return {
      ok: true,
      snapshotId,
      summary: compressorResult.output,
      renderedSummary,
      sourceHandles: buildSourceHandles(selection.headTurns, compressorResult.output),
      outputTokensEstimate: estimateTextTokens(renderedSummary, {
        providerId: compressorResult.providerId,
        modelId: compressorResult.modelId,
      }).inputTokens,
      messages: packMessagesWithCompaction(selection, renderedSummary, toolPlan, mode),
      started,
      compressorProviderId: compressorResult.providerId,
      compressorModelId: compressorResult.modelId,
      ...(compressorResult.usage ? { usage: compressorResult.usage } : {}),
    }
  } catch (error) {
    const normalized =
      error instanceof SocratesError
        ? error
        : new SocratesError("context_compaction_failed", error instanceof Error ? error.message : String(error), {
            recoverable: true,
          })
    await compression.failSnapshot?.({
      snapshotId,
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    })
    return {
      ok: false,
      failed: { type: "context.compaction.failed", snapshotId, error: normalized },
    }
  }
}

export const estimateModelContextTokens = async (
  provider: ModelProvider,
  input: Omit<PrepareContextInput, "provider" | "compression">,
  thresholds: Pick<ContextCompressionThresholds, "triggerTokens"> = DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS,
): Promise<TokenCountResult> =>
  provider.countTokens({
    providerId: input.providerId,
    modelId: input.modelId,
    system: input.system,
    messages: input.messages,
    runtimeConfig: input.runtimeConfig,
    ...(input.tools ? { tools: input.tools } : {}),
    countTokens: { exactThresholds: [thresholds.triggerTokens] },
  })

export const estimateTokens = (value: string): number => estimateTextTokens(value).inputTokens

const countPreparedContext = (
  input: PrepareContextInput,
  thresholds: Pick<ContextCompressionThresholds, "triggerTokens">,
): Promise<TokenCountResult> =>
  estimateModelContextTokens(
    input.provider,
    {
      providerId: input.providerId,
      modelId: input.modelId,
      runtimeConfig: input.runtimeConfig,
      system: input.system,
      messages: input.messages,
      ...(input.tools ? { tools: input.tools } : {}),
    },
    thresholds,
  )

const compressorSystemPrompt = (mode: ContextCompressionMode): string =>
  mode === "memory" ? MEMORY_AGENT_COMPRESSOR_SYSTEM_PROMPT : SOCRATES_COMPRESSOR_SYSTEM_PROMPT

const compressorUserContent = (
  mode: ContextCompressionMode,
  selection: CompactionSelection,
  latestSnapshot: ContextCompactionSummary | undefined,
  toolPlan: ToolCompactionPlan,
): string => {
  if (mode === "memory") {
    return buildMemoryAgentCompressorUserContent({
      ...(latestSnapshot?.renderedSummary ? { previousSummary: latestSnapshot.renderedSummary } : {}),
      manifestHead: buildMemoryAgentManifestHead(selection.headTurns, toolPlan.digests),
    })
  }
  return buildSocratesCompressorUserContent({
    headTurns: selection.headTurns,
    ...(latestSnapshot?.renderedSummary ? { previousSummary: latestSnapshot.renderedSummary } : {}),
    ...(toolPlan.digests.length > 0 ? { currentTurnDigest: toolPlan.digests } : {}),
  })
}

const renderCompactionMarkdown = (summary: ChatCompaction | MemoryCompaction): string =>
  "manifestScope" in summary ? renderMemoryCompactionMarkdown(summary) : renderChatCompactionMarkdown(summary)

const selectCompactionWindow = (messages: ModelMessage[], thresholds: ContextCompressionThresholds, mode: ContextCompressionMode = "chat"): CompactionSelection => {
  const turns = groupMessagesByTurn(messages)
  const activeTurns = turns.length > 0 ? [turns[turns.length - 1]!] : []
  const completedTurns = turns.slice(0, -1)
  const tailTurns: CompressorTurnInput[] = []
  let tailTokens = 0

  for (let index = completedTurns.length - 1; index >= 0; index -= 1) {
    const turn = completedTurns[index]!
    const turnTokens = estimateTurnTokens(turn)
    if (tailTokens + turnTokens > thresholds.recentTailTargetTokens) {
      break
    }
    tailTurns.unshift(turn)
    tailTokens += turnTokens
  }

  const selection = {
    headTurns: completedTurns.slice(0, completedTurns.length - tailTurns.length),
    tailTurns,
    activeTurns,
  }
  if (mode === "memory" && selection.headTurns.length === 0 && (selection.tailTurns.length > 0 || selection.activeTurns.length > 0)) {
    return {
      headTurns: [...selection.tailTurns, ...selection.activeTurns],
      tailTurns: [],
      activeTurns: [],
    }
  }
  return selection
}

const groupMessagesByTurn = (messages: ModelMessage[]): CompressorTurnInput[] => {
  const turns: CompressorTurnInput[] = []
  let currentKey: string | undefined
  for (const message of messages) {
    const key = message.turnId ?? `message:${message.id ?? turns.length}`
    if (!currentKey || key !== currentKey) {
      currentKey = key
      turns.push({
        turnNo: turns.length + 1,
        ...(message.turnId ? { turnId: message.turnId } : {}),
        messages: [],
      })
    }
    turns[turns.length - 1]!.messages.push(message)
  }
  return turns
}

const estimateTurnTokens = (turn: CompressorTurnInput): number => estimateTextTokens(JSON.stringify(turn.messages.map(messageForTokenEstimate))).inputTokens

const messageForTokenEstimate = (message: ModelMessage): ModelMessage => {
  if (typeof message.content === "string") {
    return message
  }
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "image"
        ? {
            ...part,
            data: `[image bytes omitted for token estimate; encodedLength=${part.data.length}]`,
          }
        : part,
    ),
  }
}

type ToolCompactionPlan = {
  keepToolCallIds: Set<string>
  digests: string[]
}

const buildToolCompactionPlan = (messages: ModelMessage[], thresholds: ContextCompressionThresholds): ToolCompactionPlan => {
  const toolResults = collectToolResults(messages)
  const keepToolCallIds = new Set<string>()
  let keptTokens = 0
  let keptCount = 0
  const sortedNewestFirst = [...toolResults].reverse()

  for (const result of sortedNewestFirst) {
    if (keptCount < thresholds.currentTurnToolResultFloor || keptTokens + result.tokens <= thresholds.currentTurnToolTailTargetTokens) {
      keepToolCallIds.add(result.toolCallId)
      keptTokens += result.tokens
      keptCount += 1
    }
  }

  return {
    keepToolCallIds,
    digests: toolResults
      .filter((result) => !keepToolCallIds.has(result.toolCallId))
      .map((result) => lightweightToolDigest(result)),
  }
}

const collectToolResults = (messages: ModelMessage[]) => {
  const inputs = new Map<string, unknown>()
  for (const message of messages) {
    if (typeof message.content === "string") {
      continue
    }
    for (const part of message.content) {
      if (part.type === "tool-call") {
        inputs.set(part.toolCallId, part.input)
      }
    }
  }

  const results: Array<{
    toolCallId: string
    toolName: string
    output: unknown
    input?: unknown
    tokens: number
  }> = []
  for (const message of messages) {
    if (typeof message.content === "string") {
      continue
    }
    for (const part of message.content) {
      if (part.type !== "tool-result") {
        continue
      }
      const serialized = safeStringify(part.output)
      results.push({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: part.output,
        ...(inputs.has(part.toolCallId) ? { input: inputs.get(part.toolCallId) } : {}),
        tokens: estimateTextTokens(serialized).inputTokens,
      })
    }
  }
  return results
}

const packMessagesWithCompaction = (
  selection: CompactionSelection,
  renderedSummary: string,
  toolPlan: ToolCompactionPlan,
  mode: ContextCompressionMode,
): ModelMessage[] => [
  {
    role: "developer",
    content: [
      mode === "memory" ? "<socrates_internal_memory_context_compaction>" : "<socrates_internal_context_compaction>",
      mode === "memory"
        ? "This is model-visible internal context for the Global Memory Agent, not transcript-visible user content."
        : "This is model-visible internal context, not transcript-visible user content.",
      renderedSummary,
      mode === "memory" ? "</socrates_internal_memory_context_compaction>" : "</socrates_internal_context_compaction>",
    ].join("\n"),
  },
  ...compactToolResults([...selection.tailTurns, ...selection.activeTurns].flatMap((turn) => turn.messages), toolPlan),
  ...(mode === "memory" && selection.tailTurns.length === 0 && selection.activeTurns.length === 0
    ? [
        {
          role: "user" as const,
          content:
            "Continue the Global Memory Agent run from the compacted memory-agent context above. Use tools only if exact evidence is still needed; otherwise produce the memory-agent run report.",
        },
      ]
    : []),
]

const compactToolResults = (messages: ModelMessage[], plan: ToolCompactionPlan): ModelMessage[] => {
  if (plan.digests.length === 0) {
    return messages
  }
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return message
    }
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-result" || plan.keepToolCallIds.has(part.toolCallId)) {
          return part
        }
        return {
          ...part,
          output: compactedToolOutput(part),
        }
      }),
    }
  })
}

const compactedToolOutput = (part: Extract<ModelMessagePart, { type: "tool-result" }>) => {
  const serialized = safeStringify(part.output)
  return {
    contextCompacted: true,
    toolName: part.toolName,
    progress: truncateWithNotice(serialized, 600, `older ${part.toolName} tool result`),
    paths: pathLikeStrings(serialized).slice(0, 12),
    error: errorLikeText(part.output),
    retrievalHint: `Use trace_retrieve audit search with tool name "${part.toolName}" plus any path, command, or error text from this progress note.`,
  }
}

const lightweightToolDigest = (result: { toolName: string; toolCallId: string; output: unknown; input?: unknown }): string => {
  const output = safeStringify(result.output)
  const input = result.input === undefined ? "" : ` input=${truncateWithNotice(safeStringify(result.input), 600, "tool input")}`
  const paths = pathLikeStrings(output).slice(0, 5)
  const error = errorLikeText(result.output)
  return [
    `older tool result ${result.toolName};${input}`,
    paths.length > 0 ? ` paths=${paths.join(", ")}` : undefined,
    error ? ` error=${truncateWithNotice(error, 400, "tool error")}` : undefined,
    ` progress=${truncateWithNotice(output, 1_000, "tool output")}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("")
}

const buildMemoryAgentManifestHead = (headTurns: CompressorTurnInput[], toolDigests: string[]): string => {
  const sections = [
    headTurns.length > 0 ? headTurns.map(renderMemoryAgentManifestTurn).join("\n\n") : "None.",
  ]
  if (toolDigests.length > 0) {
    sections.push("", "# Older Memory-Agent Tool Result Digest", toolDigests.map((line) => `- ${line}`).join("\n"))
  }
  return sections.join("\n")
}

const renderMemoryAgentManifestTurn = (turn: CompressorTurnInput): string =>
  [
    `## Turn ${turn.turnNo}`,
    turn.turnId ? `turnId: ${turn.turnId}` : undefined,
    ...turn.messages.map((message) => renderMemoryAgentManifestMessage(message)),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n")

const renderMemoryAgentManifestMessage = (message: ModelMessage): string =>
  [
    `### ${message.role}${message.id ? ` messageId=${message.id}` : ""}`,
    typeof message.content === "string" ? message.content : message.content.map(renderMemoryAgentManifestPart).join("\n"),
  ].join("\n")

const renderMemoryAgentManifestPart = (part: ModelMessagePart): string => {
  if (part.type === "text" || part.type === "reasoning") {
    return part.text
  }
  if (part.type === "image") {
    return `[image: ${part.fileName ?? "unnamed"} ${part.mediaType}; bytes omitted]`
  }
  if (part.type === "tool-call") {
    return `[tool-call ${part.toolName} ${part.toolCallId}] input=${truncateWithNotice(safeStringify(part.input), 4_000, "tool input")}`
  }
  return `[tool-result ${part.toolName} ${part.toolCallId}] output=${truncateWithNotice(safeStringify(part.output), 12_000, "tool output")}`
}

const buildSourceHandles = (headTurns: CompressorTurnInput[], summary: ChatCompaction | MemoryCompaction): Array<Record<string, unknown>> => {
  const handles = headTurns.map((turn) => ({
    turnNo: turn.turnNo,
    ...(turn.turnId ? { turnId: turn.turnId } : {}),
    retrieve: `trace_retrieve({ turnNo: ${turn.turnNo} })`,
  }))
  return [...handles, ...summary.anchors.map((anchor) => ({ anchor }))]
}

const validLatestSnapshot = (snapshot: ContextCompactionSummary | undefined, mode: ContextCompressionMode): ContextCompactionSummary | undefined => {
  if (!snapshot) {
    return undefined
  }
  const parsed = (mode === "memory" ? memoryCompactionSchema : chatCompactionSchema).safeParse(snapshot.summary)
  if (!parsed.success) {
    return undefined
  }
  return { ...snapshot, summary: parsed.data }
}

const safeStringify = (value: unknown): string => {
  try {
    return typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const truncateWithNotice = (value: string, maxChars: number, label: string): string => {
  if (value.length <= maxChars) {
    return value
  }
  return `${value.slice(0, maxChars)}\n[Compacted: ${label} exceeded ${maxChars} chars; inspect exact source through trace_retrieve.]`
}

const pathLikeStrings = (text: string): string[] => {
  const matches = text.match(/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/g) ?? []
  return unique(matches)
}

const errorLikeText = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") {
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const key of ["error", "stderr", "message"]) {
    const candidate = record[key]
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate
    }
  }
  return undefined
}

export const COMPRESSOR_SYSTEM_PROMPT = SOCRATES_COMPRESSOR_SYSTEM_PROMPT

export const buildCompressorUserMessageContent = (input: {
  latestSnapshot?: ContextCompactionSummary
  messages: ModelMessage[]
  thresholds?: Partial<ContextCompressionThresholds>
}): string => {
  const thresholds = { ...DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS, ...input.thresholds }
  const selection = selectCompactionWindow(input.messages, thresholds)
  return buildSocratesCompressorUserContent({
    headTurns: selection.headTurns,
    ...(input.latestSnapshot?.renderedSummary ? { previousSummary: input.latestSnapshot.renderedSummary } : {}),
  })
}

const unique = <T>(items: T[]): T[] => Array.from(new Set(items))
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0
