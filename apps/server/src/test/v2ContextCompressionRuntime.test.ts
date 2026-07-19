import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ChatCompaction, V2RuntimeConfig } from "@socrates/contracts"
import { DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS, type V2GoalRouterResult } from "@socrates/core"
import { createId, nowIso } from "@socrates/shared"
import { openDatabase, runMigrations, type DatabaseHandle } from "../db/client"
import type { SocratesStore } from "../services/store"
import {
  createV2ContextCompressionRuntime,
  v2WithinTurnCompressionThresholds,
} from "../services/v2/contextCompressionRuntime"
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

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-within-turn-compaction-"))
  roots.push(root)
  const handle = openDatabase(path.join(root, "socrates.sqlite"))
  handles.push(handle)
  runMigrations(handle)
  const workspacePath = path.join(root, "workspace")
  fs.mkdirSync(workspacePath, { recursive: true })
  const now = nowIso()
  handle.sqlite.prepare(
    "INSERT INTO users (id, display_name, onboarding_completed, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
  ).run("user_compaction", "Compaction User", now, now)
  handle.sqlite.prepare(
    "INSERT INTO projects (id, user_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
  ).run("proj_compaction", "user_compaction", "Compaction Project", now, now)
  handle.sqlite.prepare(
    "INSERT INTO project_workspaces (id, project_id, kind, path, is_primary, status, created_at, updated_at) VALUES (?, ?, 'existing_folder', ?, 1, 'active', ?, ?)",
  ).run("pws_compaction", "proj_compaction", workspacePath, now, now)
  const store = new V2FlowStore(handle)
  const flowId = store.ensureFlow("proj_compaction").flow.id
  const created = store.createTurn({
    projectId: "proj_compaction",
    flowId,
    clientMessageId: createId("v2msg"),
    content: "Inspect a very large set of tool results.",
    runtimeConfig,
  })
  const routed = store.applyRouting({
    projectId: "proj_compaction",
    flowId,
    turnId: created.turn.id,
    messageId: created.userMessage.id,
    messageContent: created.userMessage.content,
    result: forcedCreateResult(store, flowId),
  })
  return { handle, store, flowId, turnId: created.turn.id, goalId: routed.goal.id }
}

const forcedCreateResult = (store: V2FlowStore, flowId: string): V2GoalRouterResult => {
  const foregroundGoal = store.listGoalsForRouter(flowId).find((goal) => goal.status === "foreground")
  const foreground = foregroundGoal ? { goal: foregroundGoal, candidate: 1 } : undefined
  return {
    decision: { action: "create", title: "Test goal" },
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

const sharedStore = {
  getWorkerModelSetting: (_workerId: Parameters<SocratesStore["getWorkerModelSetting"]>[0]) => ({
    workerId: "socrates_context_compactor" as const,
    providerId: "openrouter" as const,
    authMode: "api_key" as const,
    modelId: "deepseek/deepseek-v4-flash",
    thinkingEnabled: false,
    updatedAt: nowIso(),
  }),
  listAvailableModels: () => ({ models: [], defaultModel: null }),
}

const summary: ChatCompaction = {
  schemaVersion: 1,
  goal: "Finish the current Flow goal.",
  constraints: ["Never delete exact evidence."],
  done: ["Read the source material."],
  inProgress: ["Compose the answer."],
  blocked: [],
  decisions: ["Keep only query-relevant tool results in active context."],
  nextSteps: ["Return the result."],
  criticalContext: ["Exact tool output remains in V2 evidence."],
  relevantFiles: [],
  toolState: ["Older results are retrievable by handle."],
  anchors: ["Turn 1: inspect the exact V2 trace."],
}

describe("V2 within-turn context compression runtime", () => {
  it("uses the exact shared Socrates 170k/180k compression policy", () => {
    const thresholds = v2WithinTurnCompressionThresholds()
    expect(thresholds).toEqual(DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS)
    expect(thresholds.triggerTokens).toBe(170_000)
    expect(thresholds.hardLimitTokens).toBe(180_000)
  })

  it("stores immutable V2-only snapshot evidence and restores the latest goal snapshot", async () => {
    const { handle, store, flowId, turnId, goalId } = setup()
    const runtime = createV2ContextCompressionRuntime({
      store,
      sharedStore,
      projectId: "proj_compaction",
      flowId,
      goalId,
      turnId,
      workspacePath: "/tmp/socrates-v2-context-test",
    })
    await runtime.startSnapshot?.({
      snapshotId: "ctxcmp_v2_exact",
      reason: "threshold",
      contextTokensEstimate: 90_000,
      targetTokens: 43_000,
      compressorProviderId: "openrouter",
      compressorModelId: "deepseek/deepseek-v4-flash",
      sourceMessageIds: ["v2msg_source"],
      sourceTurnIds: [turnId],
    })
    await runtime.completeSnapshot?.({
      snapshotId: "ctxcmp_v2_exact",
      summary,
      renderedSummary: "# Flow context\n\nExact evidence remains retrievable.",
      sourceHandles: [{ turnId, flowId, retrieve: `trace_retrieve({ turnId: \"${turnId}\" })` }],
      inputTokensEstimate: 90_000,
      outputTokensEstimate: 120,
      contextTokensAfter: 42_000,
      usage: { inputTokens: 8_000, outputTokens: 120, totalTokens: 8_120 },
      compressorProviderId: "openrouter",
      compressorModelId: "deepseek/deepseek-v4-flash",
    })

    expect(await runtime.getLatestSnapshot?.()).toMatchObject({
      snapshotId: "ctxcmp_v2_exact",
      summary,
      renderedSummary: "# Flow context\n\nExact evidence remains retrievable.",
      outputTokensEstimate: 120,
      sourceHandles: [{ turnId, flowId }],
    })
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM v2_evidence_items").get()).toEqual({ count: 2 })
    expect(handle.sqlite.prepare("SELECT role, status FROM v2_model_calls").get()).toEqual({ role: "context_compactor", status: "completed" })
    expect(handle.sqlite.prepare("SELECT input_tokens, output_tokens FROM v2_usage_events").get()).toEqual({ input_tokens: 8000, output_tokens: 120 })
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
  })

  it("audits a failed compaction without replacing the last completed snapshot", async () => {
    const { handle, store, flowId, turnId, goalId } = setup()
    const runtime = createV2ContextCompressionRuntime({
      store,
      sharedStore,
      projectId: "proj_compaction",
      flowId,
      goalId,
      turnId,
      workspacePath: "/tmp/socrates-v2-context-test",
    })
    await runtime.startSnapshot?.({
      snapshotId: "ctxcmp_v2_failed",
      reason: "threshold",
      contextTokensEstimate: 90_000,
      targetTokens: 43_000,
      compressorProviderId: "openrouter",
      compressorModelId: "deepseek/deepseek-v4-flash",
      sourceMessageIds: [],
      sourceTurnIds: [turnId],
    })
    await runtime.failSnapshot?.({
      snapshotId: "ctxcmp_v2_failed",
      code: "context_compaction_target_not_met",
      message: "The compacted request remained too large.",
    })
    expect(await runtime.getLatestSnapshot?.()).toBeUndefined()
    expect(handle.sqlite.prepare("SELECT status FROM v2_model_calls").get()).toEqual({ status: "failed" })
    expect(handle.sqlite.prepare("SELECT code, recoverable FROM v2_errors").get()).toEqual({
      code: "context_compaction_target_not_met",
      recoverable: 1,
    })
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM v2_evidence_items").get()).toEqual({ count: 2 })
  })
})
