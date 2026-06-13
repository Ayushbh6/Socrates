import type { MemoryAgentSignalSnapshot } from "@socrates/contracts"

export const MEMORY_AGENT_SIGNAL_THRESHOLDS = {
  fileChangeEvents: 5,
  distinctChangedFiles: 5,
  toolCalls: 10,
  totalTokens: 5_000,
  turnCount: 4,
} as const

export type MemoryAgentSignalInput = {
  sequenceFrom?: number
  sequenceTo: number
  turnCount: number
  toolCalls: number
  fileChangeEvents: number
  distinctChangedFiles: number
  totalTokens: number
}

export const emptyMemoryAgentSignal = (lastProcessedEventSequence: number): MemoryAgentSignalSnapshot => ({
  sequenceTo: lastProcessedEventSequence,
  turnCount: 0,
  toolCalls: 0,
  fileChangeEvents: 0,
  distinctChangedFiles: 0,
  totalTokens: 0,
  shouldRun: false,
  reasons: [],
  displayReason: "No new completed turns since the memory watermark.",
})

export const scoreMemoryAgentSignal = (input: MemoryAgentSignalInput): MemoryAgentSignalSnapshot => {
  const reasons: string[] = []
  if (input.fileChangeEvents >= MEMORY_AGENT_SIGNAL_THRESHOLDS.fileChangeEvents) {
    reasons.push(`${input.fileChangeEvents} file change events`)
  }
  if (input.distinctChangedFiles >= MEMORY_AGENT_SIGNAL_THRESHOLDS.distinctChangedFiles) {
    reasons.push(`${input.distinctChangedFiles} distinct changed files`)
  }
  if (input.toolCalls >= MEMORY_AGENT_SIGNAL_THRESHOLDS.toolCalls) {
    reasons.push(`${input.toolCalls} tool calls`)
  }
  if (input.totalTokens >= MEMORY_AGENT_SIGNAL_THRESHOLDS.totalTokens) {
    reasons.push(`${input.totalTokens} tokens`)
  }
  if (input.turnCount >= MEMORY_AGENT_SIGNAL_THRESHOLDS.turnCount) {
    reasons.push(`${input.turnCount} completed turns`)
  }

  const shouldRun = reasons.length > 0
  return {
    ...(input.sequenceFrom === undefined ? {} : { sequenceFrom: input.sequenceFrom }),
    sequenceTo: input.sequenceTo,
    turnCount: input.turnCount,
    toolCalls: input.toolCalls,
    fileChangeEvents: input.fileChangeEvents,
    distinctChangedFiles: input.distinctChangedFiles,
    totalTokens: input.totalTokens,
    shouldRun,
    reasons,
    displayReason: shouldRun
      ? `Memory threshold reached: ${reasons.join(", ")}.`
      : `Checked ${input.turnCount} new ${input.turnCount === 1 ? "turn" : "turns"}; below memory threshold.`,
  }
}
