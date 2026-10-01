import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { V2RuntimeConfig } from "@socrates/contracts"
import type { V2GoalRouterResult } from "@socrates/core"
import type { ModelProvider, StructuredModelRequest, StructuredModelResult } from "@socrates/providers"
import { createId, nowIso } from "@socrates/shared"
import { openDatabase, runMigrations, type DatabaseHandle } from "../db/client"
import {
  V2ContextMaintenanceService,
  type V2ContextMaintenanceWorkerRuntime,
} from "../services/v2/contextMaintenance"
import { V2FlowStore } from "../services/v2/flowStore"

const handles: DatabaseHandle[] = []
const roots: string[] = []

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const runtimeConfig: V2RuntimeConfig = {
  providerId: "openai",
  authMode: "api_key",
  modelId: "gpt-test",
  thinkingEnabled: false,
  approvalMode: "manual",
  sandboxMode: "workspace_write",
  contextWindowTokens: 128_000,
}

const workerRuntime: V2ContextMaintenanceWorkerRuntime = {
  providerId: "openrouter",
  authMode: "api_key",
  modelId: "deepseek/context-worker-test",
  thinkingEnabled: true,
  thinkingEffort: "low",
}

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-context-maintenance-"))
  roots.push(root)
  const handle = openDatabase(path.join(root, "socrates.sqlite"))
  handles.push(handle)
  runMigrations(handle)
  seedProject(handle, "proj_one", path.join(root, "workspace"))
  const store = new V2FlowStore(handle)
  return { root, handle, store, flowId: store.ensureFlow("proj_one").flow.id }
}

const seedProject = (handle: DatabaseHandle, projectId: string, workspacePath: string): void => {
  fs.mkdirSync(workspacePath, { recursive: true })
  const now = nowIso()
  handle.sqlite.prepare(
    "INSERT OR IGNORE INTO users (id, display_name, onboarding_completed, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
  ).run("user_v2_context", "V2 Context User", now, now)
  handle.sqlite.prepare(
    "INSERT INTO projects (id, user_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
  ).run(projectId, "user_v2_context", projectId, now, now)
  handle.sqlite.prepare(
    "INSERT INTO project_workspaces (id, project_id, kind, path, is_primary, status, created_at, updated_at) VALUES (?, ?, 'existing_folder', ?, 1, 'active', ?, ?)",
  ).run(`pws_${projectId}`, projectId, workspacePath, now, now)
}

const createRoutedTurn = (store: V2FlowStore, flowId: string, content: string, goalId?: string) => {
  const created = store.createTurn({
    projectId: "proj_one",
    flowId,
    clientMessageId: createId("v2msg"),
    content,
    runtimeConfig,
  })
  const result = goalId ? forcedContinueResult(store, flowId, goalId) : forcedCreateResult(store, flowId)
  const applied = store.applyRouting({
    projectId: "proj_one",
    flowId,
    turnId: created.turn.id,
    messageId: created.userMessage.id,
    messageContent: content,
    result,
  })
  return { ...created, goal: applied.goal }
}

const forcedCreateResult = (store: V2FlowStore, flowId: string): V2GoalRouterResult => {
  const foregroundGoal = store.listGoalsForRouter(flowId).find((goal) => goal.status === "foreground")
  const foreground = foregroundGoal ? { goal: foregroundGoal, lexicalScore: 0 } : undefined
  return {
    decision: { action: "create", secondaryGoalIds: [], confidence: 0.9, reasonCode: "new_goal" },
    candidates: {
      ...(foreground ? { foreground } : {}),
      parked: [],
      candidates: foreground ? [foreground] : [],
      totalEligibleParked: 0,
      parkedCandidateLimit: 5,
    },
    source: "fallback",
    fallbackReason: "invalid_output",
  }
}

const forcedContinueResult = (store: V2FlowStore, flowId: string, goalId: string): V2GoalRouterResult => {
  const goal = store.listGoalsForRouter(flowId).find((candidate) => candidate.id === goalId)
  if (!goal) throw new Error("Goal not found")
  const foreground = { goal, lexicalScore: 1 }
  return {
    decision: {
      action: "continue",
      primaryGoalId: goalId,
      secondaryGoalIds: [],
      confidence: 1,
      reasonCode: "foreground_continuation",
    },
    candidates: {
      foreground,
      parked: [],
      candidates: [foreground],
      totalEligibleParked: 0,
      parkedCandidateLimit: 5,
    },
    source: "fallback",
    fallbackReason: "invalid_output",
  }
}

const fakeCountTokens: ModelProvider["countTokens"] = async (request) => ({
  providerId: request.providerId,
  modelId: request.modelId,
  inputTokens: 10,
  baseTokens: 10,
  method: "local_tiktoken",
  safetyMarginPercent: 0,
})

const structuredProvider = (
  outputFor: (request: StructuredModelRequest<unknown>) => unknown | Promise<unknown>,
): ModelProvider => ({
  countTokens: fakeCountTokens,
  async *stream() {
    yield { type: "model.completed" }
  },
  async generateStructured<TOutput>(request: StructuredModelRequest<TOutput>): Promise<StructuredModelResult<TOutput>> {
    return {
      output: await outputFor(request as StructuredModelRequest<unknown>) as TOutput,
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      raw: { hiddenReasoning: "must never be persisted" },
    }
  },
})

const requestBody = (request: StructuredModelRequest<unknown>): Record<string, unknown> => {
  const content = request.messages[0]?.content
  if (typeof content !== "string") throw new Error("Expected JSON user message")
  return JSON.parse(content) as Record<string, unknown>
}

describe("V2ContextMaintenanceService", () => {
  it("uses structured V2 model decisions while retaining immutable exact and derived evidence", async () => {
    const { handle, store, flowId } = setup()
    const turn = createRoutedTurn(store, flowId, "Find the launch date")
    const first = store.recordEvidence({
      projectId: "proj_one",
      flowId,
      goalId: turn.goal.id,
      turnId: turn.turn.id,
      sourceKind: "retrieval_chunk",
      title: "Launch record",
      content: `${"Background material. ".repeat(180)}The launch date is 17 July.`,
    })
    const second = store.recordEvidence({
      projectId: "proj_one",
      flowId,
      goalId: turn.goal.id,
      turnId: turn.turn.id,
      sourceKind: "retrieval_chunk",
      title: "Unrelated record",
      content: "A completely unrelated cafeteria menu.",
    })
    store.completeTurn({ projectId: "proj_one", flowId, turnId: turn.turn.id, content: "I found it." })

    const provider = structuredProvider((request) => {
      const body = requestBody(request)
      const items = body.items as Array<{ contextItemId: string; evidenceHandle: string }>
      return {
        decisions: [
          {
            contextItemId: items[0]?.contextItemId,
            disposition: "distill",
            distilledText: `Launch date: 17 July. Exact evidence: ${items[0]?.evidenceHandle}`,
          },
          { contextItemId: items[1]?.contextItemId, disposition: "release" },
        ],
      }
    })
    const service = new V2ContextMaintenanceService({ store, provider })
    const result = await service.runAfterTurn({
      projectId: "proj_one",
      flowId,
      goalId: turn.goal.id,
      turnId: turn.turn.id,
      completedTurnOrdinal: turn.turn.ordinal,
      query: "Find the launch date",
      runtimeConfig,
      workerRuntime,
    })

    expect(result.status).toBe("completed")
    expect(result.events).toHaveLength(2)
    expect(result.events.map((event) => event.payload.disposition.disposition).sort()).toEqual(["distill", "release"])
    const state = store.getCoreContextState(flowId)
    expect(state.items.find((item) => item.id === first.contextItem?.id)?.distilledText).toContain("17 July")
    expect(state.items.find((item) => item.id === second.contextItem?.id)?.active).toBe(false)
    expect(store.retrieveExactEvidence(flowId, [first.evidence.id])[0]?.exactContent).toContain("Background material")
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM v2_evidence_items WHERE source_kind = 'model_output'").get()).toMatchObject({ count: 1 })
    expect(() => handle.sqlite.prepare("DELETE FROM v2_evidence_items WHERE id = ?").run(first.evidence.id)).toThrow()
    expect(store.countV1Rows()).toEqual({
      conversations: 0,
      sessions: 0,
      turns: 0,
      messages: 0,
      message_attachments: 0,
      model_calls: 0,
      tool_calls: 0,
      approvals: 0,
      events: 0,
      terminal_sessions: 0,
      terminal_output_chunks: 0,
      agent_tasks: 0,
      agent_task_waits: 0,
      agent_task_turns: 0,
      message_feedback: 0,
    })

    const call = handle.sqlite.prepare("SELECT role, provider_id, model_id, request_json, response_json, provider_response_json FROM v2_model_calls").get() as Record<string, unknown>
    expect(call.role).toBe("context_distiller")
    expect(call.provider_id).toBe(workerRuntime.providerId)
    expect(call.model_id).toBe(workerRuntime.modelId)
    expect(JSON.parse(String(call.request_json))).toMatchObject({
      workerRuntime: {
        providerId: workerRuntime.providerId,
        authMode: workerRuntime.authMode,
        modelId: workerRuntime.modelId,
        thinkingEnabled: true,
        thinkingEffort: "low",
      },
    })
    expect(String(call.request_json)).not.toContain("cafeteria")
    expect(String(call.response_json)).not.toContain("hiddenReasoning")
    expect(call.provider_response_json).toBeNull()
  })

  it("bounds unresolved context at five and force-resolves it on the original turn plus three", async () => {
    const { handle, store, flowId } = setup()
    const firstTurn = createRoutedTurn(store, flowId, "Consider these chunks")
    for (let index = 0; index < 6; index += 1) {
      store.recordEvidence({
        projectId: "proj_one",
        flowId,
        goalId: firstTurn.goal.id,
        turnId: firstTurn.turn.id,
        sourceKind: "retrieval_chunk",
        title: `Chunk ${index + 1}`,
        content: `Opaque source ${index + 1} without matching terms.`,
      })
    }
    store.completeTurn({ projectId: "proj_one", flowId, turnId: firstTurn.turn.id, content: "Noted." })
    const unavailable = new V2ContextMaintenanceService({ store })
    const firstResult = await unavailable.runAfterTurn({
      projectId: "proj_one",
      flowId,
      goalId: firstTurn.goal.id,
      turnId: firstTurn.turn.id,
      completedTurnOrdinal: 1,
      query: "Consider these chunks",
      runtimeConfig,
    })
    expect(firstResult.status).toBe("degraded")
    expect(firstResult.failureCodes).toContain("context_distiller_model_unavailable")
    expect(store.getCoreContextState(flowId).items.filter((item) => item.disposition === "unresolved")).toHaveLength(5)

    const secondTurn = createRoutedTurn(store, flowId, "Start a separate foreground goal")
    store.completeTurn({ projectId: "proj_one", flowId, turnId: secondTurn.turn.id, content: "Second goal started." })
    let latestTurn = secondTurn
    for (let ordinal = 3; ordinal <= 4; ordinal += 1) {
      latestTurn = createRoutedTurn(store, flowId, `Continue second goal ${ordinal}`, secondTurn.goal.id)
      store.completeTurn({ projectId: "proj_one", flowId, turnId: latestTurn.turn.id, content: `Done ${ordinal}.` })
    }
    const dueResult = await unavailable.runAfterTurn({
      projectId: "proj_one",
      flowId,
      goalId: secondTurn.goal.id,
      turnId: latestTurn.turn.id,
      completedTurnOrdinal: 4,
      query: "Continue second goal",
      runtimeConfig,
    })
    expect(dueResult.dispositionCount).toBe(5)
    expect(store.getCoreContextState(flowId).items.filter((item) => item.disposition === "unresolved")).toHaveLength(0)
    const resolvedGoalIds = handle.sqlite.prepare(
      "SELECT DISTINCT goal_id AS goalId FROM v2_context_dispositions WHERE turn_id = ?",
    ).all(latestTurn.turn.id).map((row) => (row as { goalId: string }).goalId)
    expect(resolvedGoalIds).toEqual([firstTurn.goal.id])
  })

  it("times out model work, falls back deterministically, and never rejects the successful user turn", async () => {
    const { handle, store, flowId } = setup()
    const turn = createRoutedTurn(store, flowId, "Read the bounded output")
    store.recordEvidence({
      projectId: "proj_one",
      flowId,
      goalId: turn.goal.id,
      turnId: turn.turn.id,
      sourceKind: "tool_output",
      title: "Large output",
      content: "bounded output evidence ".repeat(100),
    })
    store.completeTurn({ projectId: "proj_one", flowId, turnId: turn.turn.id, content: "Answer completed." })
    const provider = structuredProvider(async () => await new Promise<never>(() => undefined))
    const service = new V2ContextMaintenanceService({ store, provider, modelTimeoutMs: 250 })

    await expect(service.runAfterTurn({
      projectId: "proj_one",
      flowId,
      goalId: turn.goal.id,
      turnId: turn.turn.id,
      completedTurnOrdinal: 1,
      query: "Read the bounded output",
      runtimeConfig,
      workerRuntime,
    })).resolves.toMatchObject({
      status: "degraded",
      deterministicFallbackUsed: true,
      failureCodes: ["context_distiller_timeout"],
    })
    expect(handle.sqlite.prepare("SELECT status, role FROM v2_model_calls").get()).toMatchObject({ status: "failed", role: "context_distiller" })
    expect(handle.sqlite.prepare("SELECT status FROM v2_turns WHERE id = ?").get(turn.turn.id)).toMatchObject({ status: "completed" })
  })

  it("uses model-aware pressure to append a compact summary and release only active copies", async () => {
    const { handle, store, flowId } = setup()
    const turn = createRoutedTurn(store, flowId, "Summarize architecture evidence")
    const evidenceIds: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const recorded = store.recordEvidence({
        projectId: "proj_one",
        flowId,
        goalId: turn.goal.id,
        turnId: turn.turn.id,
        sourceKind: "tool_output",
        title: `Architecture output ${index + 1}`,
        content: `Architecture fact ${index + 1}. ${"Detailed implementation evidence. ".repeat(100)}`,
      })
      evidenceIds.push(recorded.evidence.id)
    }
    store.completeTurn({ projectId: "proj_one", flowId, turnId: turn.turn.id, content: "Architecture reviewed." })
    const requests: StructuredModelRequest<unknown>[] = []
    const provider = structuredProvider((request) => {
      requests.push(request)
      const body = requestBody(request)
      if (request.system.includes("context compactor")) {
        return {
          summary: "Architecture facts were compacted; consult every exact evidence handle.",
          sourceContextItemIds: body.allSourceContextItemIds,
        }
      }
      const items = body.items as Array<{ contextItemId: string }>
      return { decisions: items.map((item) => ({ contextItemId: item.contextItemId, disposition: "keep_exact" })) }
    })
    const service = new V2ContextMaintenanceService({ store, provider })
    const result = await service.runAfterTurn({
      projectId: "proj_one",
      flowId,
      goalId: turn.goal.id,
      turnId: turn.turn.id,
      completedTurnOrdinal: 1,
      query: "Summarize architecture evidence",
      runtimeConfig: { ...runtimeConfig, contextWindowTokens: 2_048 },
      workerRuntime,
    })

    // The small foreground context window controls pressure/budget even though
    // every maintenance call uses the separately configured worker model.
    expect(workerRuntime.providerId).not.toBe(runtimeConfig.providerId)
    expect(workerRuntime.modelId).not.toBe(runtimeConfig.modelId)
    expect(["compact", "hard_limit"]).toContain(result.pressure)
    expect(result.compactionPerformed).toBe(true)
    expect(result.usedTokensAfter).toBeLessThan(result.usedTokensBefore)
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      expect(request.providerId).toBe(workerRuntime.providerId)
      expect(request.modelId).toBe(workerRuntime.modelId)
      expect(request.runtimeConfig).toMatchObject({
        providerId: workerRuntime.providerId,
        authMode: workerRuntime.authMode,
        modelId: workerRuntime.modelId,
        thinkingEnabled: true,
        thinkingEffort: "low",
      })
    }
    const calls = handle.sqlite.prepare(
      "SELECT role, provider_id AS providerId, model_id AS modelId, request_json AS requestJson FROM v2_model_calls ORDER BY started_at",
    ).all() as Array<{ role: string; providerId: string; modelId: string; requestJson: string }>
    expect(calls.map((call) => call.role)).toEqual(["context_distiller", "context_compactor"])
    for (const call of calls) {
      expect(call.providerId).toBe(workerRuntime.providerId)
      expect(call.modelId).toBe(workerRuntime.modelId)
      expect(JSON.parse(call.requestJson)).toMatchObject({
        workerRuntime: {
          providerId: workerRuntime.providerId,
          modelId: workerRuntime.modelId,
          thinkingEnabled: workerRuntime.thinkingEnabled,
          thinkingEffort: workerRuntime.thinkingEffort,
        },
      })
    }
    const state = store.getCoreContextState(flowId)
    expect(state.items.some((item) => item.active && store.retrieveExactEvidence(flowId, [item.evidenceRef.evidenceId])[0]?.exactContent.includes("compacted"))).toBe(true)
    for (const evidenceId of evidenceIds) {
      expect(store.retrieveExactEvidence(flowId, [evidenceId])[0]?.exactContent).toContain("Detailed implementation evidence")
    }
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM v2_evidence_items WHERE source_kind = 'model_output'").get()).toMatchObject({ count: 1 })
  })

  it("never falls back to the foreground model when no context worker selection is supplied", async () => {
    const { handle, store, flowId } = setup()
    const turn = createRoutedTurn(store, flowId, "Inspect this output")
    store.recordEvidence({
      projectId: "proj_one",
      flowId,
      goalId: turn.goal.id,
      turnId: turn.turn.id,
      sourceKind: "tool_output",
      title: "Worker isolation output",
      content: "Worker isolation evidence. ".repeat(100),
    })
    store.completeTurn({ projectId: "proj_one", flowId, turnId: turn.turn.id, content: "Done." })
    let providerCalls = 0
    const provider = structuredProvider(() => {
      providerCalls += 1
      return { decisions: [] }
    })
    const service = new V2ContextMaintenanceService({ store, provider })

    const result = await service.runAfterTurn({
      projectId: "proj_one",
      flowId,
      goalId: turn.goal.id,
      turnId: turn.turn.id,
      completedTurnOrdinal: turn.turn.ordinal,
      query: "Inspect this output",
      runtimeConfig,
    })

    expect(result).toMatchObject({
      status: "degraded",
      deterministicFallbackUsed: true,
      failureCodes: ["context_distiller_model_unavailable"],
    })
    expect(providerCalls).toBe(0)
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM v2_model_calls").get()).toMatchObject({ count: 0 })
  })
})
