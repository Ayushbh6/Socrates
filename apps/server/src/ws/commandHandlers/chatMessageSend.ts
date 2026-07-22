import type { WebSocket } from "ws"
import {
  DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS,
  findModelOption,
  type ContextCompactionLifecycleEvent,
  type ContextCompressionRuntime,
  type SocratesAgent,
  type SocratesAgentEvent,
  type ToolExecutors,
} from "@socrates/core"
import type { ClientCommand, ProjectResource, RuntimeConfig, TraceRetrieveMainToolInput } from "@socrates/contracts"
import type { McpRuntime } from "@socrates/mcp"
import type { ModelProvider, ModelUsage } from "@socrates/providers"
import { normalizeError, nowIso, SocratesError } from "@socrates/shared"
import {
  applyPatchWorkspace,
  editWorkspace,
  FileFreshnessTracker,
  isWorkspaceMutationLocked,
  isShellSessionResetError,
  listWorkspaceEnvKeyCandidates,
  readWorkspacePath,
  readWorkspaceEnvValue,
  searchWorkspace,
  shouldSerializeBashInput,
  withWorkspaceMutationLock,
} from "@socrates/workspace"
import { apiError } from "../../http"
import { generateConversationTitle } from "../../services/conversationTitleGenerator"
import type { SocratesStore } from "../../services/store"
import type { ActiveTurns } from "../activeTurns"
import type { ConversationTerminalManager } from "../conversationTerminals"
import type { ConversationSubscriptions } from "../conversationSubscriptions"
import { appendAndEmit, makeEvent, type EventSink } from "../eventSender"
import { currentRuntimeTime } from "../../services/store/runtimeContext"
import { fetchUrlForTool } from "../urlFetch"
import type { V2FlowStore } from "../../services/v2/flowStore"

const requireCommandScope = (command: ClientCommand): { projectId: string; conversationId: string } => {
  if (!command.projectId || !command.conversationId) {
    throw new SocratesError("missing_command_scope", "projectId and conversationId are required for this command")
  }
  return { projectId: command.projectId, conversationId: command.conversationId }
}

const contextBudgetTokens = DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS.hardLimitTokens
const docsMutationOperations = new Set(["edit", "patch_section"])

const withLateDeveloperContext = (
  history: ReturnType<SocratesStore["getConversationModelMessages"]>,
  terminalContext: string | undefined,
  wakeContext?: string,
): ReturnType<SocratesStore["getConversationModelMessages"]> => {
  const sections = terminalContext?.trim()
    ? [`<terminal_context>\n${terminalContext.trim()}\n</terminal_context>`]
    : []
  if (wakeContext?.trim()) {
    sections.push(`<terminal_wake_context>\n${wakeContext.trim()}\n</terminal_wake_context>`)
  }
  if (sections.length === 0) {
    return history
  }

  const message = {
    role: "developer" as const,
    content: `<socrates_runtime_context>\n${sections.join("\n\n")}\n</socrates_runtime_context>`,
  }
  const latestUserIndexFromEnd = [...history].reverse().findIndex((item) => item.role === "user")
  if (latestUserIndexFromEnd === -1) {
    return [...history, message]
  }

  const insertIndex = history.length - latestUserIndexFromEnd - 1
  return [...history.slice(0, insertIndex), message, ...history.slice(insertIndex)]
}

type TerminalTaskContinuation = {
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  runtimeConfigId: string
  runtimeConfig: RuntimeConfig
  wakeContext: string
}

export const handleChatMessageSend = async (
  socket: WebSocket | undefined,
  store: SocratesStore,
  agent: SocratesAgent,
  activeTurns: ActiveTurns,
  terminals: ConversationTerminalManager,
  subscriptions: ConversationSubscriptions,
  command: Extract<ClientCommand, { type: "chat.message.send" }> | undefined,
  mcpRuntime?: McpRuntime,
  titleProvider?: ModelProvider,
  continuation?: TerminalTaskContinuation,
  flowStore?: V2FlowStore,
): Promise<void> => {
  if (!command && !continuation) {
    throw new SocratesError("missing_chat_command", "A chat message or continuation is required.")
  }
  const { projectId, conversationId } = continuation ?? requireCommandScope(command as Extract<ClientCommand, { type: "chat.message.send" }>)
  await store.refreshAvailableModels()
  const runtimeConfig = continuation?.runtimeConfig ?? store.resolveRuntimeConfig((command as Extract<ClientCommand, { type: "chat.message.send" }>).payload.runtimeConfig)
  const payload = command ? { ...command.payload, runtimeConfig } : undefined
  if (socket) {
    subscriptions.subscribe(socket, conversationId)
  }
  const emitEvent: EventSink = (event) => subscriptions.emit(event, socket)
  const created = continuation
    ? {
        sessionId: continuation.sessionId,
        turnId: continuation.turnId,
        runtimeConfigId: continuation.runtimeConfigId,
        userMessage: undefined,
        shouldGenerateTitle: false,
        fallbackTitle: "",
      }
    : store.createTurnFromUserMessage(projectId, conversationId, payload as NonNullable<typeof payload>)
  if (!continuation) {
    store.startAgentTask({ projectId, conversationId, sessionId: created.sessionId, turnId: created.turnId, runtimeConfig })
  }
  const abortController = activeTurns.create(created.turnId)

  if (!continuation && created.userMessage) {
    emitEvent(
      makeEvent(
        "turn.started",
        {
          turnId: created.turnId,
          userMessage: created.userMessage,
        },
        {
          projectId,
          conversationId,
          sessionId: created.sessionId,
          turnId: created.turnId,
          actor: { type: "main_agent" },
        },
      ),
    )
  }

  if (created.shouldGenerateTitle) {
    const placeholderConversation = store.getConversation(projectId, conversationId).conversation
    appendAndEmit(
      emitEvent,
      store,
      makeEvent(
        "conversation.updated",
        { conversation: placeholderConversation },
        {
          projectId,
          conversationId,
          sessionId: created.sessionId,
          turnId: created.turnId,
          actor: { type: "system" },
        },
      ),
      "server",
    )
  }

  if (created.shouldGenerateTitle && titleProvider && created.userMessage) {
    const titleUsageSourceId = `title_${created.turnId}`
    const titleStartedAt = nowIso()
    void generateConversationTitle({
      provider: titleProvider,
      projectId,
      conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      workspacePath: store.getPrimaryWorkspacePath(projectId),
      message: created.userMessage,
      fallbackTitle: created.fallbackTitle,
      modelSettings: store.getWorkerModelSetting("title_generator"),
      abortSignal: abortController.signal,
    })
      .then((result) => {
        if (result?.usage) {
          store.recordConversationTitleUsage({
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            sourceId: titleUsageSourceId,
            providerId: result.providerId,
            modelId: result.modelId,
            status: "completed",
            startedAt: titleStartedAt,
            completedAt: nowIso(),
            usage: toStoredUsage(result.usage),
          })
        }
        const title = result?.title.trim()
        if (!title || title === created.fallbackTitle) {
          return
        }
        const conversation = store.autoTitleConversation(projectId, conversationId, title, created.fallbackTitle)
        if (!conversation) {
          return
        }
        appendAndEmit(
          emitEvent,
          store,
          makeEvent(
            "conversation.updated",
            { conversation },
            {
              projectId,
              conversationId,
              sessionId: created.sessionId,
              turnId: created.turnId,
              actor: { type: "system" },
            },
          ),
          "server",
        )
      })
      .catch(() => undefined)
  }

  const selectedModel =
    store.findAvailableModelOption(runtimeConfig.providerId, runtimeConfig.modelId, runtimeConfig.authMode ?? "api_key") ??
    findModelOption(runtimeConfig.providerId, runtimeConfig.modelId, runtimeConfig.authMode ?? "api_key")
  const includeImageParts = selectedModel?.capabilities?.vision === true
  const history = store.getConversationModelMessages(projectId, conversationId, { includeImageParts })
  const workspacePath = store.getPrimaryWorkspacePath(projectId)
  const terminalContext = store.terminalContextBrief(conversationId)
  const modelHistory = withLateDeveloperContext(history, terminalContext, continuation?.wakeContext)
  const stableCachePreludeSnapshot = store.loadStableCachePreludeSnapshot(projectId, workspacePath)
  const promptContext = {
    ...store.getAgentContext(projectId),
  }
  const configuredFrontier = store.getWorkerModelSetting("frontier")
  const frontierModelSettings = store.resolveModelSettings(configuredFrontier, "frontier").effective
  const modelCallIds: string[] = []
  const latestUsageByModelCallId = new Map<string, ModelUsage>()
  const responseMetadataByModelCallId = new Map<string, unknown>()
  let latestModelCallId: string | undefined

  let answerText = ""
  let reasoningText = ""
  let latestUsage: ModelUsage | undefined
  let lastAnswerModelCallId: string | undefined
  let sawToolActivity = false
  let suspended = false
  let suspendedWait: Extract<SocratesAgentEvent, { type: "agent.suspended" }>["wait"] | undefined
  const exposedMcpServers = new Set<string>()
  const goalQuery = created.userMessage?.content.trim() ?? ""
  const retrievedGoalIds = flowStore && goalQuery
    ? await store.searchGoalCards(projectId, goalQuery, 4).catch(() => [] as string[])
    : []
  const goalRoutingContext = flowStore?.prepareClassicGoalRouting(projectId, conversationId, retrievedGoalIds)
  const classicFlowStore = flowStore && goalRoutingContext ? flowStore : undefined

  try {
    for await (const agentEvent of agent.streamTurn({
      projectId,
      conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      providerId: runtimeConfig.providerId,
      modelId: runtimeConfig.modelId,
      runtimeConfig,
      memoryRouterModelSettings: store.getWorkerModelSetting("memory_router"),
      ...(frontierModelSettings ? { frontierModelSettings } : {}),
      cacheKey: providerCacheKey(projectId, conversationId),
      messages: modelHistory,
      promptContext,
      workspacePath,
      stableCachePreludeSnapshot,
      automaticMemorySearch: (input) => store.searchMemory(projectId, input, true),
      ...(goalRoutingContext && classicFlowStore ? {
        goalCandidates: goalRoutingContext.candidates,
        ...(goalRoutingContext.currentGoalCandidate ? { currentGoalCandidate: goalRoutingContext.currentGoalCandidate } : {}),
        applyGoalRoute: async (route) => {
          if (continuation) {
            const activeGoal = classicFlowStore.getClassicGoalForTurn(created.turnId)
            if (!activeGoal) throw new SocratesError("classic_goal_link_missing", "The continued task no longer has a goal link.", { recoverable: true })
            return activeGoal
          }
          if (!created.userMessage) throw new SocratesError("classic_goal_message_missing", "The Classic turn has no user message to route.")
          const activeGoal = classicFlowStore.applyClassicGoalRoute({
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            userMessageId: created.userMessage.id,
            userMessage: created.userMessage.content,
            context: goalRoutingContext,
            route,
          })
          store.indexGoalRetrieval(projectId, activeGoal.goalId)
          return activeGoal
        },
        applyGoalFinalization: async (finalization) => {
          classicFlowStore.finalizeClassicGoal(created.turnId, finalization)
          const activeGoal = classicFlowStore.getClassicGoalForTurn(created.turnId)
          if (activeGoal) store.indexGoalRetrieval(projectId, activeGoal.goalId)
        },
      } : {}),
      toolExecutors: createToolExecutors(store, projectId, created.turnId, activeTurns, terminals, mcpRuntime, {
        exposeMcpServer: (serverId) => exposedMcpServers.add(serverId),
      }),
      dynamicTools: () =>
        mcpRuntime ? [...exposedMcpServers].flatMap((serverId) => mcpRuntime.getDynamicToolDefinitions(serverId, { workspacePath })) : [],
      contextCompression: createContextCompressionRuntime(store, projectId, conversationId, created.sessionId, created.turnId),
      maxParallelToolCalls: 5,
      maxToolCallsPerTurn: 80,
      createModelCall: (modelRequest) => {
        const modelCallId = store.createModelCall({
          conversationId,
          sessionId: created.sessionId,
          turnId: created.turnId,
          runtimeConfigId: created.runtimeConfigId,
          providerId: modelRequest.providerId,
          modelId: modelRequest.modelId,
          request: {
            providerId: modelRequest.providerId,
            modelId: modelRequest.modelId,
            estimatedTokens: modelRequest.estimatedTokens,
            contextBudgetTokens,
            tokenCount: modelRequest.tokenCount,
            messages: modelRequest.messages,
            promptContext: modelRequest.promptContext,
            runtimeConfig: modelRequest.runtimeConfig,
            tools: modelRequest.tools.map((tool) => tool.name),
            stablePrelude: {
              source: "backend_snapshot",
              cacheHit: stableCachePreludeSnapshot.cacheHit === true,
            },
          },
        })
        modelCallIds.push(modelCallId)
        latestModelCallId = modelCallId
        const model =
          store.findAvailableModelOption(modelRequest.providerId, modelRequest.modelId, modelRequest.runtimeConfig.authMode ?? "api_key") ??
          findModelOption(modelRequest.providerId, modelRequest.modelId, modelRequest.runtimeConfig.authMode ?? "api_key")
        if (model?.contextWindowTokens) {
          sendContextUsageSnapshot(emitEvent, store, {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            modelCallId,
            providerId: modelRequest.providerId,
            modelId: modelRequest.modelId,
            contextWindowTokens: Math.min(model.contextWindowTokens, contextBudgetTokens),
            contextUsedTokens: modelRequest.estimatedTokens,
            metadata: {
              source: "model_context_estimate",
              tokenCount: modelRequest.tokenCount,
            },
          })
        }
        return modelCallId
      },
      requestApproval: async (request) => {
        const approvalId = store.createApproval({
          approvalId: request.approvalId,
          conversationId,
          sessionId: created.sessionId,
          turnId: created.turnId,
          toolCallId: request.toolCallId,
          actionKind: request.actionKind,
          action: request,
        })
        store.attachToolApproval(request.toolCallId, approvalId)
        const event = makeEvent(
          "approval.requested",
          {
            approvalId,
            toolCallId: request.toolCallId,
            providerToolCallId: request.providerToolCallId,
            actionKind: request.actionKind,
            title: request.title,
            description: request.description,
            actionPreview: request.actionPreview,
            risk: request.risk,
          },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "system" },
          },
        )
        appendAndEmit(emitEvent, store, event, "server")
        return activeTurns.waitForApproval(created.turnId, approvalId, abortController.signal)
      },
      requestCredentialInput: async (request) => {
        if (request.source === "workspace_env") {
          const candidate = listWorkspaceEnvKeyCandidates(workspacePath, request.envKey).find((item) => item.hasKey)
          if (candidate) {
            const value = readWorkspaceEnvValue(workspacePath, candidate.fileName, request.envKey)
            if (value) {
              return { decision: "submitted" as const, value, source: "workspace_env" as const }
            }
          }
        }

        const effectiveSource = "user_input" as const
        const event = makeEvent(
          "credential.input.requested",
          {
            credentialRequestId: request.credentialRequestId,
            toolCallId: request.toolCallId,
            serverId: request.serverId,
            ...(request.serverLabel ? { serverLabel: request.serverLabel } : {}),
            envKey: request.envKey,
            source: effectiveSource,
          },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "system" },
          },
        )
        appendAndEmit(emitEvent, store, event, "server")
        const decision = await activeTurns.waitForCredentialInput(
          created.turnId,
          request.credentialRequestId,
          effectiveSource,
          abortController.signal,
        )
        appendAndEmit(
          emitEvent,
          store,
          makeEvent(
            "credential.input.resolved",
            {
              credentialRequestId: request.credentialRequestId,
              toolCallId: request.toolCallId,
              decision: decision.decision,
            },
            {
              projectId,
              conversationId,
              sessionId: created.sessionId,
              turnId: created.turnId,
              actor: { type: "system" },
            },
          ),
          "server",
        )
        return decision
      },
      recordMemoryRouterRun: async (run) => {
        const errorId = run.error
          ? store.recordError({
              conversationId,
              sessionId: created.sessionId,
              turnId: created.turnId,
              source: "memory_router",
              code: run.error.code,
              message: run.error.message,
              details: { phase: run.phase, modelId: run.modelId, routerDetails: run.error.details },
              recoverable: run.error.recoverable,
            })
          : undefined
        for (const [index, usage] of run.usages.entries()) {
          store.recordMemoryRouterUsage({
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            sourceId: `${created.turnId}:memory_router:${run.phase}:${index + 1}`,
            providerId: run.providerId,
            modelId: run.modelId,
            status: run.status,
            startedAt: run.startedAt,
            completedAt: run.completedAt,
            usage: toStoredUsage(usage),
            metadata: {
              phase: run.phase,
              ...(errorId ? { errorId } : {}),
              ...(run.error ? { errorCode: run.error.code } : {}),
            },
          })
        }
      },
      abortSignal: abortController.signal,
    })) {
      if (agentEvent.type === "agent.suspended") {
        suspended = true
        suspendedWait = agentEvent.wait
        break
      }
      if (agentEvent.type === "agent.handover") {
        appendAndEmit(
          emitEvent,
          store,
          makeEvent(
            "agent.model.handover",
            {
              toolCallId: agentEvent.toolCallId,
              stepIndex: agentEvent.stepIndex,
              fromProviderId: agentEvent.fromProviderId,
              fromModelId: agentEvent.fromModelId,
              toProviderId: agentEvent.toProviderId,
              toModelId: agentEvent.toModelId,
              ...(agentEvent.focus ? { focus: agentEvent.focus } : {}),
            },
            {
              projectId,
              conversationId,
              sessionId: created.sessionId,
              turnId: created.turnId,
              actor: { type: "system", label: "Frontier handover" },
            },
          ),
          "core",
        )
        continue
      }
      if (
        agentEvent.type === "context.compaction.started" ||
        agentEvent.type === "context.compaction.completed" ||
        agentEvent.type === "context.compaction.failed"
      ) {
        sendContextCompactionEvent(emitEvent, store, agentEvent, {
          projectId,
          conversationId,
          sessionId: created.sessionId,
          turnId: created.turnId,
        })
        continue
      }

      if (abortController.signal.aborted) {
        return
      }

      if (agentEvent.type === "model.started") {
        latestModelCallId = agentEvent.modelCallId ?? latestModelCallId
      }

      if (agentEvent.type === "model.reasoning.delta") {
        const modelCallId = agentEvent.modelCallId ?? latestModelCallId
        reasoningText += agentEvent.text
        if (!modelCallId) {
          continue
        }
        store.appendModelStreamChunk({
          modelCallId,
          turnId: created.turnId,
          channel: "reasoning",
          text: agentEvent.text,
        })
        const event = makeEvent(
          "agent.thinking.delta",
          { text: agentEvent.text, modelCallId, stepIndex: agentEvent.stepIndex },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "main_agent" },
          },
        )
        appendAndEmit(emitEvent, store, event, "core")
      }

      if (agentEvent.type === "model.answer.delta") {
        const modelCallId = agentEvent.modelCallId ?? latestModelCallId
        if (!modelCallId) {
          continue
        }
        const separator =
          lastAnswerModelCallId && lastAnswerModelCallId !== modelCallId && answerText.trim().length > 0
            ? ensureParagraphBoundary(answerText)
            : ""
        const text = `${separator}${agentEvent.text}`
        answerText += text
        lastAnswerModelCallId = modelCallId
        store.appendModelStreamChunk({
          modelCallId,
          turnId: created.turnId,
          channel: "answer",
          text,
        })
        const event = makeEvent(
          "agent.answer.delta",
          { messageId: modelCallId, text, modelCallId, stepIndex: agentEvent.stepIndex },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "main_agent" },
          },
        )
        appendAndEmit(emitEvent, store, event, "core")
      }

      if (agentEvent.type === "model.usage") {
        latestUsage = agentEvent.usage
        const modelCallId = agentEvent.modelCallId ?? latestModelCallId
        if (modelCallId) {
          latestUsageByModelCallId.set(modelCallId, agentEvent.usage)
        }
      }

      if (agentEvent.type === "model.completed") {
        latestUsage = agentEvent.usage ?? latestUsage
        const modelCallId = agentEvent.modelCallId ?? latestModelCallId
        if (modelCallId) {
          if (agentEvent.usage) {
            latestUsageByModelCallId.set(modelCallId, agentEvent.usage)
          }
        }
      }

      if (agentEvent.type === "model.response.metadata") {
        const modelCallId = agentEvent.modelCallId ?? latestModelCallId
        if (modelCallId) {
          responseMetadataByModelCallId.set(modelCallId, agentEvent.response)
        }
      }

      if (agentEvent.type === "model.failed") {
        throw agentEvent.error
      }

      if (agentEvent.type === "tool.call.started") {
        sawToolActivity = true
        const toolModelCallId = agentEvent.modelCallId ?? latestModelCallId
        store.createToolCall({
          toolCallId: agentEvent.toolCallId,
          conversationId,
          sessionId: created.sessionId,
          turnId: created.turnId,
          toolName: agentEvent.toolName,
          arguments: agentEvent.input ?? agentEvent.argsPreview ?? {},
          requiresApproval: agentEvent.requiresApproval,
          ...(agentEvent.providerToolCallId ? { providerToolCallId: agentEvent.providerToolCallId } : {}),
          ...(toolModelCallId ? { modelCallId: toolModelCallId } : {}),
        })
        const event = makeEvent(
          "tool.call.started",
          {
            toolCallId: agentEvent.toolCallId,
            providerToolCallId: agentEvent.providerToolCallId,
            toolName: agentEvent.toolName,
            category: agentEvent.category,
            displayName: agentEvent.displayName,
            argsPreview: agentEvent.argsPreview,
            requiresApproval: agentEvent.requiresApproval,
            modelCallId: agentEvent.modelCallId,
            stepIndex: agentEvent.stepIndex,
          },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "tool", id: agentEvent.toolCallId, label: agentEvent.toolName },
          },
        )
        appendAndEmit(emitEvent, store, event, "tool")
      }

      if (agentEvent.type === "tool.call.streaming") {
        sawToolActivity = true
        // Transient pre-call hint so the UI can show "Editing <file>" during the model
        // wait. It is replaced by the persisted tool.call.started event, so we do not store it.
        const event = makeEvent(
          "tool.call.streaming",
          {
            toolCallId: agentEvent.toolCallId,
            providerToolCallId: agentEvent.providerToolCallId,
            toolName: agentEvent.toolName,
            category: agentEvent.category,
            displayName: agentEvent.displayName,
            ...(agentEvent.argsPreview ? { argsPreview: agentEvent.argsPreview } : {}),
            ...(agentEvent.pathPreview ? { pathPreview: agentEvent.pathPreview } : {}),
            modelCallId: agentEvent.modelCallId,
            stepIndex: agentEvent.stepIndex,
          },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "tool", id: agentEvent.toolCallId, label: agentEvent.toolName },
          },
        )
        emitEvent(event)
      }

      if (agentEvent.type === "tool.call.output") {
        sawToolActivity = true
        if (agentEvent.text) {
          store.appendShellOutput(agentEvent.toolCallId, agentEvent.stream, agentEvent.text)
        }
        const event = makeEvent(
          "tool.call.output",
          {
            toolCallId: agentEvent.toolCallId,
            providerToolCallId: agentEvent.providerToolCallId,
            stream: agentEvent.stream,
            text: agentEvent.text,
            data: agentEvent.data,
            modelCallId: agentEvent.modelCallId,
            stepIndex: agentEvent.stepIndex,
          },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "tool", id: agentEvent.toolCallId },
          },
        )
        appendAndEmit(emitEvent, store, event, "tool")
      }

      if (agentEvent.type === "tool.call.completed") {
        sawToolActivity = true
        store.completeToolCall(agentEvent.toolCallId, agentEvent.output)
        if (isBashOutput(agentEvent.output)) {
          store.updateShellCommandMetadata(agentEvent.toolCallId, {
            operation: agentEvent.output.operation ?? "run",
            platform: agentEvent.output.shell.platform,
            shellKind: agentEvent.output.shell.kind,
            shellExecutable: agentEvent.output.shell.executable,
            processId: agentEvent.output.process?.processId,
            processStatus: agentEvent.output.process?.status,
            nextOutputSequence: agentEvent.output.process?.nextOutputSequence,
            terminalId: agentEvent.output.terminal?.terminalId,
            terminalName: agentEvent.output.terminal?.name,
            terminalStatus: agentEvent.output.terminal?.status,
            autoDetached: agentEvent.output.terminal?.autoDetached,
            awaitingInput: agentEvent.output.terminal?.awaitingInput,
            lastPrompt: agentEvent.output.terminal?.lastPrompt,
          })
          store.completeShellCommand(agentEvent.toolCallId, {
            exitCode: agentEvent.output.exitCode,
            signal: agentEvent.output.signal ?? null,
            durationMs: agentEvent.output.durationMs,
            cwd: agentEvent.output.cwd,
          })
        }
        if (isEditOutput(agentEvent.output)) {
          store.recordFileOperations({
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            toolCallId: agentEvent.toolCallId,
            files: agentEvent.output.changedFiles,
          })
          store.recordPatch({
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            toolCallId: agentEvent.toolCallId,
            diff: agentEvent.output.diff,
            files: agentEvent.output.changedFiles,
          })
        }
        const event = makeEvent(
          "tool.call.completed",
          {
            toolCallId: agentEvent.toolCallId,
            providerToolCallId: agentEvent.providerToolCallId,
            summary: agentEvent.summary,
            resultPreview: agentEvent.resultPreview,
            metrics: agentEvent.metrics,
            durationMs: agentEvent.durationMs,
            modelCallId: agentEvent.modelCallId,
            stepIndex: agentEvent.stepIndex,
          },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "tool", id: agentEvent.toolCallId, label: agentEvent.toolName },
          },
        )
        appendAndEmit(emitEvent, store, event, "tool")
      }

      if (agentEvent.type === "tool.call.failed") {
        sawToolActivity = true
        const errorId = store.recordError({
          conversationId,
          sessionId: created.sessionId,
          turnId: created.turnId,
          source: "tool",
          code: agentEvent.error.code,
          message: agentEvent.error.message,
          details: agentEvent.error.details,
          recoverable: agentEvent.error.recoverable,
        })
        store.failToolCall(agentEvent.toolCallId, errorId, agentEvent.error.code === "tool_approval_rejected")
        const event = makeEvent(
          "tool.call.failed",
          {
            toolCallId: agentEvent.toolCallId,
            providerToolCallId: agentEvent.providerToolCallId,
            toolName: agentEvent.toolName,
            error: apiError(agentEvent.error.code, agentEvent.error.message, {
              details: agentEvent.error.details,
              recoverable: agentEvent.error.recoverable,
            }),
            modelCallId: agentEvent.modelCallId,
            stepIndex: agentEvent.stepIndex,
          },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "tool", id: agentEvent.toolCallId, label: agentEvent.toolName },
          },
        )
        appendAndEmit(emitEvent, store, event, "tool")
      }

      if (agentEvent.type === "approval.resolved") {
        if (agentEvent.decision === "approved") {
          store.markToolRunningByApproval(agentEvent.approvalId)
        }
        const event = makeEvent(
          "approval.resolved",
          {
            approvalId: agentEvent.approvalId,
            toolCallId: agentEvent.toolCallId,
            providerToolCallId: agentEvent.providerToolCallId,
            decision: agentEvent.decision,
          },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "system" },
          },
        )
        appendAndEmit(emitEvent, store, event, "server")
      }
    }

    if (abortController.signal.aborted) {
      return
    }

    if (suspended) {
      for (const modelCallId of modelCallIds) {
        store.completeModelCall({
          modelCallId,
          response: { finish: "waiting" },
          ...(responseMetadataByModelCallId.has(modelCallId)
            ? { providerResponse: responseMetadataByModelCallId.get(modelCallId) }
            : {}),
          ...(latestUsageByModelCallId.get(modelCallId) ? { usage: toStoredUsage(latestUsageByModelCallId.get(modelCallId) as ModelUsage) } : {}),
        })
      }
      if (suspendedWait) {
        appendAndEmit(
          emitEvent,
          store,
          makeEvent(
            "turn.waiting",
            {
              turnId: created.turnId,
              terminalNames: suspendedWait.terminalNames,
              wakeOn: suspendedWait.wakeOn,
              reason: suspendedWait.reason,
            },
            {
              projectId,
              conversationId,
              sessionId: created.sessionId,
              turnId: created.turnId,
              actor: { type: "main_agent" },
            },
          ),
          "core",
        )
      }
      return
    }

    if (!answerText.trim() && !sawToolActivity) {
      throw new SocratesError("model_empty_response", "Model provider completed without returning any assistant text.", {
        details: {
          providerId: runtimeConfig.providerId,
          modelId: runtimeConfig.modelId,
        },
        recoverable: true,
      })
    }

    const assistantMessage = store.completeAgentTurn({
      conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      content: answerText,
      reasoning: reasoningText,
    })
    flowStore?.attachClassicGoalAssistantMessage(created.turnId, assistantMessage.id)
    for (const modelCallId of modelCallIds) {
      store.completeModelCall({
        modelCallId,
        response: { messageId: assistantMessage.id, finish: "completed" },
        ...(responseMetadataByModelCallId.has(modelCallId)
          ? { providerResponse: responseMetadataByModelCallId.get(modelCallId) }
          : {}),
        ...(latestUsageByModelCallId.get(modelCallId) ? { usage: toStoredUsage(latestUsageByModelCallId.get(modelCallId) as ModelUsage) } : {}),
      })
    }
    const turnUsageReport = store.buildTurnUsageReport(created.turnId)

    const messageCompleted = makeEvent(
      "message.completed",
      {
        message: assistantMessage,
        ...(latestUsage ? { usage: toContractUsage(latestUsage) } : {}),
        ...(turnUsageReport ? { turnUsageReport } : {}),
      },
      {
        projectId,
        conversationId,
        sessionId: created.sessionId,
        turnId: created.turnId,
        actor: { type: "main_agent" },
      },
    )
    appendAndEmit(emitEvent, store, messageCompleted, "core")

    const turnCompleted = makeEvent(
      "turn.completed",
      {
        turnId: created.turnId,
        assistantMessageId: assistantMessage.id,
        summary: "Agent response completed.",
        ...(turnUsageReport ? { turnUsageReport } : {}),
      },
      {
        projectId,
        conversationId,
        sessionId: created.sessionId,
        turnId: created.turnId,
        actor: { type: "main_agent" },
      },
    )
    appendAndEmit(emitEvent, store, turnCompleted, "core")
    store.indexTurnTraceDocuments(projectId, conversationId, created.turnId)
    store.recordProjectStateLedgerTurn(projectId, conversationId, created.turnId, "completed", answerText)
    store.completeTerminalTaskForTurn(created.turnId, "completed")

    const postTurnHistory = store.getConversationModelMessages(projectId, conversationId, { includeImageParts })
    await agent.precomputeContext({
      providerId: runtimeConfig.providerId,
      modelId: runtimeConfig.modelId,
      runtimeConfig,
      messages: postTurnHistory,
      promptContext,
      contextCompression: createContextCompressionRuntime(store, projectId, conversationId, created.sessionId, created.turnId),
    })
  } catch (error) {
    if (abortController.signal.aborted) {
      return
    }
    const normalized = normalizeError(error)
    const errorId = store.failTurn({
      conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    })
    for (const modelCallId of modelCallIds) {
      store.failModelCall(modelCallId, errorId)
    }
    const failed = makeEvent(
      "turn.failed",
      {
        turnId: created.turnId,
        error: apiError(normalized.code, normalized.message, { details: normalized.details }),
      },
      {
        projectId,
        conversationId,
        sessionId: created.sessionId,
        turnId: created.turnId,
        actor: { type: "main_agent" },
      },
    )
    appendAndEmit(emitEvent, store, failed, "core")
    store.indexTurnTraceDocuments(projectId, conversationId, created.turnId)
    store.recordProjectStateLedgerTurn(projectId, conversationId, created.turnId, "failed", answerText)
    store.completeTerminalTaskForTurn(created.turnId, "failed")
  } finally {
    activeTurns.delete(created.turnId)
  }
}

export const resumeTerminalTask = async (
  store: SocratesStore,
  agent: SocratesAgent,
  activeTurns: ActiveTurns,
  terminals: ConversationTerminalManager,
  subscriptions: ConversationSubscriptions,
  task: ReturnType<SocratesStore["claimTerminalTaskWake"]>[number],
  mcpRuntime?: McpRuntime,
  titleProvider?: ModelProvider,
  flowStore?: V2FlowStore,
): Promise<void> => {
  const continued = store.beginTerminalTaskContinuation(task)
  if (!continued) {
    return
  }
  appendAndEmit(
    (event) => subscriptions.emit(event),
    store,
    makeEvent(
      "turn.resumed",
      {
        turnId: continued.turnId,
        resumedFromTurnId: continued.currentTurnId,
        terminalName: continued.terminalName,
        wakeEvent: continued.wakeEvent,
      },
      {
        projectId: continued.projectId,
        conversationId: continued.conversationId,
        sessionId: continued.sessionId,
        turnId: continued.turnId,
        actor: { type: "main_agent" },
      },
    ),
    "core",
  )
  const fromSequence = store.getModelVisibleTerminalOutputSequence(continued.terminalId)
  const output = store.terminalOutputSnapshot(continued.terminalId, fromSequence, 8_000)
  store.setModelVisibleTerminalOutputSequence(continued.terminalId, output.modelVisibleNextSequence)
  const taskProgress = store.getTaskEvidence(continued.turnId, { operation: "overview", limit: 10, charLimit: 6_000 })
  const wakeContext = [
    `You were waiting for Terminal \"${continued.terminalName}\".`,
    `Wake reason: ${continued.wakeEvent}.`,
    `Terminal status: ${continued.terminalStatus}${continued.exitCode === null ? "" : `; exit code ${continued.exitCode}`}.`,
    `Wait reason: ${continued.reason}.`,
    output.stdout || output.stderr ? `New terminal output:\n${[output.stdout, output.stderr].filter(Boolean).join("\n")}` : "No new terminal output was captured.",
    "Task progress before this wake is authoritative lifecycle evidence. Do not restart completed, stopped, exited, or otherwise already-attempted work merely because it is absent from the active Terminal list. Verify with bash list/status only when the remaining task genuinely requires it.",
    taskProgress.content,
  ].join("\n")
  await handleChatMessageSend(undefined, store, agent, activeTurns, terminals, subscriptions, undefined, mcpRuntime, titleProvider, {
    projectId: continued.projectId,
    conversationId: continued.conversationId,
    sessionId: continued.sessionId,
    turnId: continued.turnId,
    runtimeConfigId: continued.runtimeConfigId,
    runtimeConfig: continued.runtimeConfig,
    wakeContext,
  }, flowStore)
}

const createToolExecutors = (
  store: SocratesStore,
  projectId: string,
  turnId: string,
  activeTurns: ActiveTurns,
  terminals: ConversationTerminalManager,
  mcpRuntime?: McpRuntime,
  options: { exposeMcpServer?: (serverId: string) => void } = {},
): ToolExecutors => {
  const withFreshness = <C extends object>(context: C): C & { fileFreshness?: FileFreshnessTracker } => {
    const tracker = activeTurns.getFileFreshness(turnId)
    return tracker ? { ...context, fileFreshness: tracker } : context
  }
  let skillsDiscoverySeen = false
  let skillsAvailable: boolean | undefined
  const hasVisibleSkills = (): boolean => {
    skillsAvailable ??= store.runSkillsTool(projectId, { operation: "list", n: 1 }).totalMatches > 0
    return skillsAvailable
  }
  const requireSkillsDiscoveryForProjectResources = (toolName: "read" | "list_project_resources", resourcePath?: string): void => {
    if (skillsDiscoverySeen || !hasVisibleSkills()) {
      return
    }
    throw new SocratesError(
      "skills_discovery_required",
      `Before using ${toolName} for uploaded project resources, call skills({ operation: "list" }) first, then describe the exact relevant skill id if one applies. Retry ${toolName} after visible skill discovery.`,
      {
        recoverable: true,
        details: {
          toolName,
          ...(resourcePath ? { resourcePath } : {}),
          requiredTool: "skills",
          requiredOperation: "list",
        },
      },
    )
  }
  return {
  read: (input, context) => {
    if (isProjectResourceRead(input.path)) {
      requireSkillsDiscoveryForProjectResources("read", input.path)
    }
    return readWorkspacePath(input, withFreshness(context))
  },
  search: (input, context) => searchWorkspace(input, context),
  url_fetch: (input, context) => fetchUrlForTool(input, context.abortSignal),
  edit: (input, context) => editWorkspace(input, withFreshness(context)),
  apply_patch: (input, context) => applyPatchWorkspace(input, withFreshness(context)),
  bash: async (input, context) => {
    const toolCallId = context.toolCallId ?? "unknown"
    store.createShellCommand({
      toolCallId,
      conversationId: context.conversationId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      command: input.command ?? `${input.operation ?? "run"} ${input.processId ?? ""}`.trim(),
      cwd: input.cwd ?? context.workspacePath,
      metadata: { operation: input.operation ?? "run", processId: input.processId, terminalId: input.terminalId },
    })
    try {
      const execute = () => terminals.executeBash(input, context, activeTurns)
      const isWaitingForWorkspaceMutation = shouldSerializeBashInput(input) && isWorkspaceMutationLocked(context.workspacePath)
      const output = shouldSerializeBashInput(input)
        ? await withWorkspaceMutationLock(context.workspacePath, async () => {
            if (isWaitingForWorkspaceMutation) {
              context.onOutput?.({ stream: "log", text: "Waiting for another workspace mutation in this project to finish...\n" })
            }
            return execute()
          })
        : await execute()
      store.updateShellCommandMetadata(toolCallId, {
        operation: output.operation ?? input.operation ?? "run",
        platform: output.shell.platform,
        shellKind: output.shell.kind,
        shellExecutable: output.shell.executable,
        processId: output.process?.processId,
        processStatus: output.process?.status,
        nextOutputSequence: output.process?.nextOutputSequence,
        terminalId: output.terminal?.terminalId,
        terminalName: output.terminal?.name,
        terminalStatus: output.terminal?.status,
        autoDetached: output.terminal?.autoDetached,
        awaitingInput: output.terminal?.awaitingInput,
        lastPrompt: output.terminal?.lastPrompt,
      })
      if (output.timedOut && !output.terminal) {
        activeTurns.resetShellSession(context.turnId, context.workspacePath)
      }
      return output
    } catch (error) {
      if (isShellSessionResetError(error)) {
        activeTurns.resetShellSession(context.turnId, context.workspacePath)
      }
      store.failShellCommand(toolCallId)
      throw error
    }
  },
  wait: (input, context) => {
    const registered = store.registerTerminalWait({
      projectId,
      conversationId: context.conversationId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      runtimeConfig: context.runtimeConfig,
      wait: input,
    })
    return Promise.resolve({
      status: registered.status,
      terminalNames: input.terminalNames,
      wakeOn: input.wakeOn,
      reason: input.reason,
      message: registered.message,
    })
  },
  current_time: () => Promise.resolve(currentRuntimeTime()),
  trace_retrieve: (input, context) => store.retrieveMainToolTraces(projectId, context.conversationId, input as TraceRetrieveMainToolInput).then((result) => result as never),
  memory_search: (input) => store.searchMemory(projectId, input, false),
  turn_evidence: (input, context) => Promise.resolve(store.getTaskEvidence(context.turnId, input)),
  tool_docs: (input) => Promise.resolve(store.runToolDocsTool(projectId, input)),
  skills: async (input, context) => {
    const output = input.operation === "preview_import" || input.operation === "commit_import"
      ? await store.runSkillsImportTool(projectId, input, {
          conversationId: context.conversationId,
          turnId: context.turnId,
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        })
      : store.runSkillsTool(projectId, input)
    if (input.operation === "list" || input.operation === "describe" || input.operation === "search" || input.operation === "read") {
      skillsDiscoverySeen = true
    }
    return output
  },
  skill_manager: async (input, context) => {
    if (input.operation === "create") {
      const { skill } = await store.buildProjectSkill(
        projectId,
        { name: input.name, request: input.request },
        { conversationId: context.conversationId, sessionId: context.sessionId, turnId: context.turnId },
      )
      return { operation: "create", name: skill.name, scope: "project", status: "created" }
    }
    const deleted = store.deleteProjectSkill(projectId, input.name)
    return { operation: "delete", name: deleted.deletedSkillName, scope: "project", status: "deleted" }
  },
  memory_note: (input, context) =>
    Promise.resolve(store.createMemoryNote(projectId, input, {
      conversationId: context.conversationId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    })),
  project_docs: (input, context) =>
    docsMutationOperations.has(input.operation)
      ? withWorkspaceMutationLock(context.workspacePath, async () => store.runProjectDocsTool(projectId, context.workspacePath, input))
      : Promise.resolve(store.runProjectDocsTool(projectId, context.workspacePath, input)),
  repo_docs: (input, context) =>
    docsMutationOperations.has(input.operation)
      ? withWorkspaceMutationLock(context.workspacePath, async () => store.runRepoDocsTool(projectId, context.workspacePath, input))
      : Promise.resolve(store.runRepoDocsTool(projectId, context.workspacePath, input)),
  soul: (input) => Promise.resolve(store.runSoulTool(projectId, input)),
  user_profile: (input) => Promise.resolve(store.runUserProfileTool(projectId, input)),
  list_project_resources: (input) => {
    requireSkillsDiscoveryForProjectResources("list_project_resources")
    return Promise.resolve(listProjectResourcesForTool(store, projectId, input))
  },
  mcp_registry: async (input, context, resolvedSecretEnv) => {
    if (!mcpRuntime) {
      throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
    }
    const output = await mcpRuntime.handleRegistryTool(input, {
      workspacePath: context.workspacePath,
      ...(resolvedSecretEnv ? { resolvedSecretEnv } : {}),
    })
    if (output.tools && output.tools.length > 0) {
      options.exposeMcpServer?.(output.server?.id ?? input.id ?? input.serverId ?? input.name ?? input.serverName ?? input.preset ?? "playwright")
    }
    return output
  },
  mcp_dynamic: (input, context) => {
    if (!mcpRuntime) {
      throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
    }
    return mcpRuntime.callDynamicTool(input.dynamicName, input.input, {
      cwd: context.workspacePath,
      sessionKey: context.conversationId,
      workspacePath: context.workspacePath,
    })
  },
  }
}

const sendContextCompactionEvent = (
  emitEvent: EventSink,
  store: SocratesStore,
  agentEvent: ContextCompactionLifecycleEvent,
  context: { projectId: string; conversationId: string; sessionId: string; turnId: string },
): void => {
  if (agentEvent.type === "context.compaction.started") {
    appendAndEmit(
      emitEvent,
      store,
      makeEvent(
        "context.compaction.started",
        {
          snapshotId: agentEvent.snapshotId,
          reason: agentEvent.reason,
          contextUsedTokensEstimate: agentEvent.contextUsedTokensEstimate,
          targetTokens: agentEvent.targetTokens,
        },
        {
          ...context,
          actor: { type: "system" },
        },
      ),
      "core",
    )
    return
  }

  if (agentEvent.type === "context.compaction.completed") {
    appendAndEmit(
      emitEvent,
      store,
      makeEvent(
        "context.compaction.completed",
        {
          snapshotId: agentEvent.snapshotId,
          inputTokensEstimate: agentEvent.inputTokensEstimate,
          outputTokensEstimate: agentEvent.outputTokensEstimate,
          contextUsedTokensEstimate: agentEvent.contextUsedTokensEstimate,
          sizeClass: agentEvent.sizeClass,
        },
        {
          ...context,
          actor: { type: "system" },
        },
      ),
      "core",
    )
    return
  }

  appendAndEmit(
    emitEvent,
    store,
    makeEvent(
      "context.compaction.failed",
      {
        ...(agentEvent.snapshotId ? { snapshotId: agentEvent.snapshotId } : {}),
        error: apiError(agentEvent.error.code, agentEvent.error.message, { details: agentEvent.error.details }),
      },
      {
        ...context,
        actor: { type: "system" },
      },
    ),
    "core",
  )
}

const sendContextUsageSnapshot = (
  emitEvent: EventSink,
  store: SocratesStore,
  input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId: string
    modelCallId: string
    providerId: string
    modelId: string
    contextWindowTokens: number
    contextUsedTokens: number
    metadata?: Record<string, unknown>
  },
): void => {
  const contextLeftTokens = Math.max(input.contextWindowTokens - input.contextUsedTokens, 0)
  const contextUsedPercent =
    input.contextWindowTokens > 0 ? Math.min(100, Math.round((input.contextUsedTokens / input.contextWindowTokens) * 1000) / 10) : 0
  store.recordContextUsageSnapshot({
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    modelCallId: input.modelCallId,
    providerId: input.providerId,
    modelId: input.modelId,
    contextWindowTokens: input.contextWindowTokens,
    contextUsedTokens: input.contextUsedTokens,
    metadata: input.metadata ?? { source: "model_context_estimate" },
  })
  appendAndEmit(
    emitEvent,
    store,
    makeEvent(
      "context.usage.snapshot",
      {
        providerId: input.providerId,
        modelId: input.modelId,
        contextWindowTokens: input.contextWindowTokens,
        contextUsedTokens: input.contextUsedTokens,
        contextLeftTokens,
        contextUsedPercent,
      },
      {
        projectId: input.projectId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        actor: { type: "main_agent" },
      },
    ),
    "core",
  )
}

const createContextCompressionRuntime = (
  store: SocratesStore,
  projectId: string,
  conversationId: string,
  sessionId: string,
  turnId: string,
): ContextCompressionRuntime => {
  const compressor = store.getWorkerModelSetting("socrates_context_compactor")
  const fallback = process.env.SOCRATES_CONTEXT_COMPRESSION_FALLBACK_ENABLED === "false"
    ? undefined
    : contextCompressorFallback(store, compressor)
  return {
    enabled: process.env.SOCRATES_CONTEXT_COMPRESSION_ENABLED !== "false",
    projectId,
    conversationId,
    sessionId,
    turnId,
    workspacePath: store.getPrimaryWorkspacePath(projectId),
    compressorProviderId: compressor.providerId,
    compressorAuthMode: compressor.authMode ?? "api_key",
    compressorModelId: compressor.modelId,
    compressorThinkingEnabled: compressor.thinkingEnabled,
    ...(compressor.thinkingEffort ? { compressorThinkingEffort: compressor.thinkingEffort } : {}),
    ...(fallback ? { compressorFallbacks: [fallback] } : {}),
    getLatestSnapshot: () => store.getLatestContextCompactionSnapshot(conversationId),
    startSnapshot: (input) =>
      store.startContextCompactionSnapshot({
        ...input,
        projectId,
        conversationId,
        sessionId,
        turnId,
      }),
    completeSnapshot: (input) => store.completeContextCompactionSnapshot(input),
    failSnapshot: (input) => {
      store.failContextCompactionSnapshot(input)
    },
  }
}

const contextCompressorFallback = (
  store: SocratesStore,
  primary: ReturnType<SocratesStore["getWorkerModelSetting"]>,
): NonNullable<ContextCompressionRuntime["compressorFallbacks"]>[number] | undefined => {
  const available = store.listAvailableModels()
  const fallback = available.defaultModel
    ? available.models.find(
        (model) =>
          model.providerId === available.defaultModel?.providerId &&
          model.authMode === available.defaultModel?.authMode &&
          model.modelId === available.defaultModel?.modelId,
      )
    : undefined
  if (!fallback || (fallback.providerId === primary.providerId && fallback.authMode === (primary.authMode ?? "api_key") && fallback.modelId === primary.modelId)) {
    return undefined
  }
  const thinking = fallback.thinkingOptions.find((option) => option.id === fallback.defaultThinkingOptionId) ?? fallback.thinkingOptions[0]
  return {
    providerId: fallback.providerId,
    authMode: fallback.authMode,
    modelId: fallback.modelId,
    thinkingEnabled: thinking?.enabled ?? false,
    ...(thinking?.effort ? { thinkingEffort: thinking.effort } : {}),
  }
}

const isProjectResourceRead = (inputPath: string): boolean => {
  const normalized = inputPath.replaceAll("\\", "/")
  return normalized.startsWith(".socrates/resources/") || normalized.includes("/.socrates/resources/")
}

const listProjectResourcesForTool = (
  store: SocratesStore,
  projectId: string,
  input: Parameters<ToolExecutors["list_project_resources"]>[0],
) => {
  const charLimit = 20_000
  const limit = input.limit ?? 25
  const allResources = store
    .listResources(projectId)
    .filter((resource) => (input.kind ? resource.kind === input.kind : true))
  const resources: Array<Omit<ProjectResource, "projectId">> = []
  let returnedLength = 2

  for (const resource of allResources) {
    if (resources.length >= limit) {
      break
    }
    const next = {
      id: resource.id,
      name: resource.name,
      kind: resource.kind,
      source: resource.source,
      ...(resource.uri ? { uri: resource.uri } : {}),
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      ...(resource.sizeBytes === undefined ? {} : { sizeBytes: resource.sizeBytes }),
      status: resource.status,
    }
    const projectedLength = JSON.stringify([...resources, next]).length
    if (projectedLength > charLimit) {
      break
    }
    resources.push(next)
    returnedLength = projectedLength
  }

  const hiddenCount = allResources.length - resources.length
  return {
    resources,
    summary:
      hiddenCount > 0
        ? `Listed ${resources.length} of ${allResources.length} project resources.`
        : `Listed ${resources.length} project resources.`,
    totalResources: allResources.length,
    truncation: {
      truncated: hiddenCount > 0,
      charLimit,
      originalLength: JSON.stringify(allResources).length,
      returnedLength,
    },
    ...(hiddenCount > 0 ? { warnings: [`${hiddenCount} resources were omitted by the output cap.`] } : {}),
  }
}


const providerCacheKey = (projectId: string, conversationId: string): string => `project:${projectId}:conversation:${conversationId}`

const ensureParagraphBoundary = (text: string): string => (text.endsWith("\n\n") ? "" : "\n\n")

const toContractUsage = (usage: ModelUsage) => ({
  ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
  ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
  ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
  ...(usage.uncachedInputTokens === undefined ? {} : { uncachedInputTokens: usage.uncachedInputTokens }),
  ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
  ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  ...(usage.costSource === undefined ? {} : { costSource: usage.costSource }),
})

const toStoredUsage = (usage: ModelUsage) => ({
  ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
  ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
  ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
  ...(usage.uncachedInputTokens === undefined ? {} : { uncachedInputTokens: usage.uncachedInputTokens }),
  ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
  ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  ...(usage.costSource === undefined ? {} : { costSource: usage.costSource }),
  ...(usage.routedProvider === undefined ? {} : { routedProvider: usage.routedProvider }),
  ...(usage.pricingSnapshot === undefined ? {} : { pricingSnapshot: usage.pricingSnapshot }),
  ...(usage.providerMetadata === undefined ? {} : { providerMetadata: usage.providerMetadata }),
  ...(usage.raw === undefined ? {} : { raw: usage.raw }),
})

const isBashOutput = (
  output: unknown,
): output is {
  operation?: string
  cwd: string
  exitCode: number | null
  signal?: string | null
  durationMs: number
  shell: { platform: string; kind: string; executable: string }
  process?: { processId: string; status: string; nextOutputSequence?: number }
  terminal?: {
    terminalId: string
    name: string
    status: string
    autoDetached?: boolean
    awaitingInput?: boolean
    lastPrompt?: string
  }
} =>
  typeof output === "object" &&
  output !== null &&
  "cwd" in output &&
  "stdout" in output &&
  "stderr" in output &&
  "durationMs" in output &&
  "shell" in output

const isEditOutput = (output: unknown): output is { changedFiles: Array<{ path: string; operation: string }>; diff: string } =>
  typeof output === "object" && output !== null && "changedFiles" in output && "diff" in output
