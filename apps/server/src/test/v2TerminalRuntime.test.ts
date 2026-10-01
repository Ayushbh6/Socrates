import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { ToolExecutorContext, V2GoalRouterResult } from "@socrates/core"
import type { V2RuntimeConfig } from "@socrates/contracts"
import type { EmbeddingProvider } from "@socrates/providers"
import { createId, nowIso } from "@socrates/shared"
import { openDatabase, runMigrations, type DatabaseHandle } from "../db/client"
import { SocratesStore } from "../services/store"
import { loadCanonicalTraceRows } from "../services/retrieval/canonicalSources"
import { V2FlowStore, type V2ReadyTerminalTask } from "../services/v2/flowStore"
import { V2TerminalRuntime } from "../v2/terminalRuntime"

const handles: DatabaseHandle[] = []
const sharedStores: SocratesStore[] = []
const roots: string[] = []
const runtimes: V2TerminalRuntime[] = []

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose({ preserveRunning: false })))
  await Promise.allSettled(sharedStores.splice(0).map((store) => store.close()))
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

describe("V2TerminalRuntime supervisor continuity", () => {
  it("preserves a waited PTY across runtime disposal and wakes the same V2 task after reconciliation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-terminal-"))
    roots.push(root)
    const workspace = path.join(root, "workspace")
    fs.mkdirSync(workspace, { recursive: true })
    const handle = openDatabase(path.join(root, "socrates.sqlite"))
    handles.push(handle)
    runMigrations(handle)
    seedProject(handle, workspace)
    const store = new V2FlowStore(handle)
    const flow = store.ensureFlow("proj_terminal").flow
    const created = store.createTurn({
      projectId: "proj_terminal",
      flowId: flow.id,
      clientMessageId: createId("v2msg"),
      content: "Wait for the supervised process",
      runtimeConfig,
    })
    const applied = store.applyRouting({
      projectId: "proj_terminal",
      flowId: flow.id,
      turnId: created.turn.id,
      messageId: created.userMessage.id,
      messageContent: created.userMessage.content,
      result: createGoalResult(),
    })
    const scope = {
      projectId: "proj_terminal",
      flowId: flow.id,
      goalId: applied.goal.id,
      turnId: created.turn.id,
      workspacePath: workspace,
    }
    const context: ToolExecutorContext = {
      projectId: "proj_terminal",
      conversationId: flow.id,
      sessionId: created.turn.id,
      turnId: created.turn.id,
      workspacePath: workspace,
      runtimeConfig,
    }
    const supervisorScope = path.join(root, "supervisor")
    const first = new V2TerminalRuntime(store, () => undefined, { supervisorScope })
    runtimes.push(first)
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => { console.log('durable done') }, 700)")}`
    const started = await first.execute({ operation: "start", command, name: "durable-check" }, scope, context)
    expect(started.terminal).toMatchObject({ name: "durable-check", status: "running" })
    expect(await first.wait({ terminalNames: ["durable-check"], wakeOn: ["completed", "failed"], reason: "Waiting for durable check" }, scope)).toMatchObject({ status: "waiting" })

    await first.dispose({ preserveRunning: true })
    const resumed = new V2TerminalRuntime(store, () => undefined, { supervisorScope })
    runtimes.push(resumed)
    const wakes: V2ReadyTerminalTask[] = []
    resumed.setTaskWakeHandler((task) => wakes.push(task))
    await resumed.reconcilePersistedTerminals()
    await waitUntil(() => wakes.length === 1, "the reconciled Terminal to wake its V2 task")

    expect(wakes[0]).toMatchObject({ rootTurnId: created.turn.id, wakeEvent: "completed", terminalName: "durable-check" })
    const terminal = store.findTerminalRuntimeRecord("proj_terminal", flow.id, "durable-check")
    expect(terminal?.terminal).toMatchObject({ status: "exited", exitCode: 0 })
    expect(store.terminalOutputSnapshot(terminal?.terminal.id ?? "missing").stdout).toContain("durable done")
    const continuation = store.beginTerminalTaskContinuation(wakes[0]!)
    expect(continuation).toMatchObject({ taskId: wakes[0]?.taskId, userMessage: { id: created.userMessage.id } })
    if (!continuation) throw new Error("Expected the durable Terminal task to continue.")
    store.completeTurn({
      projectId: "proj_terminal",
      flowId: flow.id,
      turnId: continuation.turn.id,
      content: "The supervised process completed successfully.",
    })

    const canonical = loadCanonicalTraceRows(handle, "proj_terminal", continuation.turn.id)
    expect(canonical.find((row) => row.matchedRole === "user")?.content).toBe("Wait for the supervised process")
    expect(canonical.find((row) => row.matchedRole === "assistant")?.content).toBe("The supervised process completed successfully.")

    const sharedStore = new SocratesStore(handle, testEmbeddings(), undefined, { socratesHome: path.join(root, "home") })
    sharedStores.push(sharedStore)
    handles.splice(handles.indexOf(handle), 1)
    const exact = await sharedStore.retrieveGlobalToolTraces({
      operation: "inspect",
      projectId: "proj_terminal",
      turnId: continuation.turn.id,
    })
    expect(exact.results[0]?.content).toContain("user: Wait for the supervised process")
    expect(exact.results[0]?.content).toContain("assistant: The supervised process completed successfully.")
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
  }, 15_000)
})

const seedProject = (handle: DatabaseHandle, workspace: string): void => {
  const now = nowIso()
  handle.sqlite.prepare("INSERT INTO users (id, display_name, onboarding_completed, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
    .run("user_terminal", "Terminal User", now, now)
  handle.sqlite.prepare("INSERT INTO projects (id, user_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
    .run("proj_terminal", "user_terminal", "Terminal project", now, now)
  handle.sqlite.prepare("INSERT INTO project_workspaces (id, project_id, kind, path, is_primary, status, created_at, updated_at) VALUES (?, ?, 'existing_folder', ?, 1, 'active', ?, ?)")
    .run("pws_terminal", "proj_terminal", workspace, now, now)
}

const createGoalResult = (): V2GoalRouterResult => ({
  decision: { action: "create", secondaryGoalIds: [], confidence: 1, reasonCode: "new_goal" },
  candidates: { parked: [], candidates: [], totalEligibleParked: 0, parkedCandidateLimit: 5 },
  source: "fallback",
  fallbackReason: "invalid_output",
})

const testEmbeddings = (): EmbeddingProvider => ({
  async check() {
    return { ok: true, dimensions: 3, message: "Test embeddings are ready." }
  },
  async embed() {
    return { embeddings: [[0, 0, 1]], dimensions: 3 }
  },
  async embedMany(request) {
    return { embeddings: request.values.map(() => [0, 0, 1]), dimensions: 3 }
  },
})

const waitUntil = async (predicate: () => boolean, label: string, timeoutMs = 6_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}
