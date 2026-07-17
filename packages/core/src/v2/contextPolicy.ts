import {
  V2_CONTEXT_UNRESOLVED_MAX_AGE_TURNS,
  V2_CONTEXT_UNRESOLVED_MAX_ITEMS,
} from "@socrates/contracts"
import type {
  ImmutableEvidenceRecord,
  ImmutableEvidenceRef,
  V2ContextDispositionDecision,
  V2ContextItem,
  V2ContextState,
} from "./types"

export const V2_MAX_UNRESOLVED_CONTEXT_ITEMS = V2_CONTEXT_UNRESOLVED_MAX_ITEMS
export const V2_UNRESOLVED_REVIEW_AFTER_COMPLETED_TURNS = V2_CONTEXT_UNRESOLVED_MAX_AGE_TURNS

export type V2ContextPolicyErrorCode =
  | "duplicate_evidence"
  | "evidence_not_found"
  | "context_item_not_found"
  | "duplicate_context_item"
  | "duplicate_decision"
  | "distillation_required"
  | "unresolved_limit_exceeded"
  | "unresolved_review_due"

export class V2ContextPolicyError extends Error {
  constructor(
    readonly code: V2ContextPolicyErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = "V2ContextPolicyError"
  }
}

export const createImmutableEvidenceRecord = (input: {
  evidenceId: string
  flowId: string
  sourceType: string
  sourceLocator: string
  contentHash: string
  capturedAt: string
  exactContent: string
  metadata?: Readonly<Record<string, unknown>>
}): ImmutableEvidenceRecord => {
  const ref = Object.freeze({
    evidenceId: required(input.evidenceId, "evidenceId"),
    flowId: required(input.flowId, "flowId"),
    sourceType: required(input.sourceType, "sourceType"),
    sourceLocator: required(input.sourceLocator, "sourceLocator"),
    contentHash: required(input.contentHash, "contentHash"),
    capturedAt: required(input.capturedAt, "capturedAt"),
  })
  return Object.freeze({
    ref,
    exactContent: input.exactContent,
    ...(input.metadata ? { metadata: Object.freeze({ ...input.metadata }) } : {}),
  })
}

export const appendImmutableV2Evidence = (
  state: V2ContextState,
  evidence: ImmutableEvidenceRecord,
): V2ContextState => {
  if (state.evidence.some((record) => record.ref.evidenceId === evidence.ref.evidenceId)) {
    throw new V2ContextPolicyError("duplicate_evidence", `Evidence ${evidence.ref.evidenceId} already exists and cannot be replaced.`)
  }
  const immutableEvidence = Object.freeze({
    ...evidence,
    ref: Object.freeze({ ...evidence.ref }),
    ...(evidence.metadata ? { metadata: Object.freeze({ ...evidence.metadata }) } : {}),
  })
  return { evidence: [...state.evidence, immutableEvidence], items: state.items }
}

export const createV2ContextItem = (input: {
  id: string
  flowId: string
  goalId?: string
  evidenceRef: ImmutableEvidenceRef
  completedTurn: number
  priority?: number
  tokenEstimate?: number
}): V2ContextItem => {
  const completedTurn = nonNegativeInteger(input.completedTurn, "completedTurn")
  const priority = Number.isFinite(input.priority) ? input.priority ?? 0 : 0
  return {
    id: required(input.id, "context item id"),
    flowId: required(input.flowId, "flowId"),
    ...(input.goalId ? { goalId: input.goalId } : {}),
    evidenceRef: input.evidenceRef,
    disposition: "keep_exact",
    representation: "exact",
    ...(input.tokenEstimate === undefined ? {} : { tokenEstimate: nonNegativeInteger(input.tokenEstimate, "tokenEstimate") }),
    active: true,
    priority,
    createdAtCompletedTurn: completedTurn,
    decidedAtCompletedTurn: completedTurn,
  }
}

export const addV2ContextItem = (state: V2ContextState, item: V2ContextItem): V2ContextState => {
  if (!state.evidence.some((record) => sameEvidenceRef(record.ref, item.evidenceRef))) {
    throw new V2ContextPolicyError("evidence_not_found", `Evidence ${item.evidenceRef.evidenceId} is not present in the immutable evidence store.`)
  }
  if (state.items.some((current) => current.id === item.id)) {
    throw new V2ContextPolicyError("duplicate_context_item", `Context item ${item.id} already exists.`)
  }
  return { evidence: state.evidence, items: [...state.items, item] }
}

export const applyV2ContextDispositions = (input: {
  state: V2ContextState
  decisions: readonly V2ContextDispositionDecision[]
  completedTurn: number
  maxUnresolved?: number
  reviewAfterCompletedTurns?: number
}): V2ContextState => {
  const completedTurn = nonNegativeInteger(input.completedTurn, "completedTurn")
  const maxUnresolved = boundedInteger(input.maxUnresolved ?? V2_MAX_UNRESOLVED_CONTEXT_ITEMS, 0, V2_MAX_UNRESOLVED_CONTEXT_ITEMS)
  const reviewAfter = boundedInteger(
    input.reviewAfterCompletedTurns ?? V2_UNRESOLVED_REVIEW_AFTER_COMPLETED_TURNS,
    1,
    V2_UNRESOLVED_REVIEW_AFTER_COMPLETED_TURNS,
  )
  const decisionById = new Map<string, V2ContextDispositionDecision>()
  for (const decision of input.decisions) {
    if (decisionById.has(decision.contextItemId)) {
      throw new V2ContextPolicyError("duplicate_decision", `Context item ${decision.contextItemId} has more than one disposition decision.`)
    }
    decisionById.set(decision.contextItemId, decision)
  }
  const itemById = new Map(input.state.items.map((item) => [item.id, item]))
  for (const contextItemId of decisionById.keys()) {
    if (!itemById.has(contextItemId)) {
      throw new V2ContextPolicyError("context_item_not_found", `Context item ${contextItemId} does not exist.`)
    }
  }

  const due = input.state.items.filter(
    (item) => item.disposition === "unresolved" && (item.reviewDueAtCompletedTurn ?? Number.POSITIVE_INFINITY) <= completedTurn,
  )
  const unreviewedDueIds = due
    .filter((item) => {
      const decision = decisionById.get(item.id)
      return !decision || decision.disposition === "unresolved"
    })
    .map((item) => item.id)
  if (unreviewedDueIds.length > 0) {
    throw new V2ContextPolicyError(
      "unresolved_review_due",
      "Unresolved V2 context items must be resolved after three subsequent completed turns.",
      { contextItemIds: unreviewedDueIds, completedTurn },
    )
  }

  const items = input.state.items.map((item) => {
    const decision = decisionById.get(item.id)
    return decision ? applyDecision(item, decision, completedTurn, reviewAfter) : item
  })
  const unresolvedIds = items.filter((item) => item.disposition === "unresolved").map((item) => item.id)
  if (unresolvedIds.length > maxUnresolved) {
    throw new V2ContextPolicyError(
      "unresolved_limit_exceeded",
      `V2 context can retain at most ${maxUnresolved} unresolved items.`,
      { contextItemIds: unresolvedIds, maxUnresolved },
    )
  }

  // The evidence array is deliberately preserved by reference. A disposition
  // only changes the active model-context projection; it never deletes source evidence.
  return { evidence: input.state.evidence, items }
}

export const getV2ContextReviewRequirements = (
  items: readonly V2ContextItem[],
  completedTurn: number,
  maxUnresolved = V2_MAX_UNRESOLVED_CONTEXT_ITEMS,
): Readonly<{
  unresolvedIds: readonly string[]
  dueNowIds: readonly string[]
  remainingUnresolvedSlots: number
}> => {
  const turn = nonNegativeInteger(completedTurn, "completedTurn")
  const unresolved = items.filter((item) => item.disposition === "unresolved")
  return {
    unresolvedIds: unresolved.map((item) => item.id),
    dueNowIds: unresolved.filter((item) => (item.reviewDueAtCompletedTurn ?? Number.POSITIVE_INFINITY) <= turn).map((item) => item.id),
    remainingUnresolvedSlots: Math.max(0, Math.min(V2_MAX_UNRESOLVED_CONTEXT_ITEMS, maxUnresolved) - unresolved.length),
  }
}

const applyDecision = (
  item: V2ContextItem,
  decision: V2ContextDispositionDecision,
  completedTurn: number,
  reviewAfter: number,
): V2ContextItem => {
  if (decision.disposition === "distill") {
    const distilledText = decision.distilledText?.trim()
    if (!distilledText) {
      throw new V2ContextPolicyError("distillation_required", `Context item ${item.id} requires non-empty distilled text.`)
    }
    return {
      ...withoutUnresolvedFields(item),
      disposition: "distill",
      representation: "distilled",
      distilledText,
      active: true,
      decidedAtCompletedTurn: completedTurn,
    }
  }
  if (decision.disposition === "release") {
    return {
      ...withoutUnresolvedFields(item),
      disposition: "release",
      active: false,
      decidedAtCompletedTurn: completedTurn,
    }
  }
  if (decision.disposition === "keep_exact") {
    return {
      ...withoutUnresolvedFields(item),
      disposition: "keep_exact",
      representation: "exact",
      active: true,
      decidedAtCompletedTurn: completedTurn,
    }
  }
  const unresolvedSinceCompletedTurn = item.disposition === "unresolved"
    ? item.unresolvedSinceCompletedTurn ?? completedTurn
    : completedTurn
  const reviewDueAtCompletedTurn = item.disposition === "unresolved"
    ? item.reviewDueAtCompletedTurn ?? unresolvedSinceCompletedTurn + reviewAfter
    : completedTurn + reviewAfter
  return {
    ...withoutDistilledText(item),
    disposition: "unresolved",
    representation: "exact",
    active: true,
    decidedAtCompletedTurn: completedTurn,
    unresolvedSinceCompletedTurn,
    reviewDueAtCompletedTurn,
  }
}

const withoutUnresolvedFields = (item: V2ContextItem): Omit<V2ContextItem, "unresolvedSinceCompletedTurn" | "reviewDueAtCompletedTurn" | "distilledText"> => {
  const { unresolvedSinceCompletedTurn: _unresolved, reviewDueAtCompletedTurn: _reviewDue, distilledText: _distilled, ...rest } = item
  return rest
}

const withoutDistilledText = (item: V2ContextItem): Omit<V2ContextItem, "distilledText"> => {
  const { distilledText: _distilled, ...rest } = item
  return rest
}

const sameEvidenceRef = (left: ImmutableEvidenceRef, right: ImmutableEvidenceRef): boolean =>
  left.evidenceId === right.evidenceId &&
  left.flowId === right.flowId &&
  left.contentHash === right.contentHash &&
  left.sourceLocator === right.sourceLocator

const required = (value: string, label: string): string => {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} cannot be empty.`)
  return normalized
}

const nonNegativeInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`)
  return value
}

const boundedInteger = (value: number, min: number, max: number): number => {
  if (!Number.isInteger(value)) throw new Error("Policy limits must be integers.")
  return Math.min(max, Math.max(min, value))
}
