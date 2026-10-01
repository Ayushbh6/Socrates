import type {
  V2ContextDisposition as ContractV2ContextDisposition,
  V2Goal as ContractV2Goal,
  V2GoalCapsule as ContractV2GoalCapsule,
} from "@socrates/contracts"
import type { ModelMessage } from "@socrates/providers"

export type V2GoalStatus = ContractV2Goal["status"]
export type V2Goal = ContractV2Goal
export type V2GoalCapsule = ContractV2GoalCapsule

export type V2GoalRoutingAction = "continue" | "resume" | "create" | "clarify"

export type V2GoalRoutingDecision = Readonly<{
  action: V2GoalRoutingAction
  primaryGoalId?: string
  secondaryGoalIds: readonly string[]
  confidence: number
  clarificationQuestion?: string
  clarificationGoalIds?: readonly string[]
  reasonCode:
    | "foreground_continuation"
    | "explicit_parked_match"
    | "model_match"
    | "no_foreground"
    | "new_goal"
    | "conservative_fallback"
    | "ambiguous_focus"
}>

export type V2GoalRoutingCandidate = Readonly<{
  goal: V2Goal
  capsule?: V2GoalCapsule
  lexicalScore: number
}>

export type V2GoalRoutingCandidateSet = Readonly<{
  foreground?: V2GoalRoutingCandidate
  parked: readonly V2GoalRoutingCandidate[]
  candidates: readonly V2GoalRoutingCandidate[]
  totalEligibleParked: number
  parkedCandidateLimit: number
}>

export type V2GoalTransition = Readonly<{
  goalId: string
  from: V2GoalStatus
  to: V2GoalStatus
}>

export type V2GoalRoutingPlan = Readonly<{
  action: Exclude<V2GoalRoutingAction, "clarify">
  foregroundGoalId: string
  createGoal: boolean
  transitions: readonly V2GoalTransition[]
  secondaryGoalIds: readonly string[]
}>

export type V2CapsuleRefreshReason =
  | "initial"
  | "parked"
  | "material_change"
  | "pre_compaction"
  | "completed"
  | "stale"

export type ImmutableEvidenceRef = Readonly<{
  evidenceId: string
  flowId: string
  sourceType: string
  sourceLocator: string
  contentHash: string
  capturedAt: string
}>

export type ImmutableEvidenceRecord = Readonly<{
  ref: ImmutableEvidenceRef
  exactContent: string
  metadata?: Readonly<Record<string, unknown>>
}>

export type V2ContextDisposition = ContractV2ContextDisposition["disposition"]

export type V2ContextRepresentation = "exact" | "distilled"

export type V2ContextItem = Readonly<{
  id: string
  flowId: string
  goalId?: string
  evidenceRef: ImmutableEvidenceRef
  disposition: V2ContextDisposition
  representation: V2ContextRepresentation
  distilledText?: string
  tokenEstimate?: number
  active: boolean
  priority: number
  createdAtCompletedTurn: number
  decidedAtCompletedTurn: number
  unresolvedSinceCompletedTurn?: number
  reviewDueAtCompletedTurn?: number
}>

export type V2ContextDispositionDecision = Readonly<{
  contextItemId: string
  disposition: V2ContextDisposition
  distilledText?: string
}>

export type V2ContextState = Readonly<{
  evidence: readonly ImmutableEvidenceRecord[]
  items: readonly V2ContextItem[]
}>

export type V2ContextBudget = Readonly<{
  contextWindowTokens: number
  reservedOutputTokens: number
  systemAndToolReserveTokens: number
  usableInputTokens: number
  softPruneTriggerTokens: number
  compactionTriggerTokens: number
  postPruneTargetTokens: number
  postCompactionTargetTokens: number
  hardInputLimitTokens: number
  recentGoalTailTokens: number
}>

export type V2FlowContextMessage = Readonly<{
  id: string
  role: ModelMessage["role"]
  content: ModelMessage["content"]
  occurredAt: string
  primaryGoalId?: string
  linkedGoalIds?: readonly string[]
  scope?: "goal" | "flow"
  tokenEstimate?: number
}>

export type V2ExactEvidenceMaterial = Readonly<{
  evidenceRef: ImmutableEvidenceRef
  exactContent: string
}>

export type V2ExactRetrievalCandidate = Readonly<{
  contextItemId: string
  evidenceRef: ImmutableEvidenceRef
  priority: number
  disposition: Extract<V2ContextDisposition, "keep_exact" | "unresolved">
}>

export type V2ExactRetrievalSelector = (
  candidates: readonly V2ExactRetrievalCandidate[],
  context: Readonly<{ foregroundGoalId: string; query: string; limit: number }>,
) => readonly string[] | Promise<readonly string[]>

export type V2ExactEvidenceRetriever = (
  refs: readonly ImmutableEvidenceRef[],
  context: Readonly<{ foregroundGoalId: string; query: string }>,
) => readonly V2ExactEvidenceMaterial[] | Promise<readonly V2ExactEvidenceMaterial[]>

export type V2GoalWorkingContext = Readonly<{
  messages: readonly V2FlowContextMessage[]
  distilledItems: readonly Readonly<{ contextItemId: string; text: string; evidenceRef: ImmutableEvidenceRef }>[]
  exactEvidence: readonly V2ExactEvidenceMaterial[]
  requestedExactEvidenceRefs: readonly ImmutableEvidenceRef[]
  excludedMessageIds: readonly string[]
  excludedContextItemIds: readonly string[]
  evidenceTokenLimit: number
  estimatedTokens: number
}>
