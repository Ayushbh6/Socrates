import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { WebSocket } from "ws"
import { type V2ClientCommand, type V2RuntimeConfig, type V2ServerEvent } from "@socrates/contracts"
import { DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS, createDefaultToolRegistry, routeV2Goal, SocratesAgent } from "@socrates/core"
import type { EmbeddingProvider, ModelProvider, StructuredModelRequest } from "@socrates/providers"
import { createId, nowIso } from "@socrates/shared"
import { openDatabase, runMigrations, type DatabaseHandle } from "../db/client"
import { SocratesStore } from "../services/store"
import { V2FlowStore } from "../services/v2/flowStore"
import { V2ExecutionRuntime } from "../v2/runtime"
import { createV2ToolExecutors } from "../v2/toolExecutors"

type MessageSendCommand = Extract<V2ClientCommand, { type: "v2.message.send" }>
type SubscribeCommand = Extract<V2ClientCommand, { type: "v2.flow.subscribe" }>
type CredentialCommand = Extract<V2ClientCommand, { type: "v2.credential.input.submit" }>
type ApprovalCommand = Extract<V2ClientCommand, { type: "v2.approval.decide" }>

type TestRuntime = {
  root: string
  workspace: string
  handle: DatabaseHandle
  sharedStore: SocratesStore
  flowStore: V2FlowStore
  agent: SocratesAgent
  runtime: V2ExecutionRuntime
}

const runtimes: TestRuntime[] = []
const gateReleases: Array<() => void> = []

afterEach(async () => {
  for (const release of gateReleases.splice(0)) release()
  for (const testRuntime of runtimes.splice(0)) {
    await testRuntime.runtime.shutdown(2_000)
    await testRuntime.sharedStore.close()
    fs.rmSync(testRuntime.root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
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

class FakeSocket {
  readonly readyState = 1
  readonly sent: V2ServerEvent[] = []
  private readonly closeListeners: Array<() => void> = []

  on(event: string, listener: () => void): this {
    if (event === "close") this.closeListeners.push(listener)
    return this
  }

  send(data: unknown): void {
    this.sent.push(JSON.parse(String(data)) as V2ServerEvent)
  }

  close(): void {
    for (const listener of this.closeListeners) listener()
  }
}

const asWebSocket = (socket: FakeSocket): WebSocket => socket as unknown as WebSocket

const fakeEmbeddings = (): EmbeddingProvider => ({
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

const fakeCountTokens: ModelProvider["countTokens"] = async (request) => {
  const baseTokens = Math.max(1, Math.ceil(`${request.system}${JSON.stringify(request.messages)}${JSON.stringify(request.tools ?? [])}`.length / 4))
  return {
    providerId: request.providerId,
    modelId: request.modelId,
    inputTokens: baseTokens,
    baseTokens,
    method: "local_tiktoken",
    safetyMarginPercent: 0,
  }
}

const userText = (request: Parameters<ModelProvider["stream"]>[0]): string =>
  request.messages
    .filter((message) => message.role === "user")
    .flatMap((message) => typeof message.content === "string"
      ? [message.content]
      : message.content.filter((part) => part.type === "text").map((part) => part.text))
    .join("\n")

const hasToolResult = (request: Parameters<ModelProvider["stream"]>[0], toolName: string): boolean =>
  request.messages.some((message) =>
    Array.isArray(message.content) && message.content.some((part) => part.type === "tool-result" && part.toolName === toolName),
  )

const toolProofProvider = (): ModelProvider => ({
  countTokens: fakeCountTokens,
  async *stream(request) {
    if (userText(request).includes("read proof") && !hasToolResult(request, "read")) {
      yield {
        type: "model.tool_call.completed",
        toolCall: {
          toolCallId: createId("v2tcall"),
          toolName: "read",
          input: { path: "note.txt" },
        },
      }
      yield { type: "model.completed", usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 } }
      return
    }
    yield { type: "model.answer.delta", text: "Read V2 evidence successfully." }
    yield { type: "model.completed", usage: { inputTokens: 24, outputTokens: 5, totalTokens: 29 } }
  },
})

const frontierProofProvider = () => {
  const requests: Array<Parameters<ModelProvider["stream"]>[0]> = []
  let requestedHandover = false
  const provider: ModelProvider = {
    countTokens: fakeCountTokens,
    async generateStructured<TOutput>() {
      return { output: {} as TOutput }
    },
    async *stream(request) {
      requests.push(request)
      const toolNames = request.tools?.map((tool) => tool.name) ?? []
      if (!toolNames.includes("handover_to_frontier") && (toolNames.includes("memory_search") || toolNames.includes("turn_evidence"))) {
        const postEvidence = JSON.stringify(request.messages).includes("post-evidence")
        yield {
          type: "model.answer.delta",
          text: JSON.stringify(postEvidence
            ? { actions: [], reason: "No durable update is needed.", goalFinalization: null }
            : { readTargets: [], reason: "No routed recall is needed.", goalRoute: null }),
        }
        yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }
        return
      }
      if (!requestedHandover && toolNames.includes("handover_to_frontier")) {
        requestedHandover = true
        yield { type: "model.answer.delta", text: "Discard this V2 driver draft." }
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "provider_v2_frontier_handover",
            toolName: "handover_to_frontier",
            input: { focus: "Resolve the final V2 lifecycle invariant" },
          },
        }
        yield { type: "model.completed", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }
        return
      }
      yield { type: "model.answer.delta", text: "Frontier-only V2 answer." }
      yield { type: "model.completed", usage: { inputTokens: 18, outputTokens: 5, totalTokens: 23 } }
    },
  }
  return { provider, requests }
}

const repairedMemoryRouterProvider = (): ModelProvider => {
  const attempts = new Map<string, number>()
  return {
    countTokens: fakeCountTokens,
    async *stream(request) {
      if (request.system.includes("Memory Router Agent")) {
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Memory-router telemetry persisted." }
      yield { type: "model.completed", usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 } }
    },
    async generateStructured<TOutput>(request: StructuredModelRequest<TOutput>) {
      const phase = request.system.includes("post-evidence") ? "post_evidence" : "pre_turn"
      const attempt = (attempts.get(phase) ?? 0) + 1
      attempts.set(phase, attempt)
      const usage = { inputTokens: 10 + attempt, outputTokens: 2, totalTokens: 12 + attempt }
      if (attempt === 1) return { output: { invalid: true } as TOutput, usage }
      const output = phase === "post_evidence"
        ? { actions: [], reason: "No reconciliation needed.", goalFinalization: null }
        : { readTargets: [], reason: "No memory recall needed.", goalRoute: null }
      return { output: output as TOutput, usage }
    },
  }
}

const goalRouterProvider = (): ModelProvider => ({
  countTokens: fakeCountTokens,
  async *stream() {
    yield { type: "model.completed" }
  },
  async generateStructured<TOutput>() {
    return {
      output: {
        action: "create",
        candidates: [],
        title: "Continue the requested work",
      } as TOutput,
      usage: { inputTokens: 17, outputTokens: 3, totalTokens: 20 },
    }
  },
})

const controlledParallelProvider = () => {
  let releaseGate: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  gateReleases.push(releaseGate)
  let active = 0
  let maxActive = 0
  const provider: ModelProvider = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      if (userText(request).includes("parallel")) {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.race([
          gate,
          new Promise<void>((resolve) => request.abortSignal?.addEventListener("abort", () => resolve(), { once: true })),
        ])
        active -= 1
      }
      if (request.abortSignal?.aborted) return
      yield { type: "model.answer.delta", text: `Completed ${userText(request).trim()}.` }
      yield { type: "model.completed", usage: { totalTokens: 10 } }
    },
  }
  return { provider, release: releaseGate, getActive: () => active, getMaxActive: () => maxActive }
}

const setup = (provider: ModelProvider, projectId = "proj_one", routerProvider?: ModelProvider): TestRuntime => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-runtime-"))
  const workspace = path.join(root, "workspace-one")
  const handle = openDatabase(path.join(root, "socrates.sqlite"))
  runMigrations(handle)
  seedProject(handle, projectId, workspace)
  const sharedStore = new SocratesStore(handle, fakeEmbeddings(), undefined, { socratesHome: path.join(root, "home") })
  vi.spyOn(sharedStore, "resolveRuntimeConfig").mockImplementation((config) => config)
  const flowStore = new V2FlowStore(handle)
  const agent = new SocratesAgent(provider)
  const runtime = new V2ExecutionRuntime({
    store: flowStore,
    sharedStore,
    agent,
    ...(routerProvider ? { routerProvider } : {}),
  })
  const result = { root, workspace, handle, sharedStore, flowStore, agent, runtime }
  runtimes.push(result)
  return result
}

const seedProject = (handle: DatabaseHandle, projectId: string, workspacePath: string): void => {
  fs.mkdirSync(workspacePath, { recursive: true })
  const now = nowIso()
  handle.sqlite.prepare(
    "INSERT OR IGNORE INTO users (id, display_name, onboarding_completed, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
  ).run("user_v2_runtime", "V2 Runtime User", now, now)
  handle.sqlite.prepare(
    "INSERT INTO projects (id, user_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
  ).run(projectId, "user_v2_runtime", projectId, now, now)
  handle.sqlite.prepare(
    "INSERT INTO project_workspaces (id, project_id, kind, path, is_primary, status, created_at, updated_at) VALUES (?, ?, 'existing_folder', ?, 1, 'active', ?, ?)",
  ).run(`pws_${projectId}`, projectId, workspacePath, now, now)
}

const messageCommand = (projectId: string, flowId: string, content: string): MessageSendCommand => ({
  id: createId("v2evt"),
  schemaVersion: 2,
  timestamp: nowIso(),
  projectId,
  flowId,
  actor: { type: "user" },
  type: "v2.message.send",
  payload: {
    clientMessageId: createId("v2msg"),
    content,
    runtimeConfig,
  },
})

const subscribeCommand = (projectId: string, flowId: string, afterSequence = 0): SubscribeCommand => ({
  id: createId("v2evt"),
  schemaVersion: 2,
  timestamp: nowIso(),
  projectId,
  flowId,
  actor: { type: "user" },
  type: "v2.flow.subscribe",
  payload: { afterSequence },
})

const waitUntil = async (predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${message}`)
}

describe("V2ExecutionRuntime", () => {
  it("uses the same Socrates post-turn precompute path and fixed thresholds as Classic", async () => {
    const testRuntime = setup(toolProofProvider())
    const precompute = vi.spyOn(testRuntime.agent, "precomputeContext")
    const flow = testRuntime.flowStore.ensureFlow("proj_one").flow

    await testRuntime.runtime.startTurn(asWebSocket(new FakeSocket()), messageCommand("proj_one", flow.id, "Keep the shared Socrates compactor invariant"))
    await waitUntil(() => testRuntime.flowStore.getSnapshot("proj_one", flow.id).activeTurn === undefined, "the shared precompute turn to complete")

    expect(precompute).toHaveBeenCalledTimes(1)
    const input = precompute.mock.calls[0]?.[0]
    expect(input?.contextCompression.thresholds).toEqual(DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS)
    expect(JSON.stringify(input?.messages)).toContain("Keep the shared Socrates compactor invariant")
    expect(JSON.stringify(input?.messages)).toContain("Read V2 evidence successfully.")
  })

  it("provides an executor for every shared Socrates tool that is not core-internal", async () => {
    const testRuntime = setup(toolProofProvider())
    const flow = testRuntime.flowStore.ensureFlow("proj_one").flow
    const created = testRuntime.flowStore.createTurn({
      projectId: "proj_one",
      flowId: flow.id,
      clientMessageId: createId("v2msg"),
      content: "Verify the shared Socrates tool surface.",
      runtimeConfig,
    })
    const routing = await routeV2Goal({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: created.turn.id,
      workspacePath: testRuntime.workspace,
      userMessage: created.userMessage.content,
      goals: [],
    })
    const applied = testRuntime.flowStore.applyRouting({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: created.turn.id,
      messageId: created.userMessage.id,
      messageContent: created.userMessage.content,
      result: routing,
    })
    const executors = createV2ToolExecutors({
      flowStore: testRuntime.flowStore,
      sharedStore: testRuntime.sharedStore,
      activeTurns: testRuntime.runtime.activeTurns,
      terminals: testRuntime.runtime.terminals,
      projectId: "proj_one",
      flowId: flow.id,
      goalId: applied.goal.id,
      turnId: created.turn.id,
      workspacePath: testRuntime.workspace,
    })
    const coreInternalTools = new Set(["handover_to_frontier"])
    const sharedExecutorTools = createDefaultToolRegistry()
      .list()
      .map((tool) => tool.name)
      .filter((name) => !coreInternalTools.has(name))

    expect(sharedExecutorTools).toHaveLength(18)
    expect(sharedExecutorTools.filter((name) => typeof Reflect.get(executors, name) !== "function")).toEqual([])
    expect(testRuntime.flowStore.countV1Rows()).toEqual({
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

  it("runs a shared Socrates read tool through V2-only persistence and replays an authoritative snapshot last", async () => {
    const testRuntime = setup(toolProofProvider())
    fs.writeFileSync(path.join(testRuntime.workspace, "note.txt"), "immutable V2 tool evidence")
    const baselineV1Rows = testRuntime.flowStore.countV1Rows()
    const flow = testRuntime.flowStore.ensureFlow("proj_one").flow
    const liveSocket = new FakeSocket()

    await testRuntime.runtime.startTurn(asWebSocket(liveSocket), messageCommand("proj_one", flow.id, "read proof from note.txt"))
    await waitUntil(
      () => testRuntime.flowStore.getSnapshot("proj_one", flow.id).activeTurn === undefined,
      "the V2 read turn to complete",
    )

    const snapshot = testRuntime.flowStore.getSnapshot("proj_one", flow.id)
    expect(snapshot.messages.at(-1)).toMatchObject({ role: "assistant", content: "Read V2 evidence successfully.", status: "completed" })
    const toolRows = testRuntime.handle.sqlite.prepare(
      "SELECT tool_name AS toolName, status, result_json AS resultJson FROM v2_tool_calls ORDER BY started_at",
    ).all() as Array<{ toolName: string; status: string; resultJson: string }>
    expect(toolRows).toHaveLength(1)
    expect(toolRows[0]).toMatchObject({ toolName: "read", status: "completed" })
    expect(toolRows[0]?.resultJson).toContain("immutable V2 tool evidence")
    const context = testRuntime.flowStore.getCoreContextState(flow.id)
    expect(context.evidence.some((record) => record.exactContent.includes("immutable V2 tool evidence"))).toBe(true)
    expect(liveSocket.sent.some((event) => event.type === "v2.goal.capsule.updated" && event.payload.capsule.version === 2)).toBe(true)
    expect(testRuntime.flowStore.countV1Rows()).toEqual(baselineV1Rows)
    expect(fs.existsSync(path.join(testRuntime.workspace, ".socrates"))).toBe(true)

    const replaySocket = new FakeSocket()
    testRuntime.runtime.subscribe(asWebSocket(replaySocket), subscribeCommand("proj_one", flow.id))
    expect(replaySocket.sent[0]?.type).toBe("v2.connection.ready")
    expect(replaySocket.sent.some((event) => event.type === "v2.tool.call.updated")).toBe(true)
    const finalReplayEvent = replaySocket.sent.at(-1)
    expect(finalReplayEvent?.type).toBe("v2.flow.snapshot")
    if (finalReplayEvent?.type === "v2.flow.snapshot") {
      expect(finalReplayEvent.payload.snapshot.lastEventSequence).toBe(snapshot.lastEventSequence)
    }
  })

  it("persists each repaired Memory Router attempt as its own V2 model call and usage row", async () => {
    const testRuntime = setup(repairedMemoryRouterProvider())
    const flow = testRuntime.flowStore.ensureFlow("proj_one").flow
    await testRuntime.runtime.startTurn(asWebSocket(new FakeSocket()), messageCommand("proj_one", flow.id, "Check memory-router telemetry"))
    await waitUntil(() => testRuntime.flowStore.getSnapshot("proj_one", flow.id).activeTurn === undefined, "the repaired router turn to complete")

    const calls = testRuntime.handle.sqlite.prepare(
      "SELECT id, status FROM v2_model_calls WHERE role = 'memory_router' ORDER BY started_at, id",
    ).all() as Array<{ id: string; status: string }>
    const usages = testRuntime.handle.sqlite.prepare(
      "SELECT model_call_id AS modelCallId FROM v2_usage_events WHERE model_call_id IN (SELECT id FROM v2_model_calls WHERE role = 'memory_router')",
    ).all() as Array<{ modelCallId: string }>
    expect(calls).toHaveLength(4)
    expect(calls.every((call) => call.status === "completed")).toBe(true)
    expect(usages).toHaveLength(4)
    expect(new Set(usages.map((usage) => usage.modelCallId))).toEqual(new Set(calls.map((call) => call.id)))
    expect(testRuntime.flowStore.countV1Rows().model_calls).toBe(0)
  })

  it("persists the model-backed Goal Router attempt and usage in V2 telemetry", async () => {
    const testRuntime = setup(toolProofProvider(), "proj_one", goalRouterProvider())
    const flow = testRuntime.flowStore.ensureFlow("proj_one").flow
    await testRuntime.runtime.startTurn(asWebSocket(new FakeSocket()), messageCommand("proj_one", flow.id, "Create a routed goal"))
    await waitUntil(() => testRuntime.flowStore.getSnapshot("proj_one", flow.id).activeTurn === undefined, "the model-routed turn to complete")

    const call = testRuntime.handle.sqlite.prepare(
      "SELECT id, status, provider_id AS providerId, model_id AS modelId FROM v2_model_calls WHERE role = 'goal_router'",
    ).get() as { id: string; status: string; providerId: string; modelId: string }
    const usage = testRuntime.handle.sqlite.prepare(
      "SELECT input_tokens AS inputTokens, output_tokens AS outputTokens, total_tokens AS totalTokens FROM v2_usage_events WHERE model_call_id = ?",
    ).get(call.id) as { inputTokens: number; outputTokens: number; totalTokens: number }
    const routerErrors = testRuntime.handle.sqlite.prepare(
      "SELECT code, message, details_json AS detailsJson FROM v2_errors WHERE source = 'goal_router'",
    ).all()
    const routerModel = testRuntime.sharedStore.getWorkerModelSetting("goal_router")
    expect({ call, routerErrors }).toMatchObject({ call: { status: "completed", providerId: routerModel.providerId, modelId: routerModel.modelId }, routerErrors: [] })
    expect(usage).toEqual({ inputTokens: 17, outputTokens: 3, totalTokens: 20 })
    expect(testRuntime.flowStore.countV1Rows().model_calls).toBe(0)
  })

  it("rejects an overlapping turn in one Flow while running separate projects concurrently", async () => {
    const controlled = controlledParallelProvider()
    const testRuntime = setup(controlled.provider)
    const secondWorkspace = path.join(testRuntime.root, "workspace-two")
    seedProject(testRuntime.handle, "proj_two", secondWorkspace)
    const firstFlow = testRuntime.flowStore.ensureFlow("proj_one").flow
    const secondFlow = testRuntime.flowStore.ensureFlow("proj_two").flow
    const baselineV1Rows = testRuntime.flowStore.countV1Rows()

    await testRuntime.runtime.startTurn(asWebSocket(new FakeSocket()), messageCommand("proj_one", firstFlow.id, "parallel one"))
    await expect(
      testRuntime.runtime.startTurn(asWebSocket(new FakeSocket()), messageCommand("proj_one", firstFlow.id, "overlapping same flow")),
    ).rejects.toThrow(/already working/i)
    await testRuntime.runtime.startTurn(asWebSocket(new FakeSocket()), messageCommand("proj_two", secondFlow.id, "parallel two"))

    await waitUntil(() => controlled.getActive() === 2, "both project-scoped model calls to overlap")
    expect(controlled.getMaxActive()).toBe(2)
    controlled.release()
    await waitUntil(
      () => testRuntime.flowStore.getSnapshot("proj_one", firstFlow.id).activeTurn === undefined &&
        testRuntime.flowStore.getSnapshot("proj_two", secondFlow.id).activeTurn === undefined,
      "both independent Flow turns to finish",
    )
    expect(testRuntime.flowStore.getSnapshot("proj_one", firstFlow.id).messages.at(-1)?.content).toContain("parallel one")
    expect(testRuntime.flowStore.getSnapshot("proj_two", secondFlow.id).messages.at(-1)?.content).toContain("parallel two")
    expect(testRuntime.flowStore.countV1Rows()).toEqual(baselineV1Rows)
  })

  it("shares the Memory Agent while preserving a V2 source trace and zero Classic runtime rows", async () => {
    const testRuntime = setup(toolProofProvider())
    const flow = testRuntime.flowStore.ensureFlow("proj_one").flow
    const created = testRuntime.flowStore.createTurn({
      projectId: "proj_one",
      flowId: flow.id,
      clientMessageId: createId("v2msg"),
      content: "Remember that I prefer exact restart evidence.",
      runtimeConfig,
    })
    const routing = await routeV2Goal({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: created.turn.id,
      workspacePath: testRuntime.workspace,
      userMessage: created.userMessage.content,
      goals: [],
    })
    const applied = testRuntime.flowStore.applyRouting({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: created.turn.id,
      messageId: created.userMessage.id,
      messageContent: created.userMessage.content,
      result: routing,
    })
    testRuntime.flowStore.completeTurn({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: created.turn.id,
      content: "I will preserve exact restart evidence.",
    })
    testRuntime.flowStore.recordEvidence({
      projectId: "proj_one",
      flowId: flow.id,
      goalId: applied.goal.id,
      turnId: created.turn.id,
      sourceKind: "tool_output",
      sourceId: "memory_bridge_proof",
      title: "V2 immutable memory evidence",
      content: "V2IMMUTABLE-MEMORY-TRACE-77",
      locator: { kind: "test_memory_bridge" },
    })
    const terminal = testRuntime.flowStore.createTerminal({
      projectId: "proj_one",
      flowId: flow.id,
      goalId: applied.goal.id,
      turnId: created.turn.id,
      name: "memory-bridge-terminal",
      command: "printf V2TERMINAL-MEMORY-TRACE-88",
      cwd: testRuntime.workspace,
    })
    testRuntime.flowStore.appendTerminalOutput(terminal.id, "stdout", "V2TERMINAL-MEMORY-TRACE-88\n")
    testRuntime.flowStore.updateTerminal(terminal.id, { status: "exited", exitCode: 0, completedAt: nowIso() })
    testRuntime.flowStore.recordError({
      projectId: "proj_one",
      flowId: flow.id,
      goalId: applied.goal.id,
      turnId: created.turn.id,
      source: "test",
      code: "v2_memory_bridge_proof",
      message: "V2ERROR-MEMORY-TRACE-99",
      recoverable: true,
    })
    const source = testRuntime.flowStore.getTurnMemorySource("proj_one", flow.id, created.turn.id)
    testRuntime.sharedStore.createMemoryNote("proj_one", {
      note: "The user strongly prefers exact restart evidence.",
      importance: "high",
    }, {
      conversationId: flow.id,
      sessionId: created.turn.id,
      turnId: created.turn.id,
      ...source,
      sourceRuntime: "v2_flow",
      appendClassicEvent: false,
    })

    const note = testRuntime.handle.sqlite.prepare(
      "SELECT message_id AS messageId, message_excerpt AS messageExcerpt, metadata_json AS metadataJson FROM memory_notes LIMIT 1",
    ).get() as { messageId: string; messageExcerpt: string; metadataJson: string }
    expect(note.messageId).toBe(created.userMessage.id)
    expect(note.messageExcerpt).toContain("exact restart evidence")
    expect(JSON.parse(note.metadataJson)).toMatchObject({ sourceRuntime: "v2_flow" })
    expect((testRuntime.handle.sqlite.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count).toBe(0)
    expect(testRuntime.sharedStore.getMemoryAgent().pending).toMatchObject({ turnCount: 1, shouldRun: true })

    const searched = await testRuntime.sharedStore.retrieveGlobalToolTraces({
      mode: "audit",
      projectId: "proj_one",
      conversationId: flow.id,
      query: "V2IMMUTABLE-MEMORY-TRACE-77",
      include: ["files"],
    })
    expect(searched.results[0]).toMatchObject({ turnId: created.turn.id, conversationTitle: `Seamless Flow · ${applied.goal.title}` })
    expect(searched.results[0]?.content).toContain("V2IMMUTABLE-MEMORY-TRACE-77")
    const trace = await testRuntime.sharedStore.retrieveGlobalToolTraces({ operation: "inspect", resultNumber: 1 })
    expect(trace.results[0]).toMatchObject({
      turnId: created.turn.id,
      conversationTitle: `Seamless Flow · ${applied.goal.title}`,
      matchedRole: "assistant",
      status: "complete",
    })
    expect(trace.results[0]?.content).toContain("Remember that I prefer exact restart evidence.")
    expect(trace.results[0]?.content).toContain("I will preserve exact restart evidence.")
    expect(trace.results[0]?.content).toContain("V2IMMUTABLE-MEMORY-TRACE-77")
    expect(trace.results[0]?.content).toContain("V2TERMINAL-MEMORY-TRACE-88")
    expect(trace.results[0]?.content).toContain("V2ERROR-MEMORY-TRACE-99")

    const mainTraceTools = createV2ToolExecutors({
      flowStore: testRuntime.flowStore,
      sharedStore: testRuntime.sharedStore,
      activeTurns: testRuntime.runtime.activeTurns,
      terminals: testRuntime.runtime.terminals,
      projectId: "proj_one",
      flowId: flow.id,
      goalId: applied.goal.id,
      turnId: created.turn.id,
      workspacePath: testRuntime.workspace,
    })
    const toolContext = {
      projectId: "proj_one",
      conversationId: flow.id,
      sessionId: created.turn.id,
      turnId: created.turn.id,
      workspacePath: testRuntime.workspace,
      runtimeConfig,
    }
    const mainAudit = await mainTraceTools.trace_retrieve({
      mode: "audit",
      query: "V2TERMINAL-MEMORY-TRACE-88",
      include: ["shell"],
    }, toolContext)
    const auditResult = mainAudit.results[0]
    expect(auditResult && "content" in auditResult ? auditResult.content : "").toContain("V2TERMINAL-MEMORY-TRACE-88")
    const mainInspect = await mainTraceTools.trace_retrieve({ operation: "inspect", resultNumber: 1 }, toolContext)
    expect(mainInspect.results[0]).toMatchObject({ conversationTitle: `Seamless Flow · ${applied.goal.title}` })
    const inspectResult = mainInspect.results[0]
    expect(inspectResult && "content" in inspectResult ? inspectResult.content : "").toContain("V2ERROR-MEMORY-TRACE-99")

    const completedNote = testRuntime.sharedStore.runMemoryNotesTool({
      operation: "mark_done",
      noteNumber: 1,
      outcome: "applied",
      resolution: "Stored the V2 preference without writing a Classic event.",
    })
    expect(completedNote.notes[0]).toMatchObject({ status: "done", outcome: "applied" })
    expect((testRuntime.handle.sqlite.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count).toBe(0)
    expect(testRuntime.flowStore.countV1Rows()).toEqual({
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

  it("persists an approved one-way Frontier handover entirely in V2 and returns only Frontier's answer", async () => {
    const frontier = frontierProofProvider()
    const testRuntime = setup(frontier.provider)
    const flow = testRuntime.flowStore.ensureFlow("proj_one").flow
    const baselineV1Rows = testRuntime.flowStore.countV1Rows()
    const socket = new FakeSocket()

    await testRuntime.runtime.startTurn(
      asWebSocket(socket),
      messageCommand("proj_one", flow.id, "Solve the difficult V2 lifecycle problem without restarting work."),
    )
    await waitUntil(
      () => socket.sent.some((event) => event.type === "v2.approval.updated" && event.payload.approval.status === "pending"),
      "the V2 Frontier approval request",
    )
    const pendingEvent = socket.sent.find(
      (event) => event.type === "v2.approval.updated" && event.payload.approval.status === "pending",
    )
    if (pendingEvent?.type !== "v2.approval.updated") throw new Error("Expected a pending V2 Frontier approval.")
    expect(pendingEvent.payload.approval).toMatchObject({
      actionKind: "other",
      status: "pending",
      action: {
        toolName: "handover_to_frontier",
        title: "Call Frontier model",
        actionPreview: "Focus: Resolve the final V2 lifecycle invariant",
        risk: "medium",
      },
    })

    const approvalCommand: ApprovalCommand = {
      id: createId("v2evt"),
      schemaVersion: 2,
      timestamp: nowIso(),
      projectId: "proj_one",
      flowId: flow.id,
      actor: { type: "user" },
      type: "v2.approval.decide",
      payload: { approvalId: pendingEvent.payload.approval.id, decision: "approved" },
    }
    testRuntime.runtime.decideApproval(approvalCommand)

    await waitUntil(
      () => testRuntime.flowStore.getSnapshot("proj_one", flow.id).activeTurn === undefined,
      "the approved V2 Frontier handover to complete",
    )
    const snapshot = testRuntime.flowStore.getSnapshot("proj_one", flow.id)
    expect(snapshot.messages.at(-1)).toMatchObject({
      role: "assistant",
      status: "completed",
      content: "Frontier-only V2 answer.",
    })
    expect(snapshot.messages.at(-1)?.content).not.toContain("Discard this V2 driver draft.")

    const approvalRows = testRuntime.handle.sqlite.prepare(
      "SELECT status, decision, decided_by AS decidedBy FROM v2_approvals",
    ).all() as Array<{ status: string; decision: string | null; decidedBy: string | null }>
    expect(approvalRows).toEqual([{ status: "approved", decision: "approved", decidedBy: "user" }])
    expect(socket.sent.some((event) => event.type === "v2.approval.updated" && event.payload.approval.status === "approved")).toBe(true)
    expect(socket.sent.some((event) => event.type === "v2.agent.handover" && event.payload.toModelId === "x-ai/grok-4.5")).toBe(true)

    const calls = testRuntime.handle.sqlite.prepare(
      "SELECT role, provider_id AS providerId, model_id AS modelId, status FROM v2_model_calls WHERE role IN ('main_agent','frontier_agent') ORDER BY started_at, id",
    ).all() as Array<{ role: string; providerId: string; modelId: string; status: string }>
    expect(calls.filter((call) => call.role === "main_agent")).toEqual([
      { role: "main_agent", providerId: "openai", modelId: "gpt-test", status: "completed" },
    ])
    const frontierCalls = calls.filter((call) => call.role === "frontier_agent")
    expect(frontierCalls.length).toBeGreaterThan(0)
    expect(frontierCalls.every((call) => call.providerId === "openrouter" && call.modelId === "x-ai/grok-4.5" && call.status === "completed")).toBe(true)
    expect(frontier.requests.some((request) => request.tools?.some((tool) => tool.name === "handover_to_frontier"))).toBe(true)
    expect(frontier.requests.filter((request) => request.modelId === "x-ai/grok-4.5").every(
      (request) => !request.tools?.some((tool) => tool.name === "handover_to_frontier"),
    )).toBe(true)
    expect(testRuntime.flowStore.countV1Rows()).toEqual(baselineV1Rows)
  }, 15_000)

  it("persists a schema-invalid tool call as failed without failing the V2 turn", async () => {
    let attemptedInvalidCall = false
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream() {
        if (!attemptedInvalidCall) {
          attemptedInvalidCall = true
          yield {
            type: "model.tool_call.completed",
            toolCall: { toolCallId: createId("v2tcall"), toolName: "read", input: {} },
          }
          yield { type: "model.completed", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
          return
        }
        yield { type: "model.answer.delta", text: "Recovered after the invalid tool request." }
        yield { type: "model.completed", usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } }
      },
    }
    const testRuntime = setup(provider)
    const flow = testRuntime.flowStore.ensureFlow("proj_one").flow

    await testRuntime.runtime.startTurn(
      asWebSocket(new FakeSocket()),
      messageCommand("proj_one", flow.id, "Read the proof and recover if a tool argument is invalid."),
    )
    await waitUntil(
      () => testRuntime.flowStore.getSnapshot("proj_one", flow.id).activeTurn === undefined,
      "the V2 turn with an invalid tool argument to complete",
    )

    const snapshot = testRuntime.flowStore.getSnapshot("proj_one", flow.id)
    expect(snapshot.messages.at(-1)).toMatchObject({
      role: "assistant",
      status: "completed",
      content: "Recovered after the invalid tool request.",
    })
    const failedCalls = testRuntime.handle.sqlite.prepare(
      "SELECT tool_name AS toolName, status FROM v2_tool_calls WHERE status = 'failed'",
    ).all() as Array<{ toolName: string; status: string }>
    expect(failedCalls).toEqual([{ toolName: "read", status: "failed" }])
    const errors = testRuntime.handle.sqlite.prepare(
      "SELECT code FROM v2_errors WHERE source = 'tool'",
    ).all() as Array<{ code: string }>
    expect(errors).toContainEqual({ code: "invalid_tool_input" })
  })

  it("hands a submitted credential to the live turn without persisting or emitting the secret", async () => {
    const testRuntime = setup(toolProofProvider())
    const flow = testRuntime.flowStore.ensureFlow("proj_one").flow
    const created = testRuntime.flowStore.createTurn({
      projectId: "proj_one",
      flowId: flow.id,
      clientMessageId: createId("v2msg"),
      content: "Connect a credentialed tool",
      runtimeConfig,
    })
    const routing = await routeV2Goal({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: created.turn.id,
      workspacePath: testRuntime.workspace,
      userMessage: created.userMessage.content,
      goals: [],
    })
    const applied = testRuntime.flowStore.applyRouting({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: created.turn.id,
      messageId: created.userMessage.id,
      messageContent: created.userMessage.content,
      result: routing,
    })
    testRuntime.runtime.activeTurns.create(created.turn.id)
    const toolCallId = createId("v2tcall")
    testRuntime.flowStore.createToolCall({
      id: toolCallId,
      projectId: "proj_one",
      flowId: flow.id,
      goalId: applied.goal.id,
      turnId: created.turn.id,
      toolName: "mcp_test__lookup",
      arguments: { query: "safe metadata" },
      requiresApproval: false,
    })
    const credentialRequestId = createId("v2creq")
    testRuntime.flowStore.createCredentialRequest({
      id: credentialRequestId,
      projectId: "proj_one",
      flowId: flow.id,
      goalId: applied.goal.id,
      turnId: created.turn.id,
      toolCallId,
      serverId: "test-mcp",
      serverLabel: "Test MCP",
      envKey: "TEST_MCP_TOKEN",
      source: "user_input",
    })
    const socket = new FakeSocket()
    testRuntime.runtime.subscriptions.subscribe(asWebSocket(socket), flow.id)
    const controller = testRuntime.runtime.activeTurns.get(created.turn.id)
    const waiting = testRuntime.runtime.activeTurns.waitForCredentialInput(
      created.turn.id,
      credentialRequestId,
      "user_input",
      controller?.signal,
    )
    const secret = "ULTRA_SECRET_V2_TOKEN_9f8a7b"
    const command: CredentialCommand = {
      id: createId("v2evt"),
      schemaVersion: 2,
      timestamp: nowIso(),
      projectId: "proj_one",
      flowId: flow.id,
      goalId: applied.goal.id,
      turnId: created.turn.id,
      actor: { type: "user" },
      type: "v2.credential.input.submit",
      payload: { credentialRequestId, turnId: created.turn.id, decision: "submitted", value: secret },
    }

    testRuntime.runtime.submitCredential(command)
    await expect(waiting).resolves.toMatchObject({ decision: "submitted", value: secret, source: "user_input" })

    const v2Tables = (testRuntime.handle.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'v2_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name)
    const persisted = JSON.stringify(v2Tables.flatMap((table) =>
      testRuntime.handle.sqlite.prepare(`SELECT * FROM "${table}"`).all(),
    ))
    expect(persisted).not.toContain(secret)
    expect(JSON.stringify(socket.sent)).not.toContain(secret)
    expect(socket.sent.at(-1)).toMatchObject({
      type: "v2.credential.input.resolved",
      payload: { request: { id: credentialRequestId, status: "submitted", envKey: "TEST_MCP_TOKEN" } },
    })

    testRuntime.flowStore.cancelTurn("proj_one", flow.id, created.turn.id, "Test cleanup")
    testRuntime.runtime.activeTurns.delete(created.turn.id)
  })
})
