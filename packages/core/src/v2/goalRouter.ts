import { type ProviderAuthMode, type ProviderId, type ThinkingEffort, type V2GoalRouterOutput } from "@socrates/contracts"
import type { ModelProvider, ModelUsage } from "@socrates/providers"
import { normalizeError } from "@socrates/shared"
import { GoalRouterAgent } from "../agent/GoalRouterAgent"
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
export const MAX_V2_PARKED_GOAL_CANDIDATE_LIMIT = 5
export const DEFAULT_V2_GOAL_ROUTER_TIMEOUT_MS = 8_000

export type V2GoalRouterModelSettings = Readonly<{
  providerId: ProviderId
  authMode?: ProviderAuthMode
  modelId: string
  thinkingEnabled: boolean
  thinkingEffort?: ThinkingEffort
  timeoutMs?: number
}>

export type V2GoalRouterInput = Readonly<{
  projectId: string
  flowId: string
  turnId: string
  workspacePath: string
  userMessage: string
  goals: readonly V2Goal[]
  capsules?: readonly V2GoalCapsule[]
  recentTurns?: readonly Readonly<{ goalId?: string; user: string; assistant: string }>[]
  clarificationAnswer?: string
  parkedCandidateLimit?: number
  candidateGoalIds?: readonly string[]
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
    startedAt: string
    completedAt: string
    durationMs: number
    usage?: ModelUsage
    errorCode?: "timeout" | "provider_error" | "invalid_output"
    errorMessage?: string
  }>
}>

export const selectV2GoalRoutingCandidates = (input: {
  flowId: string
  userMessage: string
  goals: readonly V2Goal[]
  capsules?: readonly V2GoalCapsule[]
  parkedCandidateLimit?: number
  candidateGoalIds?: readonly string[]
}): V2GoalRoutingCandidateSet => {
  const goals = input.goals.filter((goal) => goal.flowId === input.flowId)
  const foregroundGoals = goals.filter((goal) => goal.status === "foreground").sort(compareGoalIdentity)
  if (foregroundGoals.length > 1) {
    throw new Error(`V2 Flow ${input.flowId} has more than one foreground goal.`)
  }

  const capsulesByGoal = latestCapsuleByGoal(input.capsules ?? [])
  const toCandidate = (goal: V2Goal, candidate: number): V2GoalRoutingCandidate => {
    const capsule = capsulesByGoal.get(goal.id)
    return { goal, ...(capsule ? { capsule } : {}), candidate }
  }
  const parkedCandidateLimit = clampInteger(
    input.parkedCandidateLimit ?? DEFAULT_V2_PARKED_GOAL_CANDIDATE_LIMIT,
    0,
    MAX_V2_PARKED_GOAL_CANDIDATE_LIMIT,
  )
  const eligibleParked = goals
    .filter((goal) => goal.status === "parked" || goal.status === "blocked" || goal.status === "completed" || goal.status === "discarded")
    .sort(compareRecentGoals)
  const parkedById = new Map(eligibleParked.map((goal) => [goal.id, goal]))
  const retrieved = uniqueStrings(input.candidateGoalIds ?? []).flatMap((goalId) => {
    const goal = parkedById.get(goalId)
    return goal ? [goal] : []
  })
  const orderedParked = [...retrieved, ...eligibleParked.filter((goal) => !retrieved.some((item) => item.id === goal.id))]
  const foregroundGoal = foregroundGoals[0]
  const totalLimit = Math.min(5, parkedCandidateLimit)
  const selectedGoals = [...(foregroundGoal ? [foregroundGoal] : []), ...orderedParked]
    .filter((goal, index, all) => all.findIndex((candidate) => candidate.id === goal.id) === index)
    .slice(0, totalLimit)
  const candidates = selectedGoals.map((goal, index) => toCandidate(goal, index + 1))
  const foreground = foregroundGoal ? candidates.find((candidate) => candidate.goal.id === foregroundGoal.id) : undefined
  const parked = candidates.filter((candidate) => candidate.goal.id !== foregroundGoal?.id)
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
  const fallback = deterministicV2GoalRoutingFallback(input.userMessage, candidates)
  if (!input.provider?.generateStructured || !input.model) {
    return {
      decision: fallback,
      candidates,
      source: "fallback",
      fallbackReason: "structured_generation_unavailable",
    }
  }

  const observedUsages: ModelUsage[] = []
  const controller = new AbortController()
  const startedAt = new Date().toISOString()
  const startedAtMs = Date.now()
  try {
    const output = await runWithTimeout(
      new GoalRouterAgent(input.provider).route({
        modelSettings: input.model,
        projectId: input.projectId,
        flowId: input.flowId,
        turnId: input.turnId,
        workspacePath: input.workspacePath,
        userMessage: input.userMessage,
        candidates,
        ...(input.recentTurns ? { recentTurns: input.recentTurns } : {}),
        ...(input.clarificationAnswer ? { clarificationAnswer: input.clarificationAnswer } : {}),
        cacheKey: `v2:${input.flowId}:goal-router:${input.turnId}`,
        abortSignal: controller.signal,
        onUsage: (usage) => observedUsages.push(usage),
      }),
      input.model.timeoutMs ?? DEFAULT_V2_GOAL_ROUTER_TIMEOUT_MS,
      controller,
    )
    const usage = aggregateUsages(observedUsages)
    const completedAt = new Date().toISOString()
    return {
      decision: toRoutingDecision(output, candidates),
      candidates,
      source: "model",
      modelAttempt: {
        providerId: input.model.providerId,
        modelId: input.model.modelId,
        status: "completed",
        startedAt,
        completedAt,
        durationMs: Date.now() - startedAtMs,
        ...(usage ? { usage } : {}),
      },
    }
  } catch (error) {
    const normalized = normalizeError(error)
    const errorCode = isTimeoutError(error)
      ? "timeout" as const
      : normalized.code === "structured_agent_output_invalid"
        ? "invalid_output" as const
        : "provider_error" as const
    const usage = aggregateUsages(observedUsages)
    const completedAt = new Date().toISOString()
    return {
      decision: fallback,
      candidates,
      source: "fallback",
      fallbackReason: errorCode,
      modelAttempt: {
        providerId: input.model.providerId,
        modelId: input.model.modelId,
        status: "failed",
        startedAt,
        completedAt,
        durationMs: Date.now() - startedAtMs,
        ...(usage ? { usage } : {}),
        errorCode,
        errorMessage: normalized.message,
      },
    }
  }
}

export const deterministicV2GoalRoutingFallback = (
  userMessage: string,
  candidates: V2GoalRoutingCandidateSet,
): V2GoalRoutingDecision => {
  if (candidates.foreground) {
    return {
      action: "continue",
      primaryGoalId: candidates.foreground.goal.id,
    }
  }
  return { action: "create", title: fallbackGoalTitle(userMessage) }
}

export const planV2GoalRoutingTransition = (input: {
  flowId: string
  goals: readonly V2Goal[]
  decision: V2GoalRoutingDecision
  createdGoalId?: string
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
    if (!selected || (selected.status !== "parked" && selected.status !== "blocked" && selected.status !== "completed" && selected.status !== "discarded")) {
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

  return {
    action: input.decision.action,
    foregroundGoalId: selectedId,
    createGoal: input.decision.action === "create",
    transitions,
  }
}

const toRoutingDecision = (value: V2GoalRouterOutput, candidates: V2GoalRoutingCandidateSet): V2GoalRoutingDecision => {
  const candidateByNumber = new Map(candidates.candidates.map((candidate) => [candidate.candidate, candidate]))
  if (value.action === "clarify") {
    const selected = value.candidates.flatMap((candidate) => {
      const match = candidateByNumber.get(candidate)
      return match ? [match] : []
    })
    return {
      action: "clarify",
      clarificationQuestion: buildClarificationQuestion(selected),
      clarificationGoalIds: selected.map((candidate) => candidate.goal.id),
    }
  }
  if (value.action === "create") return { action: "create", title: value.title?.trim() || "New focus" }
  const selected = candidateByNumber.get(value.candidates[0] ?? -1)
  if (!selected) throw new Error("The Goal Router selected an unavailable candidate.")
  return {
    action: selected.goal.id === candidates.foreground?.goal.id ? "continue" : "resume",
    primaryGoalId: selected.goal.id,
  }
}

const runWithTimeout = async <TOutput>(
  run: Promise<TOutput>,
  requestedTimeoutMs: number,
  controller: AbortController,
): Promise<TOutput> => {
  const timeoutMs = clampInteger(requestedTimeoutMs, 50, 30_000)
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
      return await Promise.race([run, timeoutPromise])
    } catch (error) {
      if (timedOut) throw new V2GoalRouterTimeoutError()
      throw error
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    void run.catch(() => undefined)
  }
}

class V2GoalRouterTimeoutError extends Error {}
const isTimeoutError = (error: unknown): boolean => error instanceof V2GoalRouterTimeoutError

const aggregateUsages = (usages: readonly ModelUsage[]): ModelUsage | undefined => {
  if (usages.length === 0) return undefined
  const sum = (field: keyof ModelUsage): number | undefined => {
    const values = usages.map((usage) => usage[field]).filter((value): value is number => typeof value === "number")
    return values.length ? values.reduce((total, value) => total + value, 0) : undefined
  }
  const inputTokens = sum("inputTokens")
  const outputTokens = sum("outputTokens")
  const reasoningTokens = sum("reasoningTokens")
  const cachedInputTokens = sum("cachedInputTokens")
  const cacheWriteTokens = sum("cacheWriteTokens")
  const uncachedInputTokens = sum("uncachedInputTokens")
  const totalTokens = sum("totalTokens")
  const costUsd = sum("costUsd")
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
    raw: { attempts: usages.map((usage) => usage.raw ?? usage.providerMetadata ?? null) },
  }
}

const compareRecentGoals = (left: V2Goal, right: V2Goal): number =>
  Date.parse(right.lastActiveAt) - Date.parse(left.lastActiveAt) ||
  Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
  left.id.localeCompare(right.id)

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

const buildClarificationQuestion = (candidates: readonly V2GoalRoutingCandidate[]): string => {
  const titles = candidates.map((candidate) => `“${truncate(candidate.goal.title, 80)}”`)
  if (titles.length === 2) return `Should I continue ${titles[0]} or ${titles[1]}?`
  return `Which focus should I continue: ${titles.join(", ")}?`
}

const fallbackGoalTitle = (userMessage: string): string => {
  const oneLine = userMessage.replace(/\s+/g, " ").trim()
  return truncate(oneLine || "New focus", 120)
}

const uniqueStrings = (values: readonly string[]): string[] => [...new Set(values)]
const truncate = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`)
const clampInteger = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? value : min)))
