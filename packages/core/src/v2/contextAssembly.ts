import type { ModelMessage, ModelMessagePart } from "@socrates/providers"
import type {
  V2ContextBudget,
  V2ContextItem,
  V2ExactEvidenceMaterial,
  V2ExactEvidenceRetriever,
  V2ExactRetrievalCandidate,
  V2ExactRetrievalSelector,
  V2FlowContextMessage,
  V2GoalWorkingContext,
} from "./types"

export const DEFAULT_V2_EXACT_RETRIEVAL_LIMIT = 8
export const MAX_V2_EXACT_RETRIEVAL_LIMIT = 20

export const filterV2FlowMessagesForGoal = (
  messages: readonly V2FlowContextMessage[],
  foregroundGoalId: string,
): V2FlowContextMessage[] =>
  messages.filter(
    (message) =>
      message.scope === "flow" ||
      message.primaryGoalId === foregroundGoalId ||
      message.linkedGoalIds?.includes(foregroundGoalId) === true,
  )

export const selectV2ExactRetrievalCandidates = async (input: {
  items: readonly V2ContextItem[]
  foregroundGoalId: string
  query: string
  limit?: number
  selector?: V2ExactRetrievalSelector
}): Promise<V2ExactRetrievalCandidate[]> => {
  const limit = clampInteger(input.limit ?? DEFAULT_V2_EXACT_RETRIEVAL_LIMIT, 0, MAX_V2_EXACT_RETRIEVAL_LIMIT)
  const candidates: V2ExactRetrievalCandidate[] = input.items
    .filter(
      (item) =>
        item.active &&
        (!item.goalId || item.goalId === input.foregroundGoalId) &&
        (item.disposition === "keep_exact" || item.disposition === "unresolved"),
    )
    .map((item) => ({
      contextItemId: item.id,
      evidenceRef: item.evidenceRef,
      priority: item.priority,
      disposition: item.disposition as "keep_exact" | "unresolved",
    }))
    .sort(compareExactCandidates)
  if (!input.selector) return candidates.slice(0, limit)
  const selectedIds = await input.selector(candidates, {
    foregroundGoalId: input.foregroundGoalId,
    query: input.query,
    limit,
  })
  const allowedById = new Map(candidates.map((candidate) => [candidate.contextItemId, candidate]))
  const selected: V2ExactRetrievalCandidate[] = []
  const seen = new Set<string>()
  for (const id of selectedIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const candidate = allowedById.get(id)
    if (candidate) selected.push(candidate)
    if (selected.length >= limit) break
  }
  return selected
}

export const assembleV2GoalWorkingContext = async (input: {
  foregroundGoalId: string
  query: string
  messages: readonly V2FlowContextMessage[]
  contextItems: readonly V2ContextItem[]
  budget?: V2ContextBudget
  evidenceTokenLimit?: number
  exactRetrievalLimit?: number
  exactSelector?: V2ExactRetrievalSelector
  exactRetriever?: V2ExactEvidenceRetriever
}): Promise<V2GoalWorkingContext> => {
  const relatedMessages = filterV2FlowMessagesForGoal(input.messages, input.foregroundGoalId)
  const messageTokenLimit = input.budget?.recentGoalTailTokens
  const messages = messageTokenLimit ? retainNewestWithinTokenLimit(relatedMessages, messageTokenLimit) : relatedMessages
  const messageTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  const includedIds = new Set(messages.map((message) => message.id))
  const excludedMessageIds = input.messages.filter((message) => !includedIds.has(message.id)).map((message) => message.id)
  const scopedItems = input.contextItems.filter(
    (item) => item.active && (!item.goalId || item.goalId === input.foregroundGoalId),
  )
  const itemById = new Map(scopedItems.map((item) => [item.id, item]))
  const derivedEvidenceTokenLimit = input.budget
    ? Math.max(0, input.budget.postPruneTargetTokens - messageTokens)
    : Number.POSITIVE_INFINITY
  const evidenceTokenLimit = input.evidenceTokenLimit === undefined
    ? derivedEvidenceTokenLimit
    : Math.min(derivedEvidenceTokenLimit, normalizeTokenLimit(input.evidenceTokenLimit))
  const distilledCandidates = scopedItems
    .filter((item) => item.disposition === "distill" && Boolean(item.distilledText))
    .map((item) => ({
      contextItemId: item.id,
      text: item.distilledText ?? "",
      evidenceRef: item.evidenceRef,
      priority: item.priority,
    }))
  const selectedExact = await selectV2ExactRetrievalCandidates({
    items: scopedItems,
    foregroundGoalId: input.foregroundGoalId,
    query: input.query,
    ...(input.exactRetrievalLimit === undefined ? {} : { limit: input.exactRetrievalLimit }),
    ...(input.exactSelector ? { selector: input.exactSelector } : {}),
  })
  const selectedRepresentations = selectEvidenceRepresentationsWithinTokenLimit(
    distilledCandidates,
    selectedExact,
    itemById,
    evidenceTokenLimit,
  )
  const distilledItems = selectedRepresentations
    .filter((candidate): candidate is DistilledRepresentationCandidate => candidate.kind === "distilled")
    .map(({ contextItemId, text, evidenceRef }) => ({ contextItemId, text, evidenceRef }))
  const budgetedExact = selectedRepresentations
    .filter((candidate): candidate is ExactRepresentationCandidate => candidate.kind === "exact")
    .map((candidate) => candidate.candidate)
  const distilledTokens = distilledItems.reduce((sum, item) => sum + estimateTextTokens(item.text), 0)
  const remainingExactTokens = Math.max(0, evidenceTokenLimit - distilledTokens)
  const requestedExactEvidenceRefs = budgetedExact.map((candidate) => candidate.evidenceRef)
  const retrieved = input.exactRetriever
    ? await input.exactRetriever(requestedExactEvidenceRefs, { foregroundGoalId: input.foregroundGoalId, query: input.query })
    : []
  const allowedEvidenceIds = new Set(requestedExactEvidenceRefs.map((ref) => ref.evidenceId))
  const retrievedByEvidenceId = new Map(
    uniqueExactMaterials(retrieved)
      .filter((material) => allowedEvidenceIds.has(material.evidenceRef.evidenceId))
      .map((material) => [material.evidenceRef.evidenceId, material]),
  )
  const exactEvidence: V2ExactEvidenceMaterial[] = []
  let exactTokens = 0
  for (const candidate of budgetedExact) {
    const material = retrievedByEvidenceId.get(candidate.evidenceRef.evidenceId)
    if (!material) continue
    const tokens = estimateTextTokens(material.exactContent)
    if (exactTokens + tokens > remainingExactTokens) continue
    exactEvidence.push(material)
    exactTokens += tokens
  }
  const includedContextItemIds = new Set(distilledItems.map((item) => item.contextItemId))
  const exactContextItemByEvidenceId = new Map(budgetedExact.map((candidate) => [candidate.evidenceRef.evidenceId, candidate.contextItemId]))
  for (const material of exactEvidence) {
    const contextItemId = exactContextItemByEvidenceId.get(material.evidenceRef.evidenceId)
    if (contextItemId) includedContextItemIds.add(contextItemId)
  }
  return {
    messages,
    distilledItems,
    exactEvidence,
    requestedExactEvidenceRefs,
    excludedMessageIds,
    excludedContextItemIds: scopedItems.filter((item) => !includedContextItemIds.has(item.id)).map((item) => item.id),
    evidenceTokenLimit,
    estimatedTokens: messageTokens + distilledTokens + exactTokens,
  }
}

type DistilledRepresentationCandidate = Readonly<{
  kind: "distilled"
  contextItemId: string
  text: string
  evidenceRef: V2ContextItem["evidenceRef"]
  priority: number
  tokens: number
}>

type ExactRepresentationCandidate = Readonly<{
  kind: "exact"
  candidate: V2ExactRetrievalCandidate
  priority: number
  tokens: number
}>

type EvidenceRepresentationCandidate = DistilledRepresentationCandidate | ExactRepresentationCandidate

const selectEvidenceRepresentationsWithinTokenLimit = (
  distilled: readonly Readonly<{
    contextItemId: string
    text: string
    evidenceRef: V2ContextItem["evidenceRef"]
    priority: number
  }>[],
  exact: readonly V2ExactRetrievalCandidate[],
  itemById: ReadonlyMap<string, V2ContextItem>,
  tokenLimit: number,
): EvidenceRepresentationCandidate[] => {
  const candidates: EvidenceRepresentationCandidate[] = [
    ...distilled.map((candidate): DistilledRepresentationCandidate => ({
      kind: "distilled",
      ...candidate,
      tokens: estimateTextTokens(candidate.text),
    })),
    ...exact.map((candidate): ExactRepresentationCandidate => ({
      kind: "exact",
      candidate,
      priority: candidate.priority,
      tokens: Math.max(1, itemById.get(candidate.contextItemId)?.tokenEstimate ?? 1),
    })),
  ].sort((left, right) =>
    Number(right.kind === "exact" && right.candidate.disposition === "unresolved") -
      Number(left.kind === "exact" && left.candidate.disposition === "unresolved") ||
    right.priority - left.priority ||
    representationId(left).localeCompare(representationId(right)))
  const selected: EvidenceRepresentationCandidate[] = []
  let used = 0
  for (const candidate of candidates) {
    if (used + candidate.tokens > tokenLimit) continue
    selected.push(candidate)
    used += candidate.tokens
  }
  return selected
}

const representationId = (candidate: EvidenceRepresentationCandidate): string =>
  candidate.kind === "distilled" ? candidate.contextItemId : candidate.candidate.contextItemId

const retainNewestWithinTokenLimit = (
  messages: readonly V2FlowContextMessage[],
  tokenLimit: number,
): V2FlowContextMessage[] => {
  const selected: V2FlowContextMessage[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    const tokens = estimateMessageTokens(message)
    if (selected.length > 0 && used + tokens > tokenLimit) continue
    selected.push(message)
    used += tokens
    if (used >= tokenLimit) break
  }
  return selected.reverse()
}

const compareExactCandidates = (left: V2ExactRetrievalCandidate, right: V2ExactRetrievalCandidate): number =>
  Number(right.disposition === "unresolved") - Number(left.disposition === "unresolved") ||
  right.priority - left.priority ||
  left.contextItemId.localeCompare(right.contextItemId)

const uniqueExactMaterials = (materials: readonly V2ExactEvidenceMaterial[]): V2ExactEvidenceMaterial[] => {
  const seen = new Set<string>()
  return materials.filter((material) => {
    if (seen.has(material.evidenceRef.evidenceId)) return false
    seen.add(material.evidenceRef.evidenceId)
    return true
  })
}

const estimateMessageTokens = (message: V2FlowContextMessage): number =>
  message.tokenEstimate ?? estimateContentTokens(message.content)

const estimateContentTokens = (content: ModelMessage["content"]): number =>
  typeof content === "string" ? estimateTextTokens(content) : content.reduce((sum, part) => sum + estimatePartTokens(part), 0)

const estimatePartTokens = (part: ModelMessagePart): number => {
  if (part.type === "text" || part.type === "reasoning") return estimateTextTokens(part.text)
  if (part.type === "image") return 1_024
  if (part.type === "tool-call") return estimateTextTokens(`${part.toolName} ${JSON.stringify(part.input)}`)
  return estimateTextTokens(`${part.toolName} ${JSON.stringify(part.output)}`)
}

const estimateTextTokens = (value: string): number => Math.max(1, Math.ceil(value.length / 4))
const normalizeTokenLimit = (value: number): number =>
  value === Number.POSITIVE_INFINITY
    ? value
    : Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
const clampInteger = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? value : min)))
