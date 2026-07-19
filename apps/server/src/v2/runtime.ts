import type { WebSocket } from "ws"
import {
  v2RuntimeConfigSchema,
  v2ServerEventSchema,
  type V2ClientCommand,
  type V2FlowSnapshot,
  type V2RuntimeConfig,
  type V2ServerEvent,
  type V2Turn,
} from "@socrates/contracts"
import {
  assembleV2GoalWorkingContext,
  deriveV2ContextBudget,
  findModelOption,
  routeV2Goal,
  type SocratesAgent,
  type SocratesAgentEvent,
} from "@socrates/core"
import type { McpRuntime } from "@socrates/mcp"
import type { ModelProvider, ModelUsage } from "@socrates/providers"
import { createId, normalizeError, nowIso, SocratesError } from "@socrates/shared"
import { listWorkspaceEnvKeyCandidates, readWorkspaceEnvValue } from "@socrates/workspace"
import type { SocratesStore } from "../services/store"
import { createV2ContextCompressionRuntime } from "../services/v2/contextCompressionRuntime"
import { V2ContextMaintenanceService } from "../services/v2/contextMaintenance"
import type { V2ContinuedTerminalTask, V2FlowStore, V2ReadyTerminalTask } from "../services/v2/flowStore"
import { ActiveTurns } from "../ws/activeTurns"
import { makeV2Event } from "./eventSender"
import { V2FlowSubscriptions } from "./flowSubscriptions"
import { V2TerminalRuntime } from "./terminalRuntime"
import { createV2ToolExecutors } from "./toolExecutors"

type ScopedCommand<T extends V2ClientCommand["type"]> = Extract<V2ClientCommand, { type: T }>

export type V2ExecutionRuntimeDeps = {
  store: V2FlowStore
  sharedStore: SocratesStore
  agent: SocratesAgent
  subscriptions?: V2FlowSubscriptions
  activeTurns?: ActiveTurns
  mcpRuntime?: McpRuntime
  routerProvider?: ModelProvider
  supervisorScope?: string
}

export class V2ExecutionRuntime {
  readonly subscriptions: V2FlowSubscriptions
  readonly activeTurns: ActiveTurns
  readonly terminals: V2TerminalRuntime
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly contextMaintenance: V2ContextMaintenanceService
  private initialized = false

  constructor(private readonly deps: V2ExecutionRuntimeDeps) {
    this.subscriptions = deps.subscriptions ?? new V2FlowSubscriptions()
    this.activeTurns = deps.activeTurns ?? new ActiveTurns()
    this.terminals = new V2TerminalRuntime(deps.store, (type, payload, scope, source) => {
      this.emitUntyped(type, payload, scope, source ?? "terminal")
    }, { ...(deps.supervisorScope ? { supervisorScope: deps.supervisorScope } : {}) })
    this.contextMaintenance = new V2ContextMaintenanceService({
      store: deps.store,
      ...(deps.routerProvider ? { provider: deps.routerProvider } : {}),
    })
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    this.terminals.setTaskWakeHandler((task) => this.scheduleTerminalContinuation(task))
    await this.terminals.reconcilePersistedTerminals()
    for (const task of this.deps.store.listReadyTerminalTasks()) this.scheduleTerminalContinuation(task)
  }

  subscribe(socket: WebSocket, command: ScopedCommand<"v2.flow.subscribe">): void {
    const snapshot = this.deps.store.getSnapshot(command.projectId, command.flowId)
    this.subscriptions.subscribe(socket, command.flowId)
    this.subscriptions.send(socket, makeV2Event(
      "v2.connection.ready",
      { connectionId: createId("conn"), serverTime: nowIso() },
      { projectId: command.projectId, flowId: command.flowId },
    ))
    const afterSequence = command.payload.afterSequence ?? 0
    for (const persisted of this.deps.store.listRuntimeEvents(command.projectId, command.flowId, afterSequence, 2_000)) {
      const replay = v2ServerEventSchema.safeParse({
        id: persisted.id,
        schemaVersion: 2,
        timestamp: persisted.createdAt,
        projectId: persisted.projectId,
        flowId: persisted.flowId,
        ...(persisted.goalId ? { goalId: persisted.goalId } : {}),
        ...(persisted.turnId ? { turnId: persisted.turnId } : {}),
        actor: actorForSource(persisted.source),
        type: persisted.type,
        payload: persisted.payload,
      })
      if (replay.success) this.subscriptions.send(socket, replay.data)
    }
    // Snapshot is deliberately last: it is the authoritative hydration state
    // and carries the newest reconnect cursor even when an older client replays
    // duplicate, idempotent events.
    this.subscriptions.send(socket, makeV2Event(
      "v2.flow.snapshot",
      { snapshot: this.deps.store.getSnapshot(command.projectId, command.flowId) },
      { projectId: command.projectId, flowId: command.flowId },
    ))
    void snapshot
  }

  unsubscribe(socket: WebSocket, flowId: string): void {
    this.subscriptions.unsubscribe(socket, flowId)
  }

  async startTurn(socket: WebSocket, command: ScopedCommand<"v2.message.send">): Promise<V2Turn> {
    this.deps.store.getFlow(command.projectId, command.flowId)
    await this.deps.sharedStore.refreshAvailableModels()
    const runtimeConfig = v2RuntimeConfigSchema.parse(
      this.deps.sharedStore.resolveRuntimeConfig(command.payload.runtimeConfig) as V2RuntimeConfig,
    )
    const created = this.deps.store.createTurn({
      projectId: command.projectId,
      flowId: command.flowId,
      clientMessageId: command.payload.clientMessageId,
      content: command.payload.content,
      ...(command.payload.attachmentIds ? { attachmentIds: command.payload.attachmentIds } : {}),
      runtimeConfig,
    })
    this.subscriptions.subscribe(socket, command.flowId)
    this.activeTurns.create(created.turn.id)
    this.emit(
      "v2.turn.started",
      { turn: created.turn, userMessage: created.userMessage },
      { projectId: command.projectId, flowId: command.flowId, turnId: created.turn.id },
      "main_agent",
      socket,
    )
    const execution = this.executeTurn({
      socket,
      command,
      runtimeConfig,
      created,
    }).finally(() => {
      this.inFlight.delete(created.turn.id)
    })
    this.inFlight.set(created.turn.id, execution)
    void execution
    return created.turn
  }

  cancel(command: ScopedCommand<"v2.turn.cancel">): V2Turn {
    this.deps.store.getFlow(command.projectId, command.flowId)
    this.activeTurns.get(command.payload.turnId)?.abort()
    const turn = this.deps.store.cancelTurn(
      command.projectId,
      command.flowId,
      command.payload.turnId,
      command.payload.reason ?? "Cancelled by the user.",
    )
    this.deps.sharedStore.indexV2TurnRetrieval(command.projectId, command.payload.turnId)
    this.emit("v2.turn.updated", { turn }, { projectId: command.projectId, flowId: command.flowId, turnId: command.payload.turnId }, "main_agent")
    return turn
  }

  decideApproval(command: ScopedCommand<"v2.approval.decide">): void {
    const approval = this.deps.store.resolveApproval(
      command.projectId,
      command.flowId,
      command.payload.approvalId,
      command.payload.decision,
      command.payload.reason,
    )
    this.activeTurns.resolveApproval(command.payload.approvalId, {
      decision: command.payload.decision,
      ...(command.payload.reason ? { reason: command.payload.reason } : {}),
    })
    this.emit("v2.approval.updated", { approval }, { projectId: command.projectId, flowId: command.flowId }, "user")
  }

  submitCredential(command: ScopedCommand<"v2.credential.input.submit">): void {
    const request = this.deps.store.resolveCredentialRequest(
      command.projectId,
      command.flowId,
      command.payload.credentialRequestId,
      command.payload.decision,
    )
    // The submitted value crosses exactly one in-memory handoff. It is never
    // included in the persisted runtime event, a log line, or a V2 DB record.
    this.activeTurns.resolveCredentialInput(command.payload.turnId, command.payload.credentialRequestId, {
      decision: command.payload.decision,
      ...(command.payload.value !== undefined ? { value: command.payload.value } : {}),
      source: "user_input",
    })
    this.emit("v2.credential.input.resolved", { request }, { projectId: command.projectId, flowId: command.flowId, turnId: command.payload.turnId }, "user")
  }

  submitFeedback(command: ScopedCommand<"v2.feedback.submit">): void {
    const feedback = this.deps.store.submitFeedback({
      projectId: command.projectId,
      flowId: command.flowId,
      messageId: command.payload.messageId,
      ...(command.payload.turnId ? { turnId: command.payload.turnId } : {}),
      ...(command.payload.modelCallId ? { modelCallId: command.payload.modelCallId } : {}),
      rating: command.payload.rating,
      ...(command.payload.reasonCode ? { reasonCode: command.payload.reasonCode } : {}),
      ...(command.payload.note ? { note: command.payload.note } : {}),
    })
    this.emit("v2.feedback.updated", { feedback }, {
      projectId: command.projectId,
      flowId: command.flowId,
      ...(command.payload.turnId ? { turnId: command.payload.turnId } : {}),
    }, "user")
  }

  async respondToClarification(socket: WebSocket, command: ScopedCommand<"v2.routing.clarification.respond">): Promise<V2Turn> {
    const resolved = this.deps.store.resolveRoutingClarification({
      projectId: command.projectId,
      flowId: command.flowId,
      routingRunId: command.payload.routingRunId,
      answerMessageId: command.payload.answerMessageId,
      answer: command.payload.answer,
    })
    const runtimeConfig = this.deps.store.getRuntimeConfig(resolved.created.turn.id).runtimeConfig
    this.subscriptions.subscribe(socket, command.flowId)
    this.activeTurns.create(resolved.created.turn.id)
    this.emit("v2.message.completed", { message: resolved.answerMessage }, {
      projectId: command.projectId,
      flowId: command.flowId,
      turnId: resolved.created.turn.id,
    }, "user")
    this.emit("v2.routing.clarification.resolved", {
      routingRun: resolved.routingRun,
      answerMessage: resolved.answerMessage,
    }, { projectId: command.projectId, flowId: command.flowId, turnId: resolved.created.turn.id }, "goal_router")
    const syntheticCommand = {
      id: createId("v2evt"),
      schemaVersion: 2 as const,
      timestamp: nowIso(),
      projectId: command.projectId,
      flowId: command.flowId,
      turnId: resolved.created.turn.id,
      type: "v2.message.send" as const,
      payload: {
        clientMessageId: resolved.created.userMessage.id,
        content: resolved.created.userMessage.content,
        runtimeConfig,
      },
    } satisfies ScopedCommand<"v2.message.send">
    const execution = this.executeTurn({
      socket,
      command: syntheticCommand,
      runtimeConfig,
      created: resolved.created,
      clarificationAnswer: resolved.clarificationAnswer,
    }).finally(() => this.inFlight.delete(resolved.created.turn.id))
    this.inFlight.set(resolved.created.turn.id, execution)
    void execution
    return resolved.created.turn
  }

  updateFocus(command: ScopedCommand<"v2.focus.update">): void {
    const result = this.deps.store.updateFocus({
      projectId: command.projectId,
      flowId: command.flowId,
      goalId: command.payload.goalId,
      action: command.payload.action,
      ...(command.payload.note ? { note: command.payload.note } : {}),
    })
    for (const transition of result.transitions) {
      const goal = this.deps.store.getSnapshot(command.projectId, command.flowId).goals.find((candidate) => candidate.id === transition.goalId)
      if (goal) this.emit("v2.goal.transitioned", { goal, transition }, { projectId: command.projectId, flowId: command.flowId, goalId: goal.id }, "user")
    }
    this.emit("v2.flow.snapshot", { snapshot: this.deps.store.getSnapshot(command.projectId, command.flowId) }, { projectId: command.projectId, flowId: command.flowId }, "system")
  }

  async stopTerminal(command: ScopedCommand<"v2.terminal.stop">): Promise<void> {
    await this.terminals.stop(command, command.payload.terminalId)
  }

  async inputTerminal(command: ScopedCommand<"v2.terminal.input">): Promise<void> {
    await this.terminals.writeInput(command, command.payload.terminalId, {
      ...(command.payload.data !== undefined ? { data: command.payload.data } : {}),
      ...(command.payload.text !== undefined ? { text: command.payload.text } : {}),
      ...(command.payload.key !== undefined ? { key: command.payload.key } : {}),
      ...(command.payload.submit !== undefined ? { submit: command.payload.submit } : {}),
    })
  }

  async resizeTerminal(command: ScopedCommand<"v2.terminal.resize">): Promise<void> {
    await this.terminals.resize(command, command.payload.terminalId, command.payload.cols, command.payload.rows)
  }

  renameTerminal(command: ScopedCommand<"v2.terminal.rename">): void {
    this.terminals.rename(command, command.payload.terminalId, command.payload.name)
  }

  async shutdown(timeoutMs = 10_000): Promise<boolean> {
    this.terminals.beginShutdown()
    this.activeTurns.abortAll()
    const settled = await Promise.race([
      Promise.allSettled([...this.inFlight.values()]).then(() => true),
      new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), timeoutMs)
        timeout.unref?.()
      }),
    ])
    await this.terminals.dispose({ preserveRunning: true })
    return settled
  }

  emitCommandError(socket: WebSocket, command: Pick<V2ClientCommand, "projectId" | "flowId"> & { turnId?: string }, error: unknown): void {
    const normalized = normalizeError(error)
    const createdAt = nowIso()
    const event = makeV2Event("v2.error.created", {
      error: {
        id: createId("v2err"),
        flowId: command.flowId,
        projectId: command.projectId,
        ...(command.turnId ? { turnId: command.turnId } : {}),
        source: "command",
        code: normalized.code,
        message: normalized.message,
        recoverable: normalized.recoverable,
        ...(normalized.details === undefined ? {} : { details: normalized.details }),
        createdAt,
      },
    }, {
      projectId: command.projectId,
      flowId: command.flowId,
      ...(command.turnId ? { turnId: command.turnId } : {}),
    })
    this.subscriptions.send(socket, event)
  }

  private scheduleTerminalContinuation(task: V2ReadyTerminalTask): void {
    const continued = this.deps.store.beginTerminalTaskContinuation(task)
    if (!continued) return
    this.activeTurns.create(continued.turn.id)
    this.emit("v2.turn.updated", { turn: continued.suspendedTurn }, {
      projectId: continued.projectId,
      flowId: continued.flowId,
      goalId: continued.goalId,
      turnId: continued.suspendedTurn.id,
    }, "terminal")
    const command = {
      id: createId("v2evt"),
      schemaVersion: 2 as const,
      timestamp: nowIso(),
      projectId: continued.projectId,
      flowId: continued.flowId,
      goalId: continued.goalId,
      turnId: continued.turn.id,
      type: "v2.message.send" as const,
      payload: {
        clientMessageId: continued.userMessage.id,
        content: continued.userMessage.content,
        runtimeConfig: continued.runtimeConfig,
      },
    } satisfies ScopedCommand<"v2.message.send">
    const created: ReturnType<V2FlowStore["createTurn"]> = {
      flow: this.deps.store.getFlow(continued.projectId, continued.flowId),
      turn: continued.turn,
      userMessage: continued.userMessage,
      runtimeConfigId: continued.runtimeConfigId,
    }
    const execution = this.executeTurn({
      command,
      runtimeConfig: continued.runtimeConfig,
      created,
      continuation: continued,
    }).finally(() => this.inFlight.delete(continued.turn.id))
    this.inFlight.set(continued.turn.id, execution)
    void execution
  }

  private async executeTurn(input: {
    socket?: WebSocket
    command: ScopedCommand<"v2.message.send">
    runtimeConfig: V2RuntimeConfig
    created: ReturnType<V2FlowStore["createTurn"]>
    continuation?: V2ContinuedTerminalTask
    clarificationAnswer?: string
  }): Promise<void> {
    const { command, created, runtimeConfig, continuation, clarificationAnswer } = input
    const abortController = this.activeTurns.get(created.turn.id)
    if (!abortController) return
    const modelCallIds = new Set<string>()
    const completedModelCalls = new Set<string>()
    const responseMetadata = new Map<string, unknown>()
    const usageByCall = new Map<string, ModelUsage>()
    let answerText = ""
    let reasoningText = ""
    let goalId: string | undefined
    let sawToolActivity = false
    let suspended = false
    let frontierHandoverActive = false
    try {
      const workspacePath = this.deps.sharedStore.getPrimaryWorkspacePath(command.projectId)
      let activeGoalId: string
      if (continuation) {
        activeGoalId = continuation.goalId
        this.emit(
          "v2.turn.updated",
          { turn: continuation.turn },
          { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id },
          "main_agent",
        )
      } else {
        const goalRouterSetting = this.deps.sharedStore.getWorkerModelSetting("goal_router")
        const retrievedGoalIds = await this.deps.sharedStore.searchGoalCards(command.projectId, command.payload.content, 4).catch(() => [] as string[])
        const goalRouterModel = {
          providerId: goalRouterSetting.providerId,
          ...(goalRouterSetting.authMode ? { authMode: goalRouterSetting.authMode } : {}),
          modelId: goalRouterSetting.modelId,
          thinkingEnabled: goalRouterSetting.thinkingEnabled,
          ...(goalRouterSetting.thinkingEffort ? { thinkingEffort: goalRouterSetting.thinkingEffort } : {}),
          timeoutMs: 8_000,
        }
        const routing = await routeV2Goal({
          projectId: command.projectId,
          flowId: command.flowId,
          turnId: created.turn.id,
          workspacePath,
          userMessage: command.payload.content,
          goals: this.deps.store.getSnapshot(command.projectId, command.flowId).goals,
          capsules: this.deps.store.getSnapshot(command.projectId, command.flowId).latestCapsules,
          recentTurns: this.deps.store.listRecentRoutingTurns(command.flowId, 3),
          candidateGoalIds: retrievedGoalIds,
          ...(clarificationAnswer ? { clarificationAnswer } : {}),
          ...(this.deps.routerProvider ? { provider: this.deps.routerProvider, model: goalRouterModel } : {}),
        })
        if (routing.modelAttempt) {
          const routerCallId = this.deps.store.createModelCall({
            projectId: command.projectId,
            flowId: command.flowId,
            turnId: created.turn.id,
            role: "goal_router",
            providerId: routing.modelAttempt.providerId,
            modelId: routing.modelAttempt.modelId,
            request: { phase: "goal_routing", candidateCount: routing.candidates.candidates.length },
          })
          const routerError = routing.modelAttempt.status === "failed"
            ? this.deps.store.recordError({
                projectId: command.projectId,
                flowId: command.flowId,
                turnId: created.turn.id,
                source: "goal_router",
                code: `v2_goal_router_${routing.modelAttempt.errorCode ?? "failed"}`,
                message: routing.modelAttempt.errorCode === "timeout"
                  ? "The Flow goal router timed out."
                  : routing.modelAttempt.errorCode === "invalid_output"
                    ? "The Flow goal router returned invalid structured output after one repair attempt."
                    : "The Flow goal router provider failed.",
                details: { fallbackReason: routing.fallbackReason, errorMessage: routing.modelAttempt.errorMessage },
                recoverable: true,
              })
            : undefined
          this.deps.store.completeModelCall({
            modelCallId: routerCallId,
            response: {
              source: routing.source,
              fallbackReason: routing.fallbackReason,
              decision: routing.decision.action,
              startedAt: routing.modelAttempt.startedAt,
              completedAt: routing.modelAttempt.completedAt,
              durationMs: routing.modelAttempt.durationMs,
            },
            ...(routerError ? { errorId: routerError.id } : {}),
          })
          if (routing.modelAttempt.usage) this.recordUsage(routerCallId, routing.modelAttempt.usage)
        }
        if (routing.decision.action === "clarify" && !clarificationAnswer) {
          const clarification = this.deps.store.requestRoutingClarification({
            projectId: command.projectId,
            flowId: command.flowId,
            turnId: created.turn.id,
            messageId: created.userMessage.id,
            result: routing,
            ...(this.deps.routerProvider ? { providerId: goalRouterModel.providerId, modelId: goalRouterModel.modelId } : {}),
          })
          this.emit("v2.routing.clarification.requested", {
            routingRun: clarification.routingRun,
            message: clarification.message,
          }, { projectId: command.projectId, flowId: command.flowId, turnId: created.turn.id }, "goal_router")
          this.emit("v2.message.completed", { message: clarification.message }, { projectId: command.projectId, flowId: command.flowId, turnId: created.turn.id }, "goal_router")
          this.emit("v2.turn.updated", { turn: clarification.turn }, { projectId: command.projectId, flowId: command.flowId, turnId: created.turn.id }, "goal_router")
          return
        }
        const effectiveRouting = routing.decision.action === "clarify"
          ? await routeV2Goal({
              projectId: command.projectId,
              flowId: command.flowId,
              turnId: created.turn.id,
              workspacePath,
              userMessage: `${command.payload.content}\n\nClarification answer: ${clarificationAnswer ?? ""}`,
              goals: this.deps.store.getSnapshot(command.projectId, command.flowId).goals,
              capsules: this.deps.store.getSnapshot(command.projectId, command.flowId).latestCapsules,
              recentTurns: this.deps.store.listRecentRoutingTurns(command.flowId, 3),
              candidateGoalIds: retrievedGoalIds,
            })
          : routing
        const applied = this.deps.store.applyRouting({
          projectId: command.projectId,
          flowId: command.flowId,
          turnId: created.turn.id,
          messageId: created.userMessage.id,
          messageContent: command.payload.content,
          result: effectiveRouting,
          ...(this.deps.routerProvider ? { providerId: goalRouterModel.providerId, modelId: goalRouterModel.modelId } : {}),
        })
        activeGoalId = applied.goal.id
        this.deps.sharedStore.indexGoalRetrieval(command.projectId, activeGoalId)
        this.deps.store.assertV2FocusOwnership(command.projectId, command.flowId, activeGoalId)
        this.emit(
          "v2.goal.routed",
          { routingRun: applied.routingRun, goal: applied.goal, ...(applied.transition ? { transition: applied.transition } : {}) },
          { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id },
          "goal_router",
        )
        const routedTurn: V2Turn = { ...created.turn, goalId: activeGoalId, status: "running", updatedAt: nowIso() }
        this.emit("v2.turn.updated", { turn: routedTurn }, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id }, "main_agent")
      }
      goalId = activeGoalId

      const selectedModel =
        this.deps.sharedStore.findAvailableModelOption(runtimeConfig.providerId, runtimeConfig.modelId, runtimeConfig.authMode ?? "api_key") ??
        findModelOption(runtimeConfig.providerId, runtimeConfig.modelId, runtimeConfig.authMode ?? "api_key")
      const messages = await this.buildWorkingMessages({
        projectId: command.projectId,
        flowId: command.flowId,
        goalId: activeGoalId,
        query: command.payload.content,
        contextWindowTokens: runtimeConfig.contextWindowTokens ?? selectedModel?.contextWindowTokens ?? 128_000,
        includeImages: selectedModel?.capabilities?.vision === true,
        ...(continuation ? { lateDeveloperContext: continuation.wakeContext } : {}),
      })
      if (clarificationAnswer) {
        messages.push({ role: "user", content: `[Focus clarification answer: ${clarificationAnswer}]` })
      }
      messages.push({
        role: "developer",
        content: [
          "<v2_focus_runtime>",
          `Current Focus id: ${activeGoalId}. Current Task id: ${created.turn.id}.`,
          "Use focus_ledger to inspect the bounded project focus ledger when it helps, to keep the current focus summary useful after material changes, or to record a real blocker.",
          "Call focus_ledger operation=complete_current only when this durable work focus is genuinely finished by this response. Never complete General Conversation. No completion tool call means the focus remains open.",
          "The ledger cannot switch/archive focuses and cannot delete evidence. Those remain user/router lifecycle decisions.",
          "</v2_focus_runtime>",
        ].join("\n"),
      })
      const promptContext = this.deps.sharedStore.getAgentContext(command.projectId)
      const stableCachePreludeSnapshot = this.deps.sharedStore.loadStableCachePreludeSnapshot(command.projectId, workspacePath)
      const memoryRouterModelSettings = this.deps.sharedStore.getWorkerModelSetting("memory_router")
      const frontierModelSettings = this.deps.sharedStore.getWorkerModelSetting("frontier")
      const exposedMcpServers = new Set<string>()
      const toolExecutors = createV2ToolExecutors({
        flowStore: this.deps.store,
        sharedStore: this.deps.sharedStore,
        activeTurns: this.activeTurns,
        terminals: this.terminals,
        projectId: command.projectId,
        flowId: command.flowId,
        goalId: activeGoalId,
        turnId: created.turn.id,
        workspacePath,
        ...(this.deps.mcpRuntime ? { mcpRuntime: this.deps.mcpRuntime } : {}),
        exposeMcpServer: (serverId) => exposedMcpServers.add(serverId),
      })
      const streamMessageId = `${created.turn.id}_assistant`
      const fileFreshness = this.activeTurns.getFileFreshness(created.turn.id)
      const activeGoalSnapshot = this.deps.store.getSnapshot(command.projectId, command.flowId)
      const activeGoal = activeGoalSnapshot.goals.find((goal) => goal.id === activeGoalId)
      const activeCapsule = activeGoalSnapshot.latestCapsules.find((capsule) => capsule.goalId === activeGoalId)
      for await (const event of this.deps.agent.streamTurn({
        projectId: command.projectId,
        // V2 owns execution. The bridge mirrors only completed visible turns
        // into Classic; it never makes Classic persistence the V2 runtime.
        conversationId: command.flowId,
        sessionId: created.turn.id,
        turnId: created.turn.id,
        cacheKey: `project:${command.projectId}:flow:${command.flowId}:focus:${activeGoalId}`,
        providerId: runtimeConfig.providerId,
        modelId: runtimeConfig.modelId,
        runtimeConfig,
        memoryRouterModelSettings,
        frontierModelSettings,
        messages,
        promptContext,
        workspacePath,
        stableCachePreludeSnapshot,
        automaticMemorySearch: (memoryInput) => this.deps.sharedStore.searchMemory(command.projectId, memoryInput, true),
        ...(activeGoal ? {
          activeGoal: {
            goalId: activeGoal.id,
            title: activeGoal.title,
            state: activeGoal.status,
            note: activeCapsule?.summary ?? activeGoal.summary ?? "Work is active.",
          },
          applyGoalFinalization: async (finalization) => {
            this.deps.store.finalizeGoal(command.projectId, command.flowId, activeGoalId, created.turn.id, finalization)
            this.deps.sharedStore.indexGoalRetrieval(command.projectId, activeGoalId)
          },
        } : {}),
        recordMemoryRouterRun: async (run) => {
          const error = run.error
            ? this.deps.store.recordError({
                projectId: command.projectId,
                flowId: command.flowId,
                goalId: activeGoalId,
                turnId: created.turn.id,
                source: "memory_router",
                code: run.error.code,
                message: run.error.message,
                details: { phase: run.phase, routerDetails: run.error.details },
                recoverable: run.error.recoverable,
              })
            : undefined
          const attempts: Array<ModelUsage | undefined> = run.usages.length > 0 ? run.usages : [undefined]
          for (const [index, usage] of attempts.entries()) {
            const modelCallId = this.deps.store.createModelCall({
              projectId: command.projectId,
              flowId: command.flowId,
              goalId: activeGoalId,
              turnId: created.turn.id,
              role: "memory_router",
              providerId: run.providerId,
              modelId: run.modelId,
              request: { phase: run.phase, attempt: index + 1, attemptCount: attempts.length, startedAt: run.startedAt },
            })
            const isLastAttempt = index === attempts.length - 1
            this.deps.store.completeModelCall({
              modelCallId,
              response: { phase: run.phase, status: run.status, attempt: index + 1, startedAt: run.startedAt, completedAt: run.completedAt },
              ...(error && isLastAttempt ? { errorId: error.id } : {}),
            })
            if (usage) this.recordUsage(modelCallId, usage)
          }
        },
        contextCompression: createV2ContextCompressionRuntime({
          store: this.deps.store,
          sharedStore: this.deps.sharedStore,
          projectId: command.projectId,
          flowId: command.flowId,
          goalId: activeGoalId,
          turnId: created.turn.id,
          workspacePath,
          runtimeConfig,
        }),
        toolExecutors,
        dynamicTools: () => this.deps.mcpRuntime
          ? [...exposedMcpServers].flatMap((serverId) => this.deps.mcpRuntime!.getDynamicToolDefinitions(serverId, { workspacePath }))
          : [],
        maxParallelToolCalls: 5,
        maxToolCallsPerTurn: 80,
        createModelCall: (request) => {
          const id = this.deps.store.createModelCall({
            projectId: command.projectId,
            flowId: command.flowId,
            goalId: activeGoalId,
            turnId: created.turn.id,
            role: frontierHandoverActive ? "frontier_agent" : "main_agent",
            providerId: request.providerId,
            modelId: request.modelId,
            request: {
              estimatedTokens: request.estimatedTokens,
              tokenCount: request.tokenCount,
              tools: request.tools.map((tool) => tool.name),
              messageCount: request.messages.length,
              contextProjection: "v2_goal_working_context",
            },
          })
          modelCallIds.add(id)
          return id
        },
        requestApproval: async (request) => {
          const approval = this.deps.store.createApproval({
            id: request.approvalId,
            projectId: command.projectId,
            flowId: command.flowId,
            goalId: activeGoalId,
            turnId: created.turn.id,
            toolCallId: request.toolCallId,
            actionKind: request.actionKind,
            action: {
              toolName: request.toolName,
              title: request.title,
              description: request.description,
              actionPreview: request.actionPreview,
              risk: request.risk,
            },
          })
          this.emit("v2.approval.updated", { approval }, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id }, "system")
          return this.activeTurns.waitForApproval(created.turn.id, request.approvalId, abortController.signal)
        },
        requestCredentialInput: async (request) => {
          if (request.source === "workspace_env") {
            const candidate = listWorkspaceEnvKeyCandidates(workspacePath, request.envKey).find((item) => item.hasKey)
            if (candidate) {
              const value = readWorkspaceEnvValue(workspacePath, candidate.fileName, request.envKey)
              if (value) return { decision: "submitted" as const, value, source: "workspace_env" as const }
            }
          }
          const persisted = this.deps.store.createCredentialRequest({
            id: request.credentialRequestId,
            projectId: command.projectId,
            flowId: command.flowId,
            goalId: activeGoalId,
            turnId: created.turn.id,
            toolCallId: request.toolCallId,
            serverId: request.serverId,
            ...(request.serverLabel ? { serverLabel: request.serverLabel } : {}),
            envKey: request.envKey,
            source: "user_input",
          })
          this.emit("v2.credential.input.requested", { request: persisted }, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id }, "system")
          return this.activeTurns.waitForCredentialInput(created.turn.id, request.credentialRequestId, "user_input", abortController.signal)
        },
        abortSignal: abortController.signal,
        ...(fileFreshness ? { fileFreshness } : {}),
      })) {
        if (abortController.signal.aborted) break
        if (event.type === "model.answer.delta") {
          answerText += event.text
          this.emit("v2.message.delta", { messageId: streamMessageId, channel: "answer", text: event.text, ...(event.modelCallId ? { modelCallId: event.modelCallId } : {}) }, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id }, frontierHandoverActive ? "frontier_agent" : "main_agent")
        } else if (event.type === "model.reasoning.delta") {
          reasoningText += event.text
          this.emit("v2.message.delta", { messageId: streamMessageId, channel: "reasoning", text: event.text, ...(event.modelCallId ? { modelCallId: event.modelCallId } : {}) }, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id }, frontierHandoverActive ? "frontier_agent" : "main_agent")
        } else if (event.type === "model.reasoning.completed" && !reasoningText.endsWith(event.text)) {
          reasoningText += event.text
        } else if (event.type === "model.response.metadata" && event.modelCallId) {
          responseMetadata.set(event.modelCallId, event.response)
        } else if (event.type === "model.usage" && event.modelCallId) {
          usageByCall.set(event.modelCallId, event.usage)
          this.recordUsage(event.modelCallId, event.usage)
        } else if (event.type === "model.completed" && event.modelCallId) {
          if (event.usage) {
            usageByCall.set(event.modelCallId, event.usage)
            this.recordUsage(event.modelCallId, event.usage)
          }
          this.deps.store.completeModelCall({
            modelCallId: event.modelCallId,
            response: { finishReason: event.finishReason ?? "completed" },
            ...(responseMetadata.has(event.modelCallId) ? { providerResponse: responseMetadata.get(event.modelCallId) } : {}),
          })
          completedModelCalls.add(event.modelCallId)
        } else if (event.type === "agent.handover") {
          frontierHandoverActive = true
          this.emit("v2.agent.handover", {
            toolCallId: event.toolCallId,
            stepIndex: event.stepIndex,
            fromProviderId: event.fromProviderId,
            fromModelId: event.fromModelId,
            toProviderId: event.toProviderId,
            toModelId: event.toModelId,
            ...(event.focus ? { focus: event.focus } : {}),
          }, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id }, "frontier_agent")
        } else if (event.type === "context.compaction.started") {
          this.emit("v2.context.compaction.started", {
            snapshotId: event.snapshotId,
            reason: event.reason,
            contextUsedTokensEstimate: event.contextUsedTokensEstimate,
            targetTokens: event.targetTokens,
          }, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id }, "context_compactor")
        } else if (event.type === "context.compaction.completed") {
          this.emit("v2.context.compaction.completed", {
            snapshotId: event.snapshotId,
            inputTokensEstimate: event.inputTokensEstimate,
            outputTokensEstimate: event.outputTokensEstimate,
            contextUsedTokensEstimate: event.contextUsedTokensEstimate,
            sizeClass: event.sizeClass,
          }, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id }, "context_compactor")
        } else if (event.type === "context.compaction.failed") {
          this.emit("v2.context.compaction.failed", {
            ...(event.snapshotId ? { snapshotId: event.snapshotId } : {}),
            error: {
              code: event.error.code,
              message: event.error.message,
              ...(event.error.details === undefined ? {} : { details: event.error.details }),
              recoverable: event.error.recoverable,
            },
          }, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id }, "context_compactor")
        } else {
          this.handleToolEvent(event, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id })
          if (event.type.startsWith("tool.") || event.type.startsWith("approval.")) sawToolActivity = true
          if (event.type === "agent.suspended") {
            suspended = true
            break
          }
        }
      }
      if (abortController.signal.aborted) return
      if (suspended) {
        for (const modelCallId of modelCallIds) {
          if (completedModelCalls.has(modelCallId)) continue
          this.deps.store.completeModelCall({
            modelCallId,
            response: { finish: "waiting_for_terminal" },
            ...(responseMetadata.has(modelCallId) ? { providerResponse: responseMetadata.get(modelCallId) } : {}),
          })
          completedModelCalls.add(modelCallId)
        }
        const waitingTurn = this.deps.store.getTurn(command.projectId, command.flowId, created.turn.id)
        this.emit("v2.turn.updated", { turn: waitingTurn }, {
          projectId: command.projectId,
          flowId: command.flowId,
          goalId: activeGoalId,
          turnId: created.turn.id,
        }, "main_agent")
        return
      }
      if (!answerText.trim() && !sawToolActivity) {
        throw new SocratesError("model_empty_response", "Model provider completed without returning Socrates text.", { recoverable: true })
      }
      const assistantMessage = this.deps.store.completeTurn({
        projectId: command.projectId,
        flowId: command.flowId,
        turnId: created.turn.id,
        content: answerText,
        ...(reasoningText ? { reasoning: reasoningText } : {}),
      })
      this.deps.sharedStore.indexV2TurnRetrieval(command.projectId, created.turn.id)
      const refreshedCapsule = this.deps.store.getSnapshot(command.projectId, command.flowId).latestCapsules
        .find((capsule) => capsule.goalId === activeGoalId)
      if (refreshedCapsule) {
        this.emit("v2.goal.capsule.updated", { capsule: refreshedCapsule }, {
          projectId: command.projectId,
          flowId: command.flowId,
          goalId: activeGoalId,
          turnId: created.turn.id,
        }, "main_agent")
      }
      const contextWorker = this.deps.sharedStore.getWorkerModelSetting("socrates_context_compactor")
      const maintenance = await this.contextMaintenance.runAfterTurn({
        projectId: command.projectId,
        flowId: command.flowId,
        goalId: activeGoalId,
        turnId: created.turn.id,
        completedTurnOrdinal: created.turn.ordinal,
        query: command.payload.content,
        runtimeConfig,
        workerRuntime: {
          providerId: contextWorker.providerId,
          ...(contextWorker.authMode ? { authMode: contextWorker.authMode } : {}),
          modelId: contextWorker.modelId,
          thinkingEnabled: contextWorker.thinkingEnabled,
          ...(contextWorker.thinkingEffort ? { thinkingEffort: contextWorker.thinkingEffort } : {}),
        },
      })
      for (const event of maintenance.events) {
        this.emit(event.type, event.payload, {
          projectId: command.projectId,
          flowId: command.flowId,
          goalId: activeGoalId,
          turnId: created.turn.id,
        }, event.source)
      }
      for (const modelCallId of modelCallIds) {
        if (completedModelCalls.has(modelCallId)) continue
        this.deps.store.completeModelCall({
          modelCallId,
          response: { messageId: assistantMessage.id, finish: "completed" },
          ...(responseMetadata.has(modelCallId) ? { providerResponse: responseMetadata.get(modelCallId) } : {}),
        })
      }
      this.emit("v2.message.completed", { message: assistantMessage }, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id }, "main_agent")
      this.emit("v2.flow.snapshot", { snapshot: this.deps.store.getSnapshot(command.projectId, command.flowId) }, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id }, "system")
      const completedAt = assistantMessage.completedAt ?? nowIso()
      this.emit("v2.turn.updated", {
        turn: {
          ...created.turn,
          goalId: activeGoalId,
          assistantMessageId: assistantMessage.id,
          status: "completed",
          updatedAt: completedAt,
          completedAt,
        },
      }, { projectId: command.projectId, flowId: command.flowId, goalId: activeGoalId, turnId: created.turn.id }, "main_agent")
    } catch (error) {
      if (abortController.signal.aborted) return
      const persisted = this.deps.store.failTurn({
        projectId: command.projectId,
        flowId: command.flowId,
        turnId: created.turn.id,
        error,
        source: "main_agent",
      })
      this.deps.sharedStore.indexV2TurnRetrieval(command.projectId, created.turn.id)
      for (const modelCallId of modelCallIds) {
        if (completedModelCalls.has(modelCallId)) continue
        this.deps.store.completeModelCall({ modelCallId, errorId: persisted.id })
      }
      this.emit("v2.error.created", { error: persisted }, { projectId: command.projectId, flowId: command.flowId, ...(goalId ? { goalId } : {}), turnId: created.turn.id }, "main_agent")
      const failedAt = nowIso()
      this.emit("v2.turn.updated", {
        turn: { ...created.turn, ...(goalId ? { goalId } : {}), status: "failed", errorId: persisted.id, updatedAt: failedAt, failedAt },
      }, { projectId: command.projectId, flowId: command.flowId, ...(goalId ? { goalId } : {}), turnId: created.turn.id }, "main_agent")
    } finally {
      this.terminals.endTurn(created.turn.id)
      this.activeTurns.delete(created.turn.id)
    }
  }

  private async buildWorkingMessages(input: {
    projectId: string
    flowId: string
    goalId: string
    query: string
    contextWindowTokens: number
    includeImages: boolean
    lateDeveloperContext?: string
  }) {
    const budget = deriveV2ContextBudget({ contextWindowTokens: Math.max(2_048, input.contextWindowTokens) })
    const history = this.deps.store.getModelMessages(input.flowId, input.goalId, input.includeImages)
    const retained = retainNewestMessages(history, budget.recentGoalTailTokens)
    const snapshot = this.deps.store.getSnapshot(input.projectId, input.flowId)
    const capsule = snapshot.latestCapsules.find((item) => item.goalId === input.goalId)
    const fixedContextTokens = estimateRuntimeContextTokens([
      snapshot.foregroundGoal?.title ?? "Current Flow goal",
      capsule?.summary ?? "",
      input.lateDeveloperContext ?? "",
    ])
    const retainedHistoryTokens = retained.reduce(
      (sum, message) => sum + Math.max(1, Math.ceil(safeStringify(message.content).length / 4)),
      0,
    )
    const evidenceTokenLimit = Math.max(
      0,
      budget.postPruneTargetTokens - retainedHistoryTokens - fixedContextTokens,
    )
    const contextItems = this.deps.store.getActiveContextItems(input.flowId, input.goalId)
    const assembled = await assembleV2GoalWorkingContext({
      foregroundGoalId: input.goalId,
      query: input.query,
      messages: [],
      contextItems,
      budget,
      evidenceTokenLimit,
      exactRetriever: (refs) => this.deps.store.retrieveExactEvidence(input.flowId, refs.map((ref) => ref.evidenceId)).map((record) => ({
        evidenceRef: record.ref,
        exactContent: record.exactContent,
      })),
    })
    const sections = [
      `<active_goal id="${input.goalId}">${snapshot.foregroundGoal?.title ?? "Current Flow goal"}</active_goal>`,
      capsule ? `<goal_capsule version="${capsule.version}">${capsule.summary}</goal_capsule>` : "",
      ...assembled.distilledItems.map((item) => `<distilled_evidence ref="${item.evidenceRef.sourceLocator}">${item.text}</distilled_evidence>`),
      ...assembled.exactEvidence.map((item) => `<exact_evidence ref="${item.evidenceRef.sourceLocator}">${item.exactContent}</exact_evidence>`),
      input.lateDeveloperContext ? `<terminal_wake_context>${input.lateDeveloperContext}</terminal_wake_context>` : "",
    ].filter(Boolean)
    if (sections.length <= 1) return retained
    const developer = { role: "developer" as const, content: `<socrates_v2_flow_context>\n${sections.join("\n\n")}\n</socrates_v2_flow_context>` }
    const lastUserIndex = retained.map((message) => message.role).lastIndexOf("user")
    if (lastUserIndex < 0) return [...retained, developer]
    return [...retained.slice(0, lastUserIndex), developer, ...retained.slice(lastUserIndex)]
  }

  private handleToolEvent(event: SocratesAgentEvent, scope: { projectId: string; flowId: string; goalId: string; turnId: string }): void {
    if (event.type === "tool.call.started") {
      const toolCall = this.deps.store.createToolCall({
        id: event.toolCallId,
        ...scope,
        ...(event.modelCallId ? { modelCallId: event.modelCallId } : {}),
        ...(event.providerToolCallId ? { providerToolCallId: event.providerToolCallId } : {}),
        toolName: event.toolName,
        arguments: event.input ?? {},
        requiresApproval: event.requiresApproval,
      })
      this.emit("v2.tool.call.updated", { toolCall }, scope, "tool")
      return
    }
    if (event.type === "tool.call.completed") {
      const toolCall = this.deps.store.completeToolCall(event.toolCallId, event.output)
      this.deps.store.recordEvidence({
        ...scope,
        sourceKind: event.toolName === "bash" ? "terminal_output" : "tool_output",
        sourceId: event.toolCallId,
        title: `${event.toolName}: ${event.summary}`.slice(0, 1_000),
        content: safeStringify(event.output),
        rank: 30,
      })
      this.emit("v2.tool.call.updated", { toolCall }, scope, "tool")
      return
    }
    if (event.type === "tool.call.failed") {
      const error = this.deps.store.recordError({
        ...scope,
        source: "tool",
        code: event.error.code,
        message: event.error.message,
        details: event.error.details,
        recoverable: event.error.recoverable,
      })
      let toolCall
      try {
        toolCall = this.deps.store.failToolCall(event.toolCallId, error.id)
      } catch (lookupError) {
        if (!(lookupError instanceof SocratesError) || lookupError.code !== "v2_tool_call_not_found") throw lookupError
        this.deps.store.createToolCall({
          id: event.toolCallId,
          ...scope,
          ...(event.modelCallId ? { modelCallId: event.modelCallId } : {}),
          ...(event.providerToolCallId ? { providerToolCallId: event.providerToolCallId } : {}),
          toolName: event.toolName,
          arguments: {},
          requiresApproval: false,
        })
        toolCall = this.deps.store.failToolCall(event.toolCallId, error.id)
      }
      this.emit("v2.tool.call.updated", { toolCall }, scope, "tool")
      this.emit("v2.error.created", { error }, scope, "tool")
    }
  }

  private recordUsage(modelCallId: string, usage: ModelUsage): void {
    this.deps.store.recordUsage({
      modelCallId,
      ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
      ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
      ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
      ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
      ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
      ...(usage.raw === undefined ? {} : { raw: usage.raw }),
    })
  }

  private emit<T extends V2ServerEvent["type"]>(
    type: T,
    payload: Extract<V2ServerEvent, { type: T }>["payload"],
    scope: { projectId: string; flowId: string; goalId?: string; turnId?: string },
    source = "server",
    fallbackSocket?: WebSocket,
  ): void {
    const persisted = this.deps.store.appendRuntimeEvent({
      ...scope,
      type,
      source,
      payload,
    })
    const event = v2ServerEventSchema.parse({
      id: persisted.id,
      schemaVersion: 2,
      timestamp: persisted.createdAt,
      ...scope,
      actor: actorForSource(source),
      type,
      payload,
    })
    this.subscriptions.emit(event, fallbackSocket)
  }

  private emitUntyped(
    type: V2ServerEvent["type"],
    payload: V2ServerEvent["payload"],
    scope: { projectId: string; flowId: string; goalId?: string; turnId?: string },
    source: string,
  ): void {
    const persisted = this.deps.store.appendRuntimeEvent({ ...scope, type, source, payload })
    const event = v2ServerEventSchema.parse({
      id: persisted.id,
      schemaVersion: 2,
      timestamp: persisted.createdAt,
      ...scope,
      actor: actorForSource(source),
      type,
      payload,
    })
    this.subscriptions.emit(event)
  }
}

const actorForSource = (source: string): { type: "user" | "main_agent" | "worker" | "tool" | "system"; label?: string } => {
  if (source === "user") return { type: "user" }
  if (source === "main_agent" || source === "frontier_agent") return { type: "main_agent", ...(source === "frontier_agent" ? { label: "Frontier" } : {}) }
  if (source === "tool" || source === "terminal") return { type: "tool", label: source }
  if (source === "goal_router") return { type: "worker", label: "Goal Router" }
  if (source === "memory_router") return { type: "worker", label: "Memory Router" }
  if (source === "context_compactor" || source === "context_distiller") return { type: "worker", label: source === "context_compactor" ? "Context Compactor" : "Context Distiller" }
  return { type: "system" }
}

const retainNewestMessages = <T extends { content: unknown }>(messages: T[], tokenLimit: number): T[] => {
  const retained: T[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    const tokens = Math.max(1, Math.ceil(safeStringify(message.content).length / 4))
    if (retained.length > 0 && used + tokens > tokenLimit) continue
    retained.push(message)
    used += tokens
    if (used >= tokenLimit) break
  }
  return retained.reverse()
}

const estimateRuntimeContextTokens = (parts: readonly string[]): number =>
  parts.reduce((sum, part) => sum + (part ? Math.max(1, Math.ceil(part.length / 4)) : 0), 0)

const safeStringify = (value: unknown): string => {
  try {
    return typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}
