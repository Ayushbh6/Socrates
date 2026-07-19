import {
  contextDispositionToolOutputSchema,
  type ContextDispositionToolInput,
  type ContextDispositionToolOutput,
  type ProviderId,
} from "@socrates/contracts"
import { estimateTextTokens, type ModelMessage, type ModelMessagePart } from "@socrates/providers"

export const TOOL_OUTPUT_DISPOSITION_RESULT_TRIGGER_TOKENS = 4_000
export const TOOL_OUTPUT_DISPOSITION_BATCH_TRIGGER_TOKENS = 12_000
export const TOOL_OUTPUT_DISPOSITION_BATCH_MEMBER_MIN_TOKENS = 1_000
export const TOOL_OUTPUT_DISPOSITION_MAX_VISIBLE_CANDIDATES = 8

const PROMPT_OPEN = "<socrates_tool_output_disposition_candidates>"
const PROMPT_CLOSE = "</socrates_tool_output_disposition_candidates>"

type ToolResultPart = Extract<ModelMessagePart, { type: "tool-result" }>

type Candidate = {
  result: string
  toolName: string
  estimatedTokens: number
  part: ToolResultPart
  state: "pending" | "unresolved"
}

export class ToolOutputDispositionLedger {
  private readonly candidates = new Map<string, Candidate>()
  private nextResultNumber = 1

  constructor(private readonly messages: ModelMessage[]) {}

  recordBatch(input: {
    message: ModelMessage
    providerId: ProviderId
    modelId: string
  }): void {
    if (input.message.role !== "tool" || !Array.isArray(input.message.content)) return
    const measured = input.message.content.flatMap((part): Array<{ part: ToolResultPart; tokens: number }> => {
      if (part.type !== "tool-result" || part.toolName === "context_disposition" || !isSuccessfulToolOutput(part.output)) return []
      const tokens = estimateTextTokens(safeStringify(part.output), {
        providerId: input.providerId,
        modelId: input.modelId,
        applySafetyMargin: false,
      }).inputTokens
      return [{ part, tokens }]
    })
    const batchTokens = measured.reduce((sum, item) => sum + item.tokens, 0)
    for (const item of measured) {
      const individuallySubstantial = item.tokens >= TOOL_OUTPUT_DISPOSITION_RESULT_TRIGGER_TOKENS
      const substantialBatchMember =
        batchTokens >= TOOL_OUTPUT_DISPOSITION_BATCH_TRIGGER_TOKENS &&
        item.tokens >= TOOL_OUTPUT_DISPOSITION_BATCH_MEMBER_MIN_TOKENS
      if (!individuallySubstantial && !substantialBatchMember) continue
      const result = `result_${this.nextResultNumber}`
      this.nextResultNumber += 1
      this.candidates.set(result, {
        result,
        toolName: item.part.toolName,
        estimatedTokens: item.tokens,
        part: item.part,
        state: "pending",
      })
    }
    this.refreshPrompt()
  }

  apply(input: ContextDispositionToolInput, piggybacked: boolean): ContextDispositionToolOutput {
    const applied: ContextDispositionToolOutput["applied"] = []
    const ignored: string[] = []
    for (const decision of input.decisions) {
      const candidate = this.candidates.get(decision.result)
      if (!candidate) {
        ignored.push(decision.result)
        continue
      }
      if (decision.action === "distill") {
        replaceToolResultOutput(candidate.part, {
          contextDisposition: "distilled",
          result: candidate.result,
          toolName: candidate.toolName,
          summary: decision.summary ?? "",
          exactEvidence: "The exact tool output remains stored in the current turn audit.",
          retrievalHint: retrievalHint(candidate.toolName),
        })
        this.candidates.delete(candidate.result)
      } else if (decision.action === "release") {
        replaceToolResultOutput(candidate.part, {
          contextDisposition: "released",
          result: candidate.result,
          toolName: candidate.toolName,
          exactEvidence: "The exact tool output remains stored in the current turn audit.",
          retrievalHint: retrievalHint(candidate.toolName),
        })
        this.candidates.delete(candidate.result)
      } else if (decision.action === "keep_exact") {
        this.candidates.delete(candidate.result)
      } else {
        candidate.state = "unresolved"
      }
      applied.push({ result: decision.result, action: decision.action })
    }
    this.refreshPrompt()
    const dispositionSummary = applied.length === 0
      ? "No current-turn tool outputs were changed."
      : `Applied ${applied.length} current-turn tool-output disposition${applied.length === 1 ? "" : "s"}.`
    return contextDispositionToolOutputSchema.parse({
      applied,
      ignored,
      piggybacked,
      summary: piggybacked
        ? dispositionSummary
        : `${dispositionSummary} This control tool was called without a functional tool and caused an avoidable model round trip.`,
    })
  }

  pendingResults(): string[] {
    return [...this.candidates.keys()]
  }

  private refreshPrompt(): void {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index]
      if (message?.role === "developer" && typeof message.content === "string" && message.content.includes(PROMPT_OPEN)) {
        this.messages.splice(index, 1)
      }
    }
    const visible = [...this.candidates.values()].slice(0, TOOL_OUTPUT_DISPOSITION_MAX_VISIBLE_CANDIDATES)
    if (visible.length === 0) return
    const remaining = this.candidates.size - visible.length
    this.messages.push({
      role: "developer",
      content: [
        PROMPT_OPEN,
        "You have now inspected these substantial current-turn tool outputs:",
        ...visible.map((candidate) =>
          `- ${candidate.result}: ${candidate.toolName}, about ${candidate.estimatedTokens} tokens, ${candidate.state}`),
        ...(remaining > 0 ? [`- ${remaining} additional candidate${remaining === 1 ? " is" : "s are"} queued after these.`] : []),
        "If you need another functional tool call, include one context_disposition call in that same response and classify the listed results that no longer need to remain exact. Do not call context_disposition alone. If you can answer now, give the final answer without calling it because the turn will end. Use unresolved only when the next tool result is genuinely needed to judge the evidence.",
        PROMPT_CLOSE,
      ].join("\n"),
    })
  }
}

const isSuccessfulToolOutput = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value) && (value as { ok?: unknown }).ok === true

const replaceToolResultOutput = (part: ToolResultPart, replacement: unknown): void => {
  if (typeof part.output === "object" && part.output !== null && !Array.isArray(part.output)) {
    part.output = { ...(part.output as Record<string, unknown>), output: replacement }
    return
  }
  part.output = replacement
}

const retrievalHint = (toolName: string): string =>
  `If exact detail becomes necessary, rerun a narrower ${toolName} call during this turn or use trace_retrieve audit after the turn.`

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
