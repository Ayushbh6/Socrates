import { z } from "zod"
import {
  applyV2ContextDispositions,
  classifyV2ContextPressure,
  deriveV2ContextBudget,
  getV2ContextReviewRequirements,
  type ImmutableEvidenceRecord,
  type V2ContextDispositionDecision,
  type V2ContextItem as CoreV2ContextItem,
  type V2ContextPressure,
  type V2ContextState,
} from "@socrates/core"
import type {
  RuntimeConfig,
  V2ContextDisposition,
  V2ContextItem,
  V2RuntimeConfig,
} from "@socrates/contracts"
import type { ModelProvider, ModelUsage } from "@socrates/providers"
import { normalizeError, SocratesError } from "@socrates/shared"
import type { V2ContextPersistenceDecision, V2FlowStore } from "./flowStore"

const dispositionOutputSchema = z.object({
  decisions: z.array(z.object({
    contextItemId: z.string().min(1),
    disposition: z.enum(["keep_exact", "distill", "release", "unresolved"]),
    distilledText: z.string().max(8_000).optional(),
  }).strict()).max(64),
}).strict()

const compactionOutputSchema = z.object({
  summary: z.string().min(1).max(12_000),
  sourceContextItemIds: z.array(z.string().min(1)).max(64),
}).strict()

const DEFAULT_MODEL_TIMEOUT_MS = 3_000
const DEFAULT_MAX_MODEL_CANDIDATES = 24
const MAX_ITEM_EXCERPT_CHARS = 2_000
const MAX_DISTILLED_CHARS = 6_000
const MAX_COMPACTION_SOURCE_ITEMS = 64

type MaintenanceSource = "context_distiller" | "context_compactor" | "policy"

export type V2ContextMaintenanceEvent = Readonly<{
  type: "v2.context.disposition.updated"
  payload: Readonly<{ contextItem: V2ContextItem; disposition: V2ContextDisposition }>
  source: MaintenanceSource
}>

export type V2ContextMaintenanceResult = Readonly<{
  status: "no_work" | "completed" | "degraded"
  pressure: V2ContextPressure
  usedTokensBefore: number
  usedTokensAfter: number
  dispositionCount: number
  compactionPerformed: boolean
  deterministicFallbackUsed: boolean
  failureCodes: readonly string[]
  events: readonly V2ContextMaintenanceEvent[]
}>

/**
 * Provider/model selection for the bounded post-turn context worker.
 *
 * This is deliberately separate from the foreground V2 runtime config: the
 * latter remains authoritative for context-window budgeting and execution
 * policy, while this selection is authoritative for every distiller/compactor
 * model call.
 */
export type V2ContextMaintenanceWorkerRuntime = Readonly<{
  providerId: RuntimeConfig["providerId"]
  authMode?: RuntimeConfig["authMode"]
  modelId: string
  thinkingEnabled: boolean
  thinkingEffort?: RuntimeConfig["thinkingEffort"]
}>

export type V2ContextMaintenanceInput = Readonly<{
  projectId: string
  flowId: string
  goalId: string
  turnId: string
  completedTurnOrdinal: number
  query: string
  runtimeConfig: V2RuntimeConfig
  workerRuntime?: V2ContextMaintenanceWorkerRuntime
  contextWindowTokens?: number
}>

export type V2ContextMaintenanceDeps = Readonly<{
  store: V2FlowStore
  provider?: ModelProvider
  modelTimeoutMs?: number
  maxModelCandidates?: number
}>

type Candidate = Readonly<{
  item: CoreV2ContextItem
  evidence: ImmutableEvidenceRecord
  content: string
  tokens: number
  relevance: number
  due: boolean
  isNew: boolean
}>

type DecisionWithSource = V2ContextPersistenceDecision & Readonly<{ source: MaintenanceSource }>

type StructuredCallResult<T> = Readonly<{
  output?: T
  modelCallId?: string
  failureCode?: string
}>

/**
 * Runs bounded post-turn maintenance for Seamless Flow only.
 *
 * Exact evidence is never updated or deleted. The service changes only the
 * active context projection and appends any derived distillation/compaction as
 * new immutable V2 evidence.
 */
export class V2ContextMaintenanceService {
  private readonly timeoutMs: number
  private readonly maxModelCandidates: number

  constructor(private readonly deps: V2ContextMaintenanceDeps) {
    this.timeoutMs = boundedInteger(deps.modelTimeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS, 250, 10_000)
    this.maxModelCandidates = boundedInteger(deps.maxModelCandidates ?? DEFAULT_MAX_MODEL_CANDIDATES, 5, 64)
  }

  async runAfterTurn(input: V2ContextMaintenanceInput): Promise<V2ContextMaintenanceResult> {
    let pressure: V2ContextPressure = "comfortable"
    let usedTokensBefore = 0
    const failureCodes: string[] = []
    let fallbackUsed = false
    try {
      const budget = deriveV2ContextBudget({
        contextWindowTokens: Math.max(2_048, input.contextWindowTokens ?? input.runtimeConfig.contextWindowTokens ?? 128_000),
      })
      let state = this.deps.store.getActiveCoreContextState(input.flowId)
      const scoped = scopedActiveItems(state, input.goalId)
      usedTokensBefore = estimateActiveTokens(state, scoped.map((item) => item.id))
      pressure = classifyV2ContextPressure(usedTokensBefore, budget)
      const candidates = selectCandidates({
        state,
        goalId: input.goalId,
        query: input.query,
        completedTurn: input.completedTurnOrdinal,
        pressure,
        limit: 64,
      })
      if (candidates.length === 0) {
        return emptyResult(pressure, usedTokensBefore)
      }

      const distillerCall = await this.callDistiller(input, pressure, candidates.slice(0, this.maxModelCandidates))
      if (distillerCall.failureCode) {
        failureCodes.push(distillerCall.failureCode)
        fallbackUsed = true
      }
      let decisions = normalizeDispositionDecisions({
        state,
        candidates,
        query: input.query,
        pressure,
        ...(distillerCall.output ? { modelOutput: distillerCall.output } : {}),
      })
      fallbackUsed ||= decisions.some((decision) => decision.source === "policy")

      let compactionPerformed = false
      if (pressure === "compact" || pressure === "hard_limit") {
        const compactionSources = selectCompactionSources({
          state,
          goalId: input.goalId,
          query: input.query,
          usedTokens: usedTokensBefore,
          targetTokens: budget.postCompactionTargetTokens,
        })
        if (compactionSources.length > 0) {
          const compactorCall = await this.callCompactor(input, pressure, compactionSources)
          if (compactorCall.failureCode) {
            failureCodes.push(compactorCall.failureCode)
            fallbackUsed = true
          }
          const summary = normalizeCompactionSummary(
            compactorCall.output?.summary,
            compactionSources,
            input.query,
          )
          const sourceIds = normalizeCompactionSourceIds(compactorCall.output?.sourceContextItemIds, compactionSources)
          const recorded = this.deps.store.recordEvidence({
            projectId: input.projectId,
            flowId: input.flowId,
            goalId: input.goalId,
            turnId: input.turnId,
            sourceKind: "model_output",
            ...(compactorCall.modelCallId ? { sourceId: compactorCall.modelCallId } : {}),
            title: `Flow context compaction after turn ${input.completedTurnOrdinal}`,
            content: summary,
            locator: {
              kind: "v2_context_compaction",
              sourceContextItemIds: sourceIds,
              sourceEvidenceHandles: compactionSources.map((candidate) => candidate.evidence.ref.sourceLocator),
              completedTurnOrdinal: input.completedTurnOrdinal,
            },
            rank: 10,
          })
          if (recorded.contextItem) {
            const byId = new Map(decisions.map((decision) => [decision.contextItemId, decision]))
            for (const sourceId of sourceIds) {
              byId.set(sourceId, {
                contextItemId: sourceId,
                disposition: "release",
                decidedBy: "distiller",
                reason: "Replaced by an immutable V2 context compaction.",
                replacementContextItemId: recorded.contextItem.id,
                source: "context_compactor",
              })
            }
            byId.set(recorded.contextItem.id, {
              contextItemId: recorded.contextItem.id,
              disposition: "keep_exact",
              decidedBy: "distiller",
              reason: "Immutable V2 context compaction retained in active context.",
              source: "context_compactor",
            })
            decisions = [...byId.values()]
            compactionPerformed = true
            state = this.deps.store.getActiveCoreContextState(input.flowId)
          }
        }
      }

      decisions = enforcePressureTarget({
        state,
        goalId: input.goalId,
        query: input.query,
        decisions,
        completedTurn: input.completedTurnOrdinal,
        targetTokens: pressure === "comfortable"
          ? Number.POSITIVE_INFINITY
          : pressure === "prune"
            ? budget.postPruneTargetTokens
            : budget.postCompactionTargetTokens,
      })
      fallbackUsed ||= decisions.some((decision) => decision.source === "policy")

      // The pure policy is the authority for unresolved count and deadline.
      // Run it before any mutable projection row is written.
      applyV2ContextDispositions({
        state,
        decisions: decisions.map(baseDecision),
        completedTurn: input.completedTurnOrdinal,
      })

      for (const decision of decisions) {
        if (decision.disposition !== "distill" || !decision.distilledText) continue
        const sourceItem = state.items.find((item) => item.id === decision.contextItemId)
        this.deps.store.recordEvidence({
          projectId: input.projectId,
          flowId: input.flowId,
          ...(sourceItem?.goalId ? { goalId: sourceItem.goalId } : {}),
          turnId: input.turnId,
          sourceKind: "model_output",
          ...(distillerCall.modelCallId ? { sourceId: distillerCall.modelCallId } : {}),
          title: `Flow context distillation for ${decision.contextItemId}`,
          content: decision.distilledText,
          locator: {
            kind: "v2_context_distillation",
            sourceContextItemId: decision.contextItemId,
            sourceEvidenceHandle: sourceItem?.evidenceRef.sourceLocator,
            completedTurnOrdinal: input.completedTurnOrdinal,
          },
          includeInContext: false,
        })
      }

      const persisted = this.deps.store.persistContextDispositions({
        projectId: input.projectId,
        flowId: input.flowId,
        goalId: input.goalId,
        turnId: input.turnId,
        decisions,
        completedTurn: input.completedTurnOrdinal,
      })
      const sourceByItem = new Map(decisions.map((decision) => [decision.contextItemId, decision.source]))
      const events: V2ContextMaintenanceEvent[] = persisted.map((disposition) => ({
        type: "v2.context.disposition.updated",
        payload: {
          contextItem: this.deps.store.getContextItem(input.flowId, disposition.contextItemId),
          disposition,
        },
        source: sourceByItem.get(disposition.contextItemId) ?? "policy",
      }))
      const finalState = this.deps.store.getActiveCoreContextState(input.flowId)
      const finalScopedIds = scopedActiveItems(finalState, input.goalId).map((item) => item.id)
      return {
        status: failureCodes.length > 0 ? "degraded" : "completed",
        pressure,
        usedTokensBefore,
        usedTokensAfter: estimateActiveTokens(finalState, finalScopedIds),
        dispositionCount: persisted.length,
        compactionPerformed,
        deterministicFallbackUsed: fallbackUsed,
        failureCodes: unique(failureCodes),
        events,
      }
    } catch (error) {
      const normalized = normalizeError(error)
      failureCodes.push(normalized.code)
      // Context maintenance is advisory. Never turn a successful Socrates
      // answer into a failed user turn because pruning could not finish.
      return {
        status: "degraded",
        pressure,
        usedTokensBefore,
        usedTokensAfter: usedTokensBefore,
        dispositionCount: 0,
        compactionPerformed: false,
        deterministicFallbackUsed: true,
        failureCodes: unique(failureCodes),
        events: [],
      }
    }
  }

  private async callDistiller(
    input: V2ContextMaintenanceInput,
    pressure: V2ContextPressure,
    candidates: readonly Candidate[],
  ): Promise<StructuredCallResult<z.infer<typeof dispositionOutputSchema>>> {
    return this.structuredCall({
      input,
      role: "context_distiller",
      schema: dispositionOutputSchema,
      system: [
        "You are the Socrates V2 context distiller.",
        "Decide only what remains in the next model request; immutable evidence is never deleted.",
        "For every supplied context item return exactly one of keep_exact, distill, release, or unresolved.",
        "Use unresolved sparingly. An item marked dueForReview must not remain unresolved.",
        "For distill, return only query-relevant facts plus the supplied exact evidence handle.",
        "Do not return rationale, chain of thought, or fields outside the schema.",
      ].join("\n"),
      user: JSON.stringify({
        currentQuery: input.query,
        pressure,
        completedTurnOrdinal: input.completedTurnOrdinal,
        items: candidates.map((candidate) => ({
          contextItemId: candidate.item.id,
          goalId: candidate.item.goalId,
          evidenceHandle: candidate.evidence.ref.sourceLocator,
          tokenEstimate: candidate.tokens,
          dueForReview: candidate.due,
          contentExcerpt: excerpt(candidate.content, MAX_ITEM_EXCERPT_CHARS),
        })),
      }),
      requestAudit: {
        phase: "post_turn_context_disposition",
        pressure,
        completedTurnOrdinal: input.completedTurnOrdinal,
        candidateItems: candidates.map((candidate) => ({
          contextItemId: candidate.item.id,
          evidenceHandle: candidate.evidence.ref.sourceLocator,
          tokenEstimate: candidate.tokens,
          dueForReview: candidate.due,
        })),
      },
    })
  }

  private async callCompactor(
    input: V2ContextMaintenanceInput,
    pressure: V2ContextPressure,
    sources: readonly Candidate[],
  ): Promise<StructuredCallResult<z.infer<typeof compactionOutputSchema>>> {
    return this.structuredCall({
      input,
      role: "context_compactor",
      schema: compactionOutputSchema,
      system: [
        "You are the Socrates V2 context compactor.",
        "Produce a compact working summary for the current goal from the supplied items.",
        "Preserve exact evidence handles, concrete facts, decisions, constraints, and unresolved questions.",
        "The source evidence remains immutable and retrievable; do not claim it was deleted.",
        "Return only the compact summary and covered context item ids. Do not return rationale or chain of thought.",
      ].join("\n"),
      user: JSON.stringify({
        currentQuery: input.query,
        pressure,
        completedTurnOrdinal: input.completedTurnOrdinal,
        items: sources.slice(0, this.maxModelCandidates).map((candidate) => ({
          contextItemId: candidate.item.id,
          evidenceHandle: candidate.evidence.ref.sourceLocator,
          contentExcerpt: excerpt(candidate.content, MAX_ITEM_EXCERPT_CHARS),
        })),
        allSourceContextItemIds: sources.map((candidate) => candidate.item.id),
        allSourceEvidenceHandles: sources.map((candidate) => candidate.evidence.ref.sourceLocator),
      }),
      requestAudit: {
        phase: "post_turn_context_compaction",
        pressure,
        completedTurnOrdinal: input.completedTurnOrdinal,
        sourceItems: sources.map((candidate) => ({
          contextItemId: candidate.item.id,
          evidenceHandle: candidate.evidence.ref.sourceLocator,
          tokenEstimate: candidate.tokens,
        })),
      },
    })
  }

  private async structuredCall<T>(input: {
    input: V2ContextMaintenanceInput
    role: "context_distiller" | "context_compactor"
    schema: z.ZodType<T>
    system: string
    user: string
    requestAudit: Readonly<Record<string, unknown>>
  }): Promise<StructuredCallResult<T>> {
    const provider = this.deps.provider
    const workerRuntime = input.input.workerRuntime
    if (!provider?.generateStructured || !workerRuntime) return { failureCode: `${input.role}_model_unavailable` }
    const modelCallId = this.deps.store.createModelCall({
      projectId: input.input.projectId,
      flowId: input.input.flowId,
      goalId: input.input.goalId,
      turnId: input.input.turnId,
      role: input.role,
      providerId: workerRuntime.providerId,
      modelId: workerRuntime.modelId,
      request: {
        ...input.requestAudit,
        workerRuntime: workerRuntimeAudit(workerRuntime),
      },
    })
    const controller = new AbortController()
    try {
      const result = await withTimeout(
        provider.generateStructured<T>({
          providerId: workerRuntime.providerId,
          modelId: workerRuntime.modelId,
          sessionId: input.input.flowId,
          cacheKey: `${input.input.flowId}:${input.role}`,
          runtimeConfig: providerRuntimeConfig(workerRuntime, input.input.runtimeConfig),
          system: input.system,
          messages: [{ role: "user", content: input.user }],
          schema: input.schema,
          abortSignal: controller.signal,
        }),
        this.timeoutMs,
        controller,
        input.role,
      )
      const parsed = input.schema.safeParse(result.output)
      if (!parsed.success) throw new SocratesError(`${input.role}_output_invalid`, `The V2 ${input.role} returned invalid structured output.`, { recoverable: true })
      this.deps.store.completeModelCall({ modelCallId, response: parsed.data })
      if (result.usage) recordSanitizedUsage(this.deps.store, modelCallId, result.usage)
      return { output: parsed.data, modelCallId }
    } catch (error) {
      controller.abort()
      const normalized = normalizeError(error)
      const persisted = this.deps.store.recordError({
        projectId: input.input.projectId,
        flowId: input.input.flowId,
        goalId: input.input.goalId,
        turnId: input.input.turnId,
        source: input.role,
        code: normalized.code,
        message: `V2 ${input.role} failed; the deterministic context policy fallback was used.`,
        recoverable: true,
      })
      this.deps.store.completeModelCall({ modelCallId, errorId: persisted.id })
      return { modelCallId, failureCode: normalized.code }
    }
  }
}

const selectCandidates = (input: {
  state: V2ContextState
  goalId: string
  query: string
  completedTurn: number
  pressure: V2ContextPressure
  limit: number
}): Candidate[] => {
  const review = getV2ContextReviewRequirements(input.state.items, input.completedTurn)
  const dueIds = new Set(review.dueNowIds)
  const evidenceById = new Map(input.state.evidence.map((evidence) => [evidence.ref.evidenceId, evidence]))
  const eligible = input.state.items.filter((item) => {
    if (!item.active) return false
    if (dueIds.has(item.id)) return true
    const scoped = !item.goalId || item.goalId === input.goalId
    if (!scoped) return false
    return input.pressure !== "comfortable" || item.disposition === "unresolved" || item.createdAtCompletedTurn === input.completedTurn
  })
  return eligible
    .flatMap((item): Candidate[] => {
      const evidence = evidenceById.get(item.evidenceRef.evidenceId)
      if (!evidence) return []
      const content = item.distilledText ?? evidence.exactContent
      return [{
        item,
        evidence,
        content,
        tokens: estimateTextTokens(content),
        relevance: lexicalRelevance(input.query, content),
        due: dueIds.has(item.id),
        isNew: item.createdAtCompletedTurn === input.completedTurn,
      }]
    })
    .sort((left, right) =>
      Number(right.due) - Number(left.due) ||
      Number(right.isNew) - Number(left.isNew) ||
      right.relevance - left.relevance ||
      right.item.priority - left.item.priority ||
      right.tokens - left.tokens ||
      left.item.id.localeCompare(right.item.id))
    .slice(0, Math.max(input.limit, dueIds.size))
}

const selectCompactionSources = (input: {
  state: V2ContextState
  goalId: string
  query: string
  usedTokens: number
  targetTokens: number
}): Candidate[] => {
  const evidenceById = new Map(input.state.evidence.map((evidence) => [evidence.ref.evidenceId, evidence]))
  const candidates = scopedActiveItems(input.state, input.goalId)
    .flatMap((item): Candidate[] => {
      const evidence = evidenceById.get(item.evidenceRef.evidenceId)
      if (!evidence) return []
      const content = item.distilledText ?? evidence.exactContent
      return [{
        item,
        evidence,
        content,
        tokens: estimateTextTokens(content),
        relevance: lexicalRelevance(input.query, content),
        due: false,
        isNew: false,
      }]
    })
    .sort((left, right) =>
      left.relevance - right.relevance ||
      left.item.createdAtCompletedTurn - right.item.createdAtCompletedTurn ||
      right.tokens - left.tokens ||
      left.item.id.localeCompare(right.item.id))
  const requiredReduction = Math.max(1, input.usedTokens - input.targetTokens + Math.min(2_000, Math.floor(input.targetTokens * 0.05)))
  const selected: Candidate[] = []
  let selectedTokens = 0
  for (const candidate of candidates) {
    selected.push(candidate)
    selectedTokens += candidate.tokens
    if (selectedTokens >= requiredReduction || selected.length >= MAX_COMPACTION_SOURCE_ITEMS) break
  }
  return selected
}

const normalizeDispositionDecisions = (input: {
  state: V2ContextState
  candidates: readonly Candidate[]
  query: string
  pressure: V2ContextPressure
  modelOutput?: z.infer<typeof dispositionOutputSchema>
}): DecisionWithSource[] => {
  const allowed = new Set(input.candidates.map((candidate) => candidate.item.id))
  const modelById = new Map<string, z.infer<typeof dispositionOutputSchema>["decisions"][number]>()
  for (const decision of input.modelOutput?.decisions ?? []) {
    if (allowed.has(decision.contextItemId) && !modelById.has(decision.contextItemId)) modelById.set(decision.contextItemId, decision)
  }
  const candidateIds = new Set(input.candidates.map((candidate) => candidate.item.id))
  let unresolvedSlots = Math.max(0, 5 - input.state.items.filter((item) => item.disposition === "unresolved" && !candidateIds.has(item.id)).length)
  const decisions: DecisionWithSource[] = []
  for (const candidate of input.candidates) {
    const model = modelById.get(candidate.item.id)
    let decision = model
      ? normalizeModelDecision(model, candidate)
      : deterministicDecision(candidate, input.query, input.pressure, unresolvedSlots > 0)
    let source: MaintenanceSource = model && decision ? "context_distiller" : "policy"
    if (!decision) {
      decision = deterministicDecision(candidate, input.query, input.pressure, unresolvedSlots > 0)
      source = "policy"
    }
    if (decision.disposition === "unresolved" && (candidate.due || unresolvedSlots <= 0)) {
      decision = deterministicDecision(candidate, input.query, input.pressure, false)
      source = "policy"
    }
    if (decision.disposition === "unresolved") unresolvedSlots -= 1
    decisions.push({
      ...decision,
      decidedBy: source === "policy" ? "policy" : "distiller",
      reason: source === "policy" ? "Deterministic bounded V2 context policy." : "Model-backed V2 context disposition.",
      ...(decision.disposition === "distill" ? { distillationInstruction: "Retain query-relevant facts and exact evidence handles only." } : {}),
      source,
    })
  }
  return decisions
}

const normalizeModelDecision = (
  decision: z.infer<typeof dispositionOutputSchema>["decisions"][number],
  candidate: Candidate,
): V2ContextDispositionDecision | undefined => {
  if (decision.disposition !== "distill") return { contextItemId: candidate.item.id, disposition: decision.disposition }
  const distilledText = normalizeDistilledText(decision.distilledText, candidate)
  return distilledText && estimateTextTokens(distilledText) < candidate.tokens
    ? { contextItemId: candidate.item.id, disposition: "distill", distilledText }
    : undefined
}

const deterministicDecision = (
  candidate: Candidate,
  query: string,
  pressure: V2ContextPressure,
  allowUnresolved: boolean,
): V2ContextDispositionDecision => {
  if (candidate.due) {
    if (candidate.tokens > 320) return distillDecision(candidate, query)
    return { contextItemId: candidate.item.id, disposition: "keep_exact" }
  }
  if (candidate.relevance >= 2) {
    if (candidate.tokens > 640) return distillDecision(candidate, query)
    return { contextItemId: candidate.item.id, disposition: "keep_exact" }
  }
  if (candidate.relevance === 1) {
    if (candidate.tokens > 320) return distillDecision(candidate, query)
    return { contextItemId: candidate.item.id, disposition: "keep_exact" }
  }
  if (pressure === "comfortable" && allowUnresolved) {
    return { contextItemId: candidate.item.id, disposition: "unresolved" }
  }
  if (candidate.tokens <= 96) return { contextItemId: candidate.item.id, disposition: "keep_exact" }
  return { contextItemId: candidate.item.id, disposition: "release" }
}

const distillDecision = (candidate: Candidate, query: string): V2ContextDispositionDecision => {
  const distilledText = normalizeDistilledText(extractiveSummary(candidate.content, query), candidate)
  return distilledText && estimateTextTokens(distilledText) < candidate.tokens
    ? { contextItemId: candidate.item.id, disposition: "distill", distilledText }
    : { contextItemId: candidate.item.id, disposition: "keep_exact" }
}

const enforcePressureTarget = (input: {
  state: V2ContextState
  goalId: string
  query: string
  decisions: readonly DecisionWithSource[]
  completedTurn: number
  targetTokens: number
}): DecisionWithSource[] => {
  if (!Number.isFinite(input.targetTokens)) return [...input.decisions]
  const byId = new Map(input.decisions.map((decision) => [decision.contextItemId, decision]))
  const evidenceById = new Map(input.state.evidence.map((evidence) => [evidence.ref.evidenceId, evidence]))
  const pressureCandidates = scopedActiveItems(input.state, input.goalId)
    .flatMap((item): Candidate[] => {
      const evidence = evidenceById.get(item.evidenceRef.evidenceId)
      if (!evidence) return []
      const content = item.distilledText ?? evidence.exactContent
      return [{ item, evidence, content, tokens: estimateTextTokens(content), relevance: lexicalRelevance(input.query, content), due: false, isNew: false }]
    })
    .sort((left, right) => left.relevance - right.relevance || right.tokens - left.tokens || left.item.id.localeCompare(right.item.id))
  for (const candidate of pressureCandidates) {
    const projected = applyV2ContextDispositions({
      state: input.state,
      decisions: [...byId.values()].map(baseDecision),
      completedTurn: input.completedTurn,
    })
    const projectedIds = scopedActiveItems(projected, input.goalId).map((item) => item.id)
    if (estimateActiveTokens(projected, projectedIds) <= input.targetTokens) break
    const existing = byId.get(candidate.item.id)
    if (existing?.source === "context_compactor" && existing.disposition === "keep_exact") continue
    const preferred = candidate.relevance > 0 && candidate.tokens > 320
      ? distillDecision(candidate, input.query)
      : undefined
    const forced = preferred?.disposition === "distill"
      ? preferred
      : { contextItemId: candidate.item.id, disposition: "release" as const }
    byId.set(candidate.item.id, {
      ...forced,
      decidedBy: "policy",
      reason: "Deterministic V2 pressure target enforcement.",
      ...(forced.disposition === "distill" ? { distillationInstruction: "Retain query-relevant facts and exact evidence handles only." } : {}),
      source: "policy",
    })
  }
  return [...byId.values()]
}

const normalizeCompactionSummary = (
  modelSummary: string | undefined,
  sources: readonly Candidate[],
  query: string,
): string => {
  const handles = sources.map((candidate) => candidate.evidence.ref.sourceLocator)
  const body = modelSummary?.trim()
    ? excerpt(modelSummary.trim(), 8_000)
    : sources.map((candidate) => extractiveSummary(candidate.content, query)).filter(Boolean).join("\n")
  const handleLine = `Exact evidence: ${handles.join(", ")}`
  return excerpt(`${body || "Compacted context is available from the exact evidence handles below."}\n\n${handleLine}`, 12_000)
}

const normalizeCompactionSourceIds = (modelIds: readonly string[] | undefined, sources: readonly Candidate[]): string[] => {
  const allowed = new Set(sources.map((candidate) => candidate.item.id))
  const selected = unique((modelIds ?? []).filter((id) => allowed.has(id)))
  // The deterministic source selection is the coverage boundary. A model may
  // omit an id, but omission must not make the pressure target nondeterministic.
  return selected.length === sources.length ? selected : sources.map((candidate) => candidate.item.id)
}

const normalizeDistilledText = (value: string | undefined, candidate: Candidate): string | undefined => {
  const body = value?.trim()
  if (!body) return undefined
  const handle = candidate.evidence.ref.sourceLocator
  const withHandle = body.includes(handle) ? body : `${body}\nExact evidence: ${handle}`
  return excerpt(withHandle, MAX_DISTILLED_CHARS)
}

const scopedActiveItems = (state: V2ContextState, goalId: string): CoreV2ContextItem[] =>
  state.items.filter((item) => item.active && (!item.goalId || item.goalId === goalId))

const estimateActiveTokens = (state: V2ContextState, includedIds: readonly string[]): number => {
  const included = new Set(includedIds)
  const evidenceById = new Map(state.evidence.map((evidence) => [evidence.ref.evidenceId, evidence]))
  return state.items.reduce((sum, item) => {
    if (!item.active || !included.has(item.id)) return sum
    const content = item.distilledText ?? evidenceById.get(item.evidenceRef.evidenceId)?.exactContent ?? ""
    return sum + estimateTextTokens(content)
  }, 0)
}

const estimateTextTokens = (value: string): number => value ? Math.max(1, Math.ceil(value.length / 4)) : 0

const lexicalRelevance = (query: string, content: string): number => {
  const queryTerms = new Set(terms(query))
  if (queryTerms.size === 0) return 0
  const contentTerms = new Set(terms(content))
  let matches = 0
  for (const term of queryTerms) if (contentTerms.has(term)) matches += 1
  return matches
}

const terms = (value: string): string[] =>
  value.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu)?.filter((term) => !STOP_WORDS.has(term)) ?? []

const STOP_WORDS = new Set(["the", "and", "for", "that", "this", "with", "from", "have", "what", "when", "where", "which", "into", "your", "you", "are"])

const extractiveSummary = (content: string, query = ""): string => {
  const queryTerms = new Set(terms(query))
  const segments = content.split(/(?<=[.!?])\s+|\n+/).map((segment) => segment.trim()).filter(Boolean)
  const ranked = segments.map((segment, index) => ({
    segment,
    index,
    score: queryTerms.size === 0 ? 0 : terms(segment).reduce((sum, term) => sum + Number(queryTerms.has(term)), 0),
  })).sort((left, right) => right.score - left.score || left.index - right.index)
  const selected: string[] = []
  let chars = 0
  for (const item of ranked) {
    if (chars > 1_200) break
    selected.push(item.segment)
    chars += item.segment.length
  }
  return selected.join(" ") || excerpt(content, 1_200)
}

const providerRuntimeConfig = (
  worker: V2ContextMaintenanceWorkerRuntime,
  main: Pick<V2RuntimeConfig, "approvalMode" | "sandboxMode">,
): RuntimeConfig => ({
  providerId: worker.providerId,
  ...(worker.authMode ? { authMode: worker.authMode } : {}),
  modelId: worker.modelId,
  thinkingEnabled: worker.thinkingEnabled,
  ...(worker.thinkingEffort ? { thinkingEffort: worker.thinkingEffort } : {}),
  approvalMode: main.approvalMode,
  sandboxMode: main.sandboxMode,
})

const workerRuntimeAudit = (
  worker: V2ContextMaintenanceWorkerRuntime,
): Readonly<Record<string, unknown>> => ({
  providerId: worker.providerId,
  ...(worker.authMode ? { authMode: worker.authMode } : {}),
  modelId: worker.modelId,
  thinkingEnabled: worker.thinkingEnabled,
  ...(worker.thinkingEffort ? { thinkingEffort: worker.thinkingEffort } : {}),
})

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  role: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new SocratesError(`${role}_timeout`, `The V2 ${role} exceeded its ${timeoutMs} ms bound.`, { recoverable: true }))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const recordSanitizedUsage = (store: V2FlowStore, modelCallId: string, usage: ModelUsage): void => {
  store.recordUsage({
    modelCallId,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  })
}

const baseDecision = (decision: V2ContextDispositionDecision): V2ContextDispositionDecision => ({
  contextItemId: decision.contextItemId,
  disposition: decision.disposition,
  ...(decision.distilledText ? { distilledText: decision.distilledText } : {}),
})

const emptyResult = (pressure: V2ContextPressure, usedTokens: number): V2ContextMaintenanceResult => ({
  status: "no_work",
  pressure,
  usedTokensBefore: usedTokens,
  usedTokensAfter: usedTokens,
  dispositionCount: 0,
  compactionPerformed: false,
  deterministicFallbackUsed: false,
  failureCodes: [],
  events: [],
})

const excerpt = (value: string, maxChars: number): string => value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]
const boundedInteger = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? value : min)))
