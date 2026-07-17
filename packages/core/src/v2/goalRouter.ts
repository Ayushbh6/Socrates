import type { ProviderAuthMode, ProviderId, RuntimeConfig, ThinkingEffort } from "@socrates/contracts"
import type { ModelProvider, ModelUsage, StructuredModelRequest, StructuredModelResult } from "@socrates/providers"
import { z } from "zod"
import type {
  V2Goal,
  V2GoalCapsule,
  V2GoalRoutingCandidate,
  V2GoalRoutingCandidateSet,
  V2GoalRoutingDecision,
  V2GoalRoutingPlan,
  V2GoalStatus,
} from "./types"

export const DEFAULT_V2_PARKED_GOAL_CANDIDATE_LIMIT = 5
export const MAX_V2_PARKED_GOAL_CANDIDATE_LIMIT = 8
export const MAX_V2_SECONDARY_GOAL_LINKS = 3
export const DEFAULT_V2_GOAL_ROUTER_TIMEOUT_MS = 8_000

export type V2GoalRouterModelSettings = Readonly<{
  providerId: ProviderId
  authMode?: ProviderAuthMode
  modelId: string
  thinkingEnabled?: boolean
  thinkingEffort?: ThinkingEffort
  timeoutMs?: number
}>

export type V2GoalRouterInput = Readonly<{
  flowId: string
  userMessage: string
  goals: readonly V2Goal[]
  capsules?: readonly V2GoalCapsule[]
  recentTurns?: readonly Readonly<{ goalId?: string; user: string; assistant: string }>[]
  clarificationAnswer?: string
  parkedCandidateLimit?: number
  maxSecondaryGoalLinks?: number
  provider?: ModelProvider
  model?: V2GoalRouterModelSettings
}>

export type V2GoalRouterResult = Readonly<{
  decision: V2GoalRoutingDecision
  candidates: V2GoalRoutingCandidateSet
  source: "model" | "fallback"
  fallbackReason?: "structured_generation_unavailable" | "timeout" | "provider_error" | "invalid_output"
  modelAttempt?: Readonly<{
    providerId: ProviderId
    modelId: string
    status: "completed" | "failed"
    usage?: ModelUsage
    errorCode?: "timeout" | "provider_error" | "invalid_output"
  }>
}>

const ROUTER_SCHEMA = z
  .object({
    action: z.enum(["continue", "resume", "create", "clarify"]),
    primaryGoalId: z.string().nullable(),
    secondaryGoalIds: z.array(z.string()).max(MAX_V2_SECONDARY_GOAL_LINKS),
    confidence: z.number().min(0).max(1),
    clarificationQuestion: z.string().max(1_000).nullable(),
    clarificationGoalIds: z.array(z.string()).max(5),
  })
  .strict()

type StructuredRouterOutput = z.infer<typeof ROUTER_SCHEMA>

const ROUTER_SYSTEM_PROMPT = [
  "Route one user message inside a persistent Socrates Flow.",
  "Choose continue for the foreground focus, resume for one listed paused or recently finished focus, or create when none fits.",
  "The singleton General Conversation absorbs greetings, weather, recommendations, and other casual one-off talk; durable work gets its own focus.",
  "Use clarify only when at least two listed existing focuses are genuinely plausible, the message has no explicit reference, recent turns do not resolve it, confidence is low, and choosing wrong would materially matter.",
  "When clarifying, ask one short natural question and return two to five real candidate ids. Never clarify ordinary task ambiguity inside one focus.",
  "Always return every field. Use null for primaryGoalId or clarificationQuestion and [] for clarificationGoalIds when a field does not apply.",
  "Prefer continue when uncertainty is harmless. Never invent a goal id.",
  "Return only the structured fields. Do not return analysis, hidden reasoning, or chain of thought.",
].join(" ")

export const selectV2GoalRoutingCandidates = (input: {
  flowId: string
  userMessage: string
  goals: readonly V2Goal[]
  capsules?: readonly V2GoalCapsule[]
  parkedCandidateLimit?: number
}): V2GoalRoutingCandidateSet => {
  const goals = input.goals.filter((goal) => goal.flowId === input.flowId)
  const foregroundGoals = goals.filter((goal) => goal.status === "foreground").sort(compareGoalIdentity)
  if (foregroundGoals.length > 1) {
    throw new Error(`V2 Flow ${input.flowId} has more than one foreground goal.`)
  }

  const capsulesByGoal = latestCapsuleByGoal(input.capsules ?? [])
  const toCandidate = (goal: V2Goal): V2GoalRoutingCandidate => {
    const capsule = capsulesByGoal.get(goal.id)
    const lexicalScore = lexicalRoutingScore(input.userMessage, routingText(goal, capsule))
    return { goal, ...(capsule ? { capsule } : {}), lexicalScore }
  }
  const foreground = foregroundGoals[0] ? toCandidate(foregroundGoals[0]) : undefined
  const parkedCandidateLimit = clampInteger(
    input.parkedCandidateLimit ?? DEFAULT_V2_PARKED_GOAL_CANDIDATE_LIMIT,
    0,
    MAX_V2_PARKED_GOAL_CANDIDATE_LIMIT,
  )
  const eligibleParked = goals
    .filter((goal) => goal.status === "parked" || goal.status === "blocked" || goal.status === "completed")
    .map(toCandidate)
    .sort(compareRoutingCandidates)
  const parked = eligibleParked.slice(0, parkedCandidateLimit)
  const candidates = [...(foreground ? [foreground] : []), ...parked]
  return {
    ...(foreground ? { foreground } : {}),
    parked,
    candidates,
    totalEligibleParked: eligibleParked.length,
    parkedCandidateLimit,
  }
}

export const routeV2Goal = async (input: V2GoalRouterInput): Promise<V2GoalRouterResult> => {
  const candidates = selectV2GoalRoutingCandidates(input)
  const fallback = deterministicV2GoalRoutingFallback(input.userMessage, candidates, input.maxSecondaryGoalLinks)
  if (!input.provider?.generateStructured || !input.model) {
    return {
      decision: fallback,
      candidates,
      source: "fallback",
      fallbackReason: "structured_generation_unavailable",
    }
  }

  try {
    const generated = await generateWithTimeout(
      input.provider,
      buildStructuredRequest({ ...input, model: input.model }, candidates),
      input.model.timeoutMs ?? DEFAULT_V2_GOAL_ROUTER_TIMEOUT_MS,
    )
    const decision = validateStructuredDecision(
      generated.output,
      candidates,
      input.maxSecondaryGoalLinks ?? MAX_V2_SECONDARY_GOAL_LINKS,
    )
    if (!decision) {
      return {
        decision: fallback,
        candidates,
        source: "fallback",
        fallbackReason: "invalid_output",
        modelAttempt: {
          providerId: input.model.providerId,
          modelId: input.model.modelId,
          status: "completed",
          ...(generated.usage ? { usage: generated.usage } : {}),
          errorCode: "invalid_output",
        },
      }
    }
    return {
      decision,
      candidates,
      source: "model",
      modelAttempt: {
        providerId: input.model.providerId,
        modelId: input.model.modelId,
        status: "completed",
        ...(generated.usage ? { usage: generated.usage } : {}),
      },
    }
  } catch (error) {
    const errorCode = isTimeoutError(error) ? "timeout" as const : "provider_error" as const
    return {
      decision: fallback,
      candidates,
      source: "fallback",
      fallbackReason: errorCode,
      modelAttempt: {
        providerId: input.model.providerId,
        modelId: input.model.modelId,
        status: "failed",
        errorCode,
      },
    }
  }
}

export const deterministicV2GoalRoutingFallback = (
  userMessage: string,
  candidates: V2GoalRoutingCandidateSet,
  maxSecondaryGoalLinks = MAX_V2_SECONDARY_GOAL_LINKS,
): V2GoalRoutingDecision => {
  const explicitResume = /\b(?:resume|return to|go back to|continue with|switch to)\b/i.test(userMessage)
  const durableWork = /\b(?:implement|build|fix|change|update|refactor|review|analy[sz]e|research|prepare|inspect|report|presentation|deadline|project|repository|repo|code|files?|documents?|attachments?|images?|database|schema|test|deploy)\b/i.test(userMessage)
  const casualQuestion = /\b(?:hello|hi|hey|weather|restaurant|recommend|how are you|what'?s up|joke|chat)\b/i.test(userMessage)
  const generalCandidate = candidates.candidates.find((candidate) => candidate.goal.kind === "general")
  const bestParked = candidates.parked[0]
  if (bestParked && explicitResume && bestParked.lexicalScore > 0) {
    return {
      action: "resume",
      primaryGoalId: bestParked.goal.id,
      secondaryGoalIds: secondaryMatches(candidates, bestParked.goal.id, maxSecondaryGoalLinks),
      confidence: Math.max(0.55, bestParked.lexicalScore),
      reasonCode: "explicit_parked_match",
    }
  }
  if (candidates.foreground?.goal.kind === "general" && durableWork) {
    return { action: "create", secondaryGoalIds: [], confidence: 0.64, reasonCode: "new_goal" }
  }
  if (generalCandidate && candidates.foreground?.goal.kind !== "general" && casualQuestion && !durableWork) {
    return {
      action: "resume",
      primaryGoalId: generalCandidate.goal.id,
      secondaryGoalIds: [],
      confidence: 0.68,
      reasonCode: "explicit_parked_match",
    }
  }
  const strongParkedMatch = bestParked && bestParked.lexicalScore >= 0.5
  if (bestParked && !candidates.foreground && strongParkedMatch) {
    return {
      action: "resume",
      primaryGoalId: bestParked.goal.id,
      secondaryGoalIds: secondaryMatches(candidates, bestParked.goal.id, maxSecondaryGoalLinks),
      confidence: Math.max(0.55, bestParked.lexicalScore),
      reasonCode: "explicit_parked_match",
    }
  }
  if (candidates.foreground) {
    return {
      action: "continue",
      primaryGoalId: candidates.foreground.goal.id,
      secondaryGoalIds: secondaryMatches(candidates, candidates.foreground.goal.id, maxSecondaryGoalLinks),
      confidence: 0.5,
      reasonCode: "conservative_fallback",
    }
  }
  if (bestParked && strongParkedMatch) {
    return {
      action: "resume",
      primaryGoalId: bestParked.goal.id,
      secondaryGoalIds: secondaryMatches(candidates, bestParked.goal.id, maxSecondaryGoalLinks),
      confidence: bestParked.lexicalScore,
      reasonCode: "no_foreground",
    }
  }
  return { action: "create", secondaryGoalIds: [], confidence: 0.5, reasonCode: "new_goal" }
}

export const planV2GoalRoutingTransition = (input: {
  flowId: string
  goals: readonly V2Goal[]
  decision: V2GoalRoutingDecision
  createdGoalId?: string
  maxSecondaryGoalLinks?: number
}): V2GoalRoutingPlan => {
  if (input.decision.action === "clarify") {
    throw new Error("A clarification decision must be resolved before planning a foreground transition.")
  }
  const goals = input.goals.filter((goal) => goal.flowId === input.flowId)
  const currentForeground = goals.filter((goal) => goal.status === "foreground")
  if (currentForeground.length > 1) {
    throw new Error(`V2 Flow ${input.flowId} has more than one foreground goal.`)
  }
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]))
  const selectedId = input.decision.action === "create" ? input.createdGoalId : input.decision.primaryGoalId
  if (!selectedId) throw new Error("A created goal id or primary goal id is required to plan a foreground transition.")
  if (input.decision.action !== "create" && !goalsById.has(selectedId)) {
    throw new Error(`V2 goal ${selectedId} is not part of Flow ${input.flowId}.`)
  }
  if (input.decision.action === "continue" && currentForeground[0]?.id !== selectedId) {
    throw new Error("A continue decision must target the current foreground goal.")
  }
  if (input.decision.action === "resume") {
    const selected = goalsById.get(selectedId)
    if (!selected || (selected.status !== "parked" && selected.status !== "blocked" && selected.status !== "completed")) {
      throw new Error("A resume decision must target a paused or completed focus.")
    }
  }

  const transitions: Array<{ goalId: string; from: V2GoalStatus; to: V2GoalStatus }> = []
  const foreground = currentForeground[0]
  if (foreground && foreground.id !== selectedId) {
    transitions.push({ goalId: foreground.id, from: "foreground", to: "parked" })
  }
  const selected = goalsById.get(selectedId)
  if (selected && selected.status !== "foreground") {
    transitions.push({ goalId: selected.id, from: selected.status, to: "foreground" })
  }

  const maxSecondary = clampInteger(input.maxSecondaryGoalLinks ?? MAX_V2_SECONDARY_GOAL_LINKS, 0, MAX_V2_SECONDARY_GOAL_LINKS)
  const secondaryGoalIds = uniqueStrings(input.decision.secondaryGoalIds)
    .filter((id) => id !== selectedId && goalsById.has(id))
    .slice(0, maxSecondary)
  return {
    action: input.decision.action,
    foregroundGoalId: selectedId,
    createGoal: input.decision.action === "create",
    transitions,
    secondaryGoalIds,
  }
}

const buildStructuredRequest = (
  input: V2GoalRouterInput & { model: V2GoalRouterModelSettings },
  candidates: V2GoalRoutingCandidateSet,
): StructuredModelRequest<StructuredRouterOutput> => ({
  providerId: input.model.providerId,
  modelId: input.model.modelId,
  system: ROUTER_SYSTEM_PROMPT,
  messages: [{ role: "user", content: JSON.stringify(routerPayload(input, candidates)) }],
  runtimeConfig: routerRuntimeConfig(input.model),
  schema: ROUTER_SCHEMA,
})

const routerPayload = (input: V2GoalRouterInput, candidates: V2GoalRoutingCandidateSet) => ({
  userMessage: truncate(input.userMessage, 6_000),
  ...(input.clarificationAnswer ? { clarificationAnswer: truncate(input.clarificationAnswer, 2_000) } : {}),
  recentTurns: (input.recentTurns ?? []).slice(-3).map((turn) => ({
    ...(turn.goalId ? { goalId: turn.goalId } : {}),
    user: truncate(turn.user, 600),
    assistant: truncate(turn.assistant, 800),
  })),
  foregroundGoalId: candidates.foreground?.goal.id ?? null,
  candidates: candidates.candidates.map((candidate) => ({
    id: candidate.goal.id,
    status: candidate.goal.status,
    kind: candidate.goal.kind,
    title: truncate(candidate.goal.title, 180),
    summary: truncate(candidate.goal.summary ?? "", 600),
    capsule: candidate.capsule
      ? {
          summary: truncate(candidate.capsule.summary, 800),
          decisions: candidate.capsule.decisions.slice(0, 5).map((value) => truncate(value, 240)),
          nextActions: candidate.capsule.nextActions.slice(0, 5).map((value) => truncate(value, 240)),
          openQuestions: candidate.capsule.openQuestions.slice(0, 5).map((value) => truncate(value, 240)),
        }
      : null,
  })),
})

const routerRuntimeConfig = (model: V2GoalRouterModelSettings): RuntimeConfig => ({
  providerId: model.providerId,
  authMode: model.authMode ?? "api_key",
  modelId: model.modelId,
  thinkingEnabled: model.thinkingEnabled ?? false,
  ...(model.thinkingEffort ? { thinkingEffort: model.thinkingEffort } : model.thinkingEnabled ? {} : { thinkingEffort: "none" }),
  approvalMode: "read_only_auto",
  sandboxMode: "read_only",
})

const validateStructuredDecision = (
  output: unknown,
  candidates: V2GoalRoutingCandidateSet,
  maxSecondaryGoalLinks: number,
): V2GoalRoutingDecision | undefined => {
  if (!output || typeof output !== "object") return undefined
  const parsed = ROUTER_SCHEMA.safeParse(output)
  if (!parsed.success) return undefined
  const value = parsed.data
  if (value.action !== "continue" && value.action !== "resume" && value.action !== "create" && value.action !== "clarify") return undefined
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return undefined
  if (!Array.isArray(value.secondaryGoalIds) || !value.secondaryGoalIds.every((id) => typeof id === "string")) return undefined
  const candidateById = new Map(candidates.candidates.map((candidate) => [candidate.goal.id, candidate]))
  const primaryGoalId = typeof value.primaryGoalId === "string" ? value.primaryGoalId : undefined
  if (value.action === "clarify") {
    if (typeof value.clarificationQuestion !== "string" || !value.clarificationQuestion.trim()) return undefined
    if (!Array.isArray(value.clarificationGoalIds) || !value.clarificationGoalIds.every((id) => typeof id === "string")) return undefined
    const clarificationGoalIds = uniqueStrings(value.clarificationGoalIds as string[])
      .filter((id) => candidateById.has(id))
      .slice(0, 5)
    if (clarificationGoalIds.length < 2) return undefined
    return {
      action: "clarify",
      secondaryGoalIds: [],
      confidence: value.confidence,
      clarificationQuestion: truncate(value.clarificationQuestion.trim(), 1_000),
      clarificationGoalIds,
      reasonCode: "ambiguous_focus",
    }
  }
  if (value.action === "continue" && (!primaryGoalId || candidates.foreground?.goal.id !== primaryGoalId)) return undefined
  if (value.action === "resume" && (!primaryGoalId || !candidates.parked.some((candidate) => candidate.goal.id === primaryGoalId))) return undefined
  if (value.action === "create" && primaryGoalId) return undefined
  const maxSecondary = clampInteger(maxSecondaryGoalLinks, 0, MAX_V2_SECONDARY_GOAL_LINKS)
  const secondaryGoalIds = uniqueStrings(value.secondaryGoalIds as string[])
    .filter((id) => id !== primaryGoalId && candidateById.has(id))
    .slice(0, maxSecondary)
  return {
    action: value.action,
    ...(primaryGoalId ? { primaryGoalId } : {}),
    secondaryGoalIds,
    confidence: value.confidence,
    reasonCode: value.action === "create" ? "new_goal" : "model_match",
  }
}

const generateWithTimeout = async <TOutput>(
  provider: ModelProvider,
  request: StructuredModelRequest<TOutput>,
  requestedTimeoutMs: number,
): Promise<StructuredModelResult<TOutput>> => {
  const generateStructured = provider.generateStructured
  if (!generateStructured) throw new Error("structured_generation_unavailable")
  const timeoutMs = clampInteger(requestedTimeoutMs, 50, 30_000)
  const controller = new AbortController()
  const bound = generateStructured.bind(provider) as <T>(request: StructuredModelRequest<T>) => Promise<StructuredModelResult<T>>
  const providerPromise = bound<TOutput>({ ...request, abortSignal: controller.signal })
  let timeout: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new V2GoalRouterTimeoutError())
    }, timeoutMs)
  })
  try {
    try {
      return await Promise.race([providerPromise, timeoutPromise])
    } catch (error) {
      if (timedOut) throw new V2GoalRouterTimeoutError()
      throw error
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    void providerPromise.catch(() => undefined)
  }
}

class V2GoalRouterTimeoutError extends Error {}
const isTimeoutError = (error: unknown): boolean => error instanceof V2GoalRouterTimeoutError

const routingText = (goal: V2Goal, capsule?: V2GoalCapsule): string =>
  [
    goal.title,
    goal.summary,
    capsule?.summary,
    ...(capsule?.decisions ?? []),
    ...(capsule?.nextActions ?? []),
    ...(capsule?.openQuestions ?? []),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")

const lexicalRoutingScore = (query: string, candidateText: string): number => {
  const queryTokens = contentTokens(query)
  if (queryTokens.length === 0) return 0
  const candidateTokens = new Set(contentTokens(candidateText))
  const overlap = queryTokens.filter((token) => candidateTokens.has(token)).length
  return Number((overlap / queryTokens.length).toFixed(6))
}

const contentTokens = (value: string): string[] =>
  uniqueStrings(
    value
      .toLocaleLowerCase()
      .normalize("NFKC")
      .match(/[\p{L}\p{N}_-]{3,}/gu) ?? [],
  ).filter((token) => !STOP_WORDS.has(token))

const STOP_WORDS = new Set(["about", "again", "could", "from", "have", "into", "please", "that", "this", "what", "when", "where", "with", "would"])

const compareRoutingCandidates = (left: V2GoalRoutingCandidate, right: V2GoalRoutingCandidate): number =>
  right.lexicalScore - left.lexicalScore ||
  Date.parse(right.goal.updatedAt) - Date.parse(left.goal.updatedAt) ||
  left.goal.id.localeCompare(right.goal.id)

const compareGoalIdentity = (left: V2Goal, right: V2Goal): number => left.id.localeCompare(right.id)

const latestCapsuleByGoal = (capsules: readonly V2GoalCapsule[]): Map<string, V2GoalCapsule> => {
  const latest = new Map<string, V2GoalCapsule>()
  for (const capsule of capsules) {
    const current = latest.get(capsule.goalId)
    if (!current || capsule.version > current.version || (capsule.version === current.version && capsule.id.localeCompare(current.id) > 0)) {
      latest.set(capsule.goalId, capsule)
    }
  }
  return latest
}

const secondaryMatches = (candidates: V2GoalRoutingCandidateSet, primaryGoalId: string, limit: number): string[] =>
  candidates.candidates
    .filter((candidate) => candidate.goal.id !== primaryGoalId && candidate.lexicalScore >= 0.35)
    .slice(0, clampInteger(limit, 0, MAX_V2_SECONDARY_GOAL_LINKS))
    .map((candidate) => candidate.goal.id)

const uniqueStrings = (values: readonly string[]): string[] => [...new Set(values)]
const truncate = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`)
const clampInteger = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? value : min)))
