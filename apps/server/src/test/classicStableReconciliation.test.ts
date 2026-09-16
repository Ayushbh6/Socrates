import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { V2GoalRouterResult } from "@socrates/core"
import { createId, nowIso } from "@socrates/shared"
import { openDatabase, runMigrations, type DatabaseHandle } from "../db/client"
import { ErrorStore } from "../services/store/errorStore"
import { TurnStore } from "../services/store/turnStore"
import { reconcileClassicStableRelease } from "../services/classicStableReconciliation"
import { V2FlowStore } from "../services/v2/flowStore"

const handles: DatabaseHandle[] = []
const roots: string[] = []

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const runtimeConfig = {
  providerId: "openai" as const,
  authMode: "api_key" as const,
  modelId: "gpt-test",
  thinkingEnabled: false,
  approvalMode: "manual" as const,
  sandboxMode: "workspace_write" as const,
  contextWindowTokens: 128_000,
}

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-classic-reconciliation-"))
  roots.push(root)
  const handle = openDatabase(path.join(root, "socrates.sqlite"))
  handles.push(handle)
  runMigrations(handle)
  const workspace = path.join(root, "workspace")
  fs.mkdirSync(workspace, { recursive: true })
  const now = nowIso()
  handle.sqlite.prepare(
    "INSERT INTO users (id, display_name, onboarding_completed, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
  ).run("user_repair", "Repair User", now, now)
  handle.sqlite.prepare(
    "INSERT INTO projects (id, user_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
  ).run("proj_repair", "user_repair", "Repair Project", now, now)
  handle.sqlite.prepare(
    "INSERT INTO project_workspaces (id, project_id, kind, path, is_primary, status, created_at, updated_at) VALUES (?, ?, 'existing_folder', ?, 1, 'active', ?, ?)",
  ).run("pws_repair", "proj_repair", workspace, now, now)
  return { handle, store: new V2FlowStore(handle) }
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

describe("Classic-only stable reconciliation", () => {
  it("recovers a missed Flow projection once and makes the Classic conversation writable", () => {
    const { handle, store } = setup()
    const flow = store.ensureFlow("proj_repair").flow
    const created = store.createTurn({
      projectId: "proj_repair",
      flowId: flow.id,
      clientMessageId: createId("v2msg"),
      content: "let us do step 1",
      runtimeConfig,
    })
    const goal = store.applyRouting({
      projectId: "proj_repair",
      flowId: flow.id,
      turnId: created.turn.id,
      messageId: created.userMessage.id,
      messageContent: created.userMessage.content,
      result: forcedCreateResult(store, flow.id),
    }).goal
    store.completeTurn({
      projectId: "proj_repair",
      flowId: flow.id,
      turnId: created.turn.id,
      content: "Step 1 is complete.",
    })
    const bridge = store.getClassicBridge("proj_repair", flow.id, goal.id)

    // Simulate a process interruption after the V2 turn committed but before
    // its Classic projection committed.
    const projectedTurn = handle.sqlite.prepare(
      "SELECT id FROM turns WHERE conversation_id = ? AND metadata_json LIKE ? LIMIT 1",
    ).get(bridge.conversationId, `%${created.turn.id}%`) as { id: string }
    handle.sqlite.prepare("DELETE FROM v2_classic_message_links WHERE bridge_id = ?").run(bridge.id)
    handle.sqlite.prepare("DELETE FROM messages WHERE turn_id = ?").run(projectedTurn.id)
    handle.sqlite.prepare("DELETE FROM turns WHERE id = ?").run(projectedTurn.id)

    const context = { handle, appendEvent: () => undefined }
    const turnStore = new TurnStore(context, new ErrorStore(context))
    expect(() => turnStore.createTurnFromUserMessage(
      "proj_repair",
      bridge.conversationId,
      { clientMessageId: createId("msg"), content: "let us do step 1", runtimeConfig },
    )).toThrowError(expect.objectContaining({ code: "classic_conversation_concurrent_writer" }))

    const first = reconcileClassicStableRelease(handle)
    expect(first).toMatchObject({ alreadyApplied: false, recoveredTurns: 1 })
    expect(first.releasedConversations).toBeGreaterThanOrEqual(1)
    expect(handle.sqlite.prepare(
      "SELECT active_owner AS activeOwner FROM v2_classic_conversation_bridges WHERE id = ?",
    ).get(bridge.id)).toEqual({ activeOwner: "classic" })
    expect(handle.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
    ).get(bridge.conversationId)).toEqual({ count: 2 })

    const classicTurn = turnStore.createTurnFromUserMessage(
      "proj_repair",
      bridge.conversationId,
      { clientMessageId: createId("msg"), content: "continue normally", runtimeConfig },
    )
    expect(classicTurn.userMessage.content).toBe("continue normally")

    const second = reconcileClassicStableRelease(handle)
    expect(second).toEqual({ alreadyApplied: true, recoveredTurns: 0, releasedConversations: 0 })
    expect(handle.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
    ).get(bridge.conversationId)).toEqual({ count: 3 })
  })

  it("keeps concurrent writer protection while releasing stale ownership on restart", () => {
    const { handle, store } = setup()
    const flow = store.ensureFlow("proj_repair").flow
    const created = store.createTurn({
      projectId: "proj_repair",
      flowId: flow.id,
      clientMessageId: createId("v2msg"),
      content: "active work",
      runtimeConfig,
    })
    const goal = store.applyRouting({
      projectId: "proj_repair",
      flowId: flow.id,
      turnId: created.turn.id,
      messageId: created.userMessage.id,
      messageContent: created.userMessage.content,
      result: forcedCreateResult(store, flow.id),
    }).goal
    const bridge = store.getClassicBridge("proj_repair", flow.id, goal.id)
    handle.sqlite.prepare("UPDATE v2_classic_conversation_bridges SET active_owner = 'v2' WHERE id = ?").run(bridge.id)

    const first = reconcileClassicStableRelease(handle)
    expect(first.releasedConversations).toBeGreaterThanOrEqual(1)
    handle.sqlite.prepare("UPDATE v2_classic_conversation_bridges SET active_owner = 'v2' WHERE id = ?").run(bridge.id)
    const activeRestart = reconcileClassicStableRelease(handle)
    expect(activeRestart).toEqual({ alreadyApplied: true, recoveredTurns: 0, releasedConversations: 0 })

    const context = { handle, appendEvent: () => undefined }
    const turnStore = new TurnStore(context, new ErrorStore(context))
    expect(() => turnStore.createTurnFromUserMessage(
      "proj_repair",
      bridge.conversationId,
      { clientMessageId: createId("msg"), content: "must not race", runtimeConfig },
    )).toThrowError(expect.objectContaining({ code: "classic_conversation_concurrent_writer" }))

    handle.sqlite.prepare("UPDATE v2_turns SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?")
      .run(nowIso(), nowIso(), created.turn.id)
    expect(reconcileClassicStableRelease(handle)).toEqual({ alreadyApplied: true, recoveredTurns: 0, releasedConversations: 1 })
    expect(turnStore.createTurnFromUserMessage(
      "proj_repair",
      bridge.conversationId,
      { clientMessageId: createId("msg"), content: "safe after restart", runtimeConfig },
    ).userMessage.content).toBe("safe after restart")
  })
})
