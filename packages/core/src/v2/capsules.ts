import type { V2CapsuleRefreshReason, V2Goal, V2GoalCapsule } from "./types"

export const DEFAULT_V2_CAPSULE_STALE_AFTER_SEQUENCES = 6
export const MAX_V2_CAPSULE_LIST_ITEMS = 12

export type V2CapsuleRefreshEvent = Readonly<{
  kind: "goal_created" | "goal_parked" | "material_change" | "pre_compaction" | "goal_completed" | "turn_completed"
  sequence: number
}>

export type V2GoalCapsulePatch = Readonly<{
  summary: string
  decisions?: readonly string[]
  openQuestions?: readonly string[]
  nextActions?: readonly string[]
  evidenceHandles?: readonly string[]
}>

export const capsuleRefreshReason = (input: {
  capsule?: V2GoalCapsule
  event: V2CapsuleRefreshEvent
  staleAfterSequences?: number
}): V2CapsuleRefreshReason | undefined => {
  if (!input.capsule || input.event.kind === "goal_created") return "initial"
  if (input.event.kind === "goal_parked") return "parked"
  if (input.event.kind === "material_change") return "material_change"
  if (input.event.kind === "pre_compaction") return "pre_compaction"
  if (input.event.kind === "goal_completed") return "completed"
  const staleAfter = clampInteger(input.staleAfterSequences ?? DEFAULT_V2_CAPSULE_STALE_AFTER_SEQUENCES, 1, 10_000)
  return input.event.sequence - input.capsule.sourceThroughSequence >= staleAfter ? "stale" : undefined
}

export const shouldRefreshV2GoalCapsule = (input: {
  capsule?: V2GoalCapsule
  event: V2CapsuleRefreshEvent
  staleAfterSequences?: number
}): boolean => capsuleRefreshReason(input) !== undefined

export const refreshV2GoalCapsule = (input: {
  capsuleId: string
  goal: V2Goal
  previous?: V2GoalCapsule
  patch: V2GoalCapsulePatch
  sourceThroughSequence: number
  tokenEstimate: number
  createdAt: string
  createdByTurnId?: string
}): V2GoalCapsule => {
  if (input.previous && input.previous.goalId !== input.goal.id) {
    throw new Error("A V2 goal capsule can only be refreshed for its own goal.")
  }
  const sourceThroughSequence = nonNegativeInteger(input.sourceThroughSequence, "sourceThroughSequence")
  const tokenEstimate = nonNegativeInteger(input.tokenEstimate, "tokenEstimate")
  return {
    id: input.capsuleId,
    flowId: input.goal.flowId,
    goalId: input.goal.id,
    version: (input.previous?.version ?? 0) + 1,
    status: input.goal.status === "completed" ? "final" : "active",
    summary: nonEmpty(input.patch.summary, "Capsule summary"),
    decisions: normalizeList(input.patch.decisions ?? input.previous?.decisions ?? []),
    openQuestions: normalizeList(input.patch.openQuestions ?? input.previous?.openQuestions ?? []),
    nextActions: normalizeList(input.patch.nextActions ?? input.previous?.nextActions ?? []),
    evidenceHandles: normalizeList([...(input.previous?.evidenceHandles ?? []), ...(input.patch.evidenceHandles ?? [])]),
    sourceThroughSequence,
    tokenEstimate,
    ...(input.createdByTurnId ? { createdByTurnId: input.createdByTurnId } : {}),
    createdAt: nonEmpty(input.createdAt, "Capsule createdAt"),
  }
}

export const renderV2GoalCapsuleForRouting = (capsule: V2GoalCapsule): string =>
  [
    `State: ${capsule.summary}`,
    capsule.decisions.length > 0 ? `Decisions: ${capsule.decisions.join(" | ")}` : undefined,
    capsule.nextActions.length > 0 ? `Next: ${capsule.nextActions.join(" | ")}` : undefined,
    capsule.openQuestions.length > 0 ? `Open: ${capsule.openQuestions.join(" | ")}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n")

const normalizeList = (values: readonly string[]): string[] =>
  [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, MAX_V2_CAPSULE_LIST_ITEMS)

const nonEmpty = (value: string, label: string): string => {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} cannot be empty.`)
  return normalized
}

const nonNegativeInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`)
  return value
}

const clampInteger = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? value : min)))
