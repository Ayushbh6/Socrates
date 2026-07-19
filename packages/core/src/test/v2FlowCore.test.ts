import { describe, expect, it } from "vitest"
import type { ModelProvider, StructuredModelRequest } from "@socrates/providers"
import {
  V2ContextPolicyError,
  addV2ContextItem,
  appendImmutableV2Evidence,
  applyV2ContextDispositions,
  assembleV2GoalWorkingContext,
  capsuleRefreshReason,
  createImmutableEvidenceRecord,
  createV2ContextItem,
  deriveV2ContextBudget,
  getV2ContextReviewRequirements,
  planV2GoalRoutingTransition,
  refreshV2GoalCapsule,
  routeV2Goal,
  selectV2GoalRoutingCandidates,
  type ImmutableEvidenceRecord,
  type V2ContextItem,
  type V2ContextState,
  type V2FlowContextMessage,
  type V2Goal,
} from "../v2"
import { createDefaultToolRegistry, createGoalRouterToolRegistry, createV2ToolRegistry } from "../tools/registry"

const flowId = "flow_1"

describe("V2 Flow goal routing", () => {
  it("inherits every Classic Socrates tool and adds only the V2 focus ledger", () => {
    const classic = createDefaultToolRegistry().list().map((tool) => tool.name)
    const seamless = createV2ToolRegistry().list().map((tool) => tool.name)
    expect(seamless.filter((name) => name !== "focus_ledger")).toEqual(classic)
    expect(seamless).toContain("handover_to_frontier")
    expect(seamless).toContain("trace_retrieve")
    expect(classic).not.toContain("focus_ledger")
    expect(createGoalRouterToolRegistry().list()).toEqual([])
  })

  it("bounds a 30-goal Flow to five cards and honors retrieved goal ids without deciding semantically", () => {
    const goals: V2Goal[] = [goal("goal_0", "foreground", "Current implementation")]
    for (let index = 1; index < 30; index += 1) {
      goals.push(goal(`goal_${index}`, "parked", index === 27 ? "Vienna travel itinerary" : `Parked topic ${index}`))
    }
    const selected = selectV2GoalRoutingCandidates({
      flowId,
      userMessage: "resume the Vienna travel itinerary",
      goals,
      parkedCandidateLimit: 5,
      candidateGoalIds: ["goal_27"],
    })

    expect(selected.candidates).toHaveLength(5)
    expect(selected.parked).toHaveLength(4)
    expect(selected.totalEligibleParked).toBe(29)
    expect(selected.parked[0]?.goal.id).toBe("goal_27")
    expect(selected.foreground?.goal.id).toBe("goal_0")
  })

  it("falls back conservatively to the foreground when the model router fails", async () => {
    const provider = providerWithStructured(async () => {
      throw new Error("provider unavailable")
    })
    const result = await routeV2Goal({
      projectId: "project_1",
      flowId,
      turnId: "turn_1",
      workspacePath: "/workspace",
      userMessage: "Can you take another look?",
      goals: [goal("active", "foreground", "Build V2"), goal("parked", "parked", "Travel")],
      provider,
      model: { providerId: "openrouter", modelId: "router-model", thinkingEnabled: false },
    })

    expect(result.source).toBe("fallback")
    expect(result.fallbackReason).toBe("provider_error")
    expect(result.decision).toMatchObject({ action: "continue", primaryGoalId: "active" })
  })

  it("falls back on timeout even when a provider ignores abort", async () => {
    const provider = providerWithStructured(async () => new Promise(() => undefined))
    const result = await routeV2Goal({
      projectId: "project_1",
      flowId,
      turnId: "turn_1",
      workspacePath: "/workspace",
      userMessage: "keep going",
      goals: [goal("active", "foreground", "Build V2")],
      provider,
      model: { providerId: "openrouter", modelId: "router-model", thinkingEnabled: false, timeoutMs: 50 },
    })

    expect(result.fallbackReason).toBe("timeout")
    expect(result.decision.action).toBe("continue")
  })

  it("passes three focus-tagged Q&A pairs and accepts one bounded clarification between real candidates", async () => {
    let routedPayload: Record<string, unknown> | undefined
    const provider = providerWithStructured(async <TOutput>(request: StructuredModelRequest<TOutput>) => {
      routedPayload = JSON.parse(String(request.messages[0]?.content)) as Record<string, unknown>
      return {
        output: ({
          action: "clarify",
          candidates: [1, 2],
          title: null,
        }) as unknown as TOutput,
      }
    })
    const result = await routeV2Goal({
      projectId: "project_1",
      flowId,
      turnId: "turn_1",
      workspacePath: "/workspace",
      userMessage: "What about the second one?",
      goals: [goal("api", "foreground", "API work"), goal("slides", "parked", "Presentation")],
      recentTurns: [
        { goalId: "api", user: "Fix authentication", assistant: "Tests are ready." },
        { goalId: "slides", user: "Outline the talk", assistant: "The outline is ready." },
        { goalId: "slides", user: "Compare two openings", assistant: "The second is calmer." },
      ],
      provider,
      model: { providerId: "openrouter", modelId: "router-model", thinkingEnabled: false },
    })

    expect(result.decision).toMatchObject({
      action: "clarify",
      clarificationGoalIds: ["api", "slides"],
      clarificationQuestion: "Should I continue “API work” or “Presentation”?",
    })
    expect(routedPayload?.recentTurns).toHaveLength(3)
  })

  it("runs through the shared structured agent and repairs one invalid result", async () => {
    let attempts = 0
    let systemPrompt = ""
    const provider = providerWithStructured(async <TOutput>(request: StructuredModelRequest<TOutput>) => {
      attempts += 1
      systemPrompt = request.system
      if (attempts === 1) {
        return {
          output: {
            action: "use",
            candidates: [99],
            title: null,
          } as TOutput,
          usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
        }
      }
      return {
        output: {
          action: "use",
          candidates: [1],
          title: null,
        } as TOutput,
        usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 },
      }
    })

    const result = await routeV2Goal({
      projectId: "project_1",
      flowId,
      turnId: "turn_repair",
      workspacePath: "/workspace",
      userMessage: "keep going",
      goals: [goal("active", "foreground", "Build V2")],
      provider,
      model: { providerId: "openrouter", modelId: "router-model", thinkingEnabled: false },
    })

    expect(attempts).toBe(2)
    expect(systemPrompt).toContain("Goal Router Agent")
    expect(result.source).toBe("model")
    expect(result.decision).toMatchObject({ action: "continue", primaryGoalId: "active" })
    expect(result.modelAttempt?.usage).toMatchObject({ inputTokens: 17, outputTokens: 4, totalTokens: 21 })
  })

  it("plans exactly one foreground when resuming", () => {
    const plan = planV2GoalRoutingTransition({
      flowId,
      goals: [goal("active", "foreground", "Build V2"), goal("travel", "parked", "Travel"), goal("voice", "parked", "Voice")],
      decision: {
        action: "resume",
        primaryGoalId: "travel",
      },
    })

    expect(plan.foregroundGoalId).toBe("travel")
    expect(plan.transitions).toEqual([
      { goalId: "active", from: "foreground", to: "parked" },
      { goalId: "travel", from: "parked", to: "foreground" },
    ])
  })
})

describe("V2 Flow capsules", () => {
  it("refreshes immutable capsule versions on material boundaries and staleness", () => {
    const active = goal("active", "foreground", "Build V2")
    const first = refreshV2GoalCapsule({
      capsuleId: "capsule_1",
      goal: active,
      patch: { summary: "Router complete", nextActions: ["Add context policy"] },
      sourceThroughSequence: 2,
      tokenEstimate: 12,
      createdAt: "2026-07-17T10:00:00.000Z",
    })
    const second = refreshV2GoalCapsule({
      capsuleId: "capsule_2",
      goal: active,
      previous: first,
      patch: { summary: "Context policy complete" },
      sourceThroughSequence: 3,
      tokenEstimate: 14,
      createdAt: "2026-07-17T10:01:00.000Z",
    })

    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
    expect(first.summary).toBe("Router complete")
    expect(capsuleRefreshReason({ capsule: second, event: { kind: "goal_parked", sequence: 3 } })).toBe("parked")
    expect(capsuleRefreshReason({ capsule: second, event: { kind: "turn_completed", sequence: 9 } })).toBe("stale")
  })
})

describe("V2 Flow context disposition policy", () => {
  it("caps unresolved evidence at five and requires review after three subsequent completed turns", () => {
    let state: V2ContextState = { evidence: [], items: [] }
    for (let index = 0; index < 6; index += 1) state = addEvidenceAndItem(state, index)
    const firstFive = state.items.slice(0, 5).map((item) => ({ contextItemId: item.id, disposition: "unresolved" as const }))
    const unresolved = applyV2ContextDispositions({ state, decisions: firstFive, completedTurn: 10 })

    expect(getV2ContextReviewRequirements(unresolved.items, 12)).toMatchObject({
      remainingUnresolvedSlots: 0,
      dueNowIds: [],
    })
    expect(() => applyV2ContextDispositions({
      state: unresolved,
      decisions: [{ contextItemId: "item_5", disposition: "unresolved" }],
      completedTurn: 11,
    })).toThrowError(expect.objectContaining({ code: "unresolved_limit_exceeded" }))
    expect(getV2ContextReviewRequirements(unresolved.items, 13).dueNowIds).toHaveLength(5)
    expect(() => applyV2ContextDispositions({ state: unresolved, decisions: [], completedTurn: 13 })).toThrowError(
      expect.objectContaining({ code: "unresolved_review_due" }),
    )

    const reviewed = applyV2ContextDispositions({
      state: unresolved,
      decisions: unresolved.items.slice(0, 5).map((item) => ({ contextItemId: item.id, disposition: "release" as const })),
      completedTurn: 13,
    })
    expect(getV2ContextReviewRequirements(reviewed.items, 13).unresolvedIds).toEqual([])
  })

  it("releases only the active-context copy and retains immutable source evidence", () => {
    const initial = addEvidenceAndItem({ evidence: [], items: [] }, 1)
    const evidenceArray = initial.evidence
    const released = applyV2ContextDispositions({
      state: initial,
      decisions: [{ contextItemId: "item_1", disposition: "release" }],
      completedTurn: 2,
    })

    expect(released.evidence).toBe(evidenceArray)
    expect(released.evidence[0]?.exactContent).toBe("exact evidence 1")
    expect(released.items[0]).toMatchObject({ disposition: "release", active: false })
    expect(Object.isFrozen(released.evidence[0]?.ref)).toBe(true)
  })

  it("never permits replacement of an existing immutable evidence id", () => {
    const evidence = evidenceRecord(1)
    const state = appendImmutableV2Evidence({ evidence: [], items: [] }, evidence)
    expect(() => appendImmutableV2Evidence(state, evidenceRecord(1))).toThrowError(
      expect.objectContaining({ code: "duplicate_evidence" } satisfies Partial<V2ContextPolicyError>),
    )
  })
})

describe("V2 Flow Socrates context policy", () => {
  it("keeps one fixed 170k/180k policy regardless of selected model metadata", () => {
    const budget = deriveV2ContextBudget()

    expect(budget.compactionTriggerTokens).toBe(170_000)
    expect(budget.hardInputLimitTokens).toBe(180_000)
    expect(budget.recentGoalTailTokens).toBe(50_000)
  })

  it("assembles only foreground-linked or Flow-global history and bounds exact retrieval", async () => {
    const currentEvidence = evidenceRecord(1)
    const unrelatedEvidence = evidenceRecord(2)
    let state: V2ContextState = { evidence: [], items: [] }
    state = appendImmutableV2Evidence(state, currentEvidence)
    state = appendImmutableV2Evidence(state, unrelatedEvidence)
    state = addV2ContextItem(state, createV2ContextItem({
      id: "current_item",
      flowId,
      goalId: "goal_a",
      evidenceRef: currentEvidence.ref,
      completedTurn: 1,
      priority: 10,
    }))
    state = addV2ContextItem(state, createV2ContextItem({
      id: "unrelated_item",
      flowId,
      goalId: "goal_b",
      evidenceRef: unrelatedEvidence.ref,
      completedTurn: 1,
      priority: 100,
    }))
    const selectedByHook: string[][] = []
    const context = await assembleV2GoalWorkingContext({
      foregroundGoalId: "goal_a",
      query: "show exact evidence",
      messages: flowMessages(),
      contextItems: state.items,
      exactSelector: (candidates) => {
        selectedByHook.push(candidates.map((candidate) => candidate.contextItemId))
        return candidates.map((candidate) => candidate.contextItemId)
      },
      exactRetriever: (refs) => refs.map((ref) => ({
        evidenceRef: ref,
        exactContent: state.evidence.find((record) => record.ref.evidenceId === ref.evidenceId)?.exactContent ?? "",
      })),
    })

    expect(context.messages.map((message) => message.id)).toEqual(["global", "goal_a", "linked_a"])
    expect(context.excludedMessageIds).toContain("goal_b")
    expect(selectedByHook).toEqual([["current_item"]])
    expect(context.requestedExactEvidenceRefs.map((ref) => ref.evidenceId)).toEqual(["evidence_1"])
    expect(context.exactEvidence.map((material) => material.exactContent)).toEqual(["exact evidence 1"])
  })

  it("shares one hard evidence budget across distilled text and lazy exact retrieval", async () => {
    const ref = (index: number) => ({
      evidenceId: `budget_evidence_${index}`,
      flowId,
      sourceType: "retrieval_chunk",
      sourceLocator: `evidence://budget/${index}`,
      contentHash: `hash_${index}`,
      capturedAt: "2026-07-17T10:00:00.000Z",
    })
    const baseItem = (index: number): V2ContextItem => ({
      id: `budget_item_${index}`,
      flowId,
      goalId: "goal_a",
      evidenceRef: ref(index),
      disposition: "keep_exact",
      representation: "exact",
      tokenEstimate: 100,
      active: true,
      priority: 100 - index,
      createdAtCompletedTurn: 1,
      decidedAtCompletedTurn: 1,
    })
    const contextItems: V2ContextItem[] = [
      { ...baseItem(1), disposition: "distill", representation: "distilled", distilledText: "d".repeat(200), tokenEstimate: 50 },
      { ...baseItem(2), disposition: "distill", representation: "distilled", distilledText: "s".repeat(200), tokenEstimate: 50 },
      ...Array.from({ length: 50 }, (_, index) => baseItem(index + 3)),
    ]
    const retrievedBatches: string[][] = []
    const context = await assembleV2GoalWorkingContext({
      foregroundGoalId: "goal_a",
      query: "bounded evidence",
      messages: [],
      contextItems,
      budget: deriveV2ContextBudget(),
      evidenceTokenLimit: 250,
      exactRetriever: (refs) => {
        retrievedBatches.push(refs.map((candidate) => candidate.evidenceId))
        return refs.map((candidate) => ({ evidenceRef: candidate, exactContent: "e".repeat(400) }))
      },
    })

    expect(context.evidenceTokenLimit).toBe(250)
    expect(context.distilledItems).toHaveLength(2)
    expect(context.requestedExactEvidenceRefs).toHaveLength(1)
    expect(retrievedBatches[0]).toHaveLength(1)
    expect(context.exactEvidence).toHaveLength(1)
    expect(context.estimatedTokens).toBeLessThanOrEqual(250)
    expect(context.excludedContextItemIds).toHaveLength(49)
  })
})

const goal = (id: string, status: V2Goal["status"], title: string): V2Goal => ({
  id,
  flowId,
  projectId: "project_1",
  ordinal: Number(id.replace(/\D/g, "")) + 1 || 1,
  title,
  summary: title,
  kind: "work",
  status,
  origin: "user",
  priority: 50,
  pinned: false,
  lastActiveAt: `2026-07-17T10:${id.replace(/\D/g, "").padStart(2, "0").slice(-2)}:00.000Z`,
  createdAt: "2026-07-17T10:00:00.000Z",
  updatedAt: `2026-07-17T10:${id.replace(/\D/g, "").padStart(2, "0").slice(-2)}:00.000Z`,
})

const providerWithStructured = (generateStructured: NonNullable<ModelProvider["generateStructured"]>): ModelProvider => ({
  countTokens: async (request) => ({
    providerId: request.providerId,
    modelId: request.modelId,
    inputTokens: 1,
    baseTokens: 1,
    method: "local_tiktoken",
    safetyMarginPercent: 0,
  }),
  async *stream() {
    yield { type: "model.completed" }
  },
  generateStructured,
})

const evidenceRecord = (index: number): ImmutableEvidenceRecord => createImmutableEvidenceRecord({
  evidenceId: `evidence_${index}`,
  flowId,
  sourceType: "tool_result",
  sourceLocator: `tool://result/${index}`,
  contentHash: `sha256:${index}`,
  capturedAt: "2026-07-17T10:00:00.000Z",
  exactContent: `exact evidence ${index}`,
})

const addEvidenceAndItem = (state: V2ContextState, index: number): V2ContextState => {
  const evidence = evidenceRecord(index)
  const withEvidence = appendImmutableV2Evidence(state, evidence)
  return addV2ContextItem(withEvidence, createV2ContextItem({
    id: `item_${index}`,
    flowId,
    goalId: "goal_a",
    evidenceRef: evidence.ref,
    completedTurn: 1,
  }))
}

const flowMessages = (): V2FlowContextMessage[] => [
  { id: "global", role: "system", content: "Flow-wide project instruction", occurredAt: "2026-07-17T10:00:00Z", scope: "flow" },
  { id: "goal_a", role: "user", content: "Current goal message", occurredAt: "2026-07-17T10:01:00Z", primaryGoalId: "goal_a" },
  { id: "goal_b", role: "assistant", content: "Unrelated goal history", occurredAt: "2026-07-17T10:02:00Z", primaryGoalId: "goal_b" },
  { id: "linked_a", role: "assistant", content: "Secondary link to current goal", occurredAt: "2026-07-17T10:03:00Z", primaryGoalId: "goal_b", linkedGoalIds: ["goal_a"] },
  { id: "unscoped", role: "assistant", content: "Legacy unscoped Flow message", occurredAt: "2026-07-17T10:04:00Z" },
]
