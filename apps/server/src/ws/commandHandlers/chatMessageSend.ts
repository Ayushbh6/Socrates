import type { WebSocket } from "ws"
import {
  DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS,
  findModelOption,
  type ContextCompactionLifecycleEvent,
  type ContextCompressionRuntime,
  type SocratesAgent,
  type ToolExecutors,
} from "@socrates/core"
import type { ClientCommand, ProjectEmbeddingStatus, ProjectResource } from "@socrates/contracts"
import type { McpRuntime } from "@socrates/mcp"
import type { ModelProvider, ModelUsage } from "@socrates/providers"
import { normalizeError, nowIso, SocratesError } from "@socrates/shared"
import {
  applyPatchWorkspace,
  editWorkspace,
  FileFreshnessTracker,
  formatPythonEnvironmentHints,
  inspectPythonEnvironment,
  isWorkspaceMutationLocked,
  isShellSessionResetError,
  readWorkspacePath,
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

const requireCommandScope = (command: ClientCommand): { projectId: string; conversationId: string } => {
  if (!command.projectId || !command.conversationId) {
    throw new SocratesError("missing_command_scope", "projectId and conversationId are required for this command")
  }
  return { projectId: command.projectId, conversationId: command.conversationId }
}

const contextBudgetTokens = DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS.triggerTokens

const withWakeContext = (
  history: ReturnType<SocratesStore["getConversationModelMessages"]>,
  wakeContext: string | undefined,
): ReturnType<SocratesStore["getConversationModelMessages"]> => {
  if (!wakeContext?.trim()) {
    return history
  }
  return [
    {
      role: "developer",
      content: `<socrates_wake_context>\n${wakeContext}\n</socrates_wake_context>`,
    },
    ...history,
  ]
}

export const handleChatMessageSend = async (
  socket: WebSocket,
  store: SocratesStore,
  agent: SocratesAgent,
  activeTurns: ActiveTurns,
  terminals: ConversationTerminalManager,
  subscriptions: ConversationSubscriptions,
  command: Extract<ClientCommand, { type: "chat.message.send" }>,
  mcpRuntime?: McpRuntime,
  titleProvider?: ModelProvider,
): Promise<void> => {
  const { projectId, conversationId } = requireCommandScope(command)
  subscriptions.subscribe(socket, conversationId)
  const emitEvent: EventSink = (event) => subscriptions.emit(event, socket)
  const created = store.createTurnFromUserMessage(projectId, conversationId, command.payload)
  const abortController = activeTurns.create(created.turnId)

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

  if (created.shouldGenerateTitle && titleProvider) {
    const titleUsageSourceId = `title_${created.turnId}`
    const titleStartedAt = nowIso()
    void generateConversationTitle({
      provider: titleProvider,
      projectId,
      conversationId,
      message: created.userMessage,
      fallbackTitle: created.fallbackTitle,
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

  const selectedModel = findModelOption(command.payload.runtimeConfig.providerId, command.payload.runtimeConfig.modelId)
  const includeImageParts = selectedModel?.capabilities?.vision === true
  const history = store.getConversationModelMessages(projectId, conversationId, { includeImageParts })
  const workspacePath = store.getPrimaryWorkspacePath(projectId)
  store.ensureProjectMemory(projectId)
  const wakeContext =
    history.filter((message) => message.role === "user").length === 1
      ? store.buildWakeMemoryContext(projectId, command.payload.content)
      : undefined
  const modelHistory = withWakeContext(history, wakeContext)
  const terminalContext = store.terminalContextBrief(conversationId)
  const promptContext = {
    ...store.getAgentContext(projectId),
    workspaceGuidance: formatPythonEnvironmentHints(inspectPythonEnvironment(workspacePath)),
    workspaceCommandEnvironment: formatWorkspaceCommandEnvironmentBrief(),
    semanticRetrievalStatus: formatSemanticRetrievalStatus(store.getProjectEmbeddingStatus(projectId)),
    mcpRuntimeBrief:
      "MCP is available on demand through mcp_registry. Browser automation presets such as Playwright are discoverable there; dynamic MCP tool lists/schemas are not included in this prompt or first tool call surface.",
    ...(terminalContext ? { terminalContext } : {}),
  }
  const modelCallIds: string[] = []
  const latestUsageByModelCallId = new Map<string, ModelUsage>()
  const responseMetadataByModelCallId = new Map<string, unknown>()
  let latestModelCallId: string | undefined

  let answerText = ""
  let reasoningText = ""
  let latestUsage: ModelUsage | undefined
  let lastAnswerModelCallId: string | undefined
  const exposedMcpServers = new Set<string>()

  try {
    for await (const agentEvent of agent.streamTurn({
      projectId,
      conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      providerId: command.payload.runtimeConfig.providerId,
      modelId: command.payload.runtimeConfig.modelId,
      runtimeConfig: command.payload.runtimeConfig,
      cacheKey: providerCacheKey(projectId, conversationId),
      messages: modelHistory,
      promptContext,
      workspacePath,
      toolExecutors: createToolExecutors(store, projectId, created.turnId, activeTurns, terminals, mcpRuntime, {
        exposeMcpServer: (serverId) => exposedMcpServers.add(serverId),
      }),
      dynamicTools: () =>
        mcpRuntime ? [...exposedMcpServers].flatMap((serverId) => mcpRuntime.getDynamicToolDefinitions(serverId)) : [],
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
          },
        })
        modelCallIds.push(modelCallId)
        latestModelCallId = modelCallId
        const model = findModelOption(modelRequest.providerId, modelRequest.modelId)
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
      abortSignal: abortController.signal,
    })) {
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

    const assistantMessage = store.completeAgentTurn({
      conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      content: answerText,
      reasoning: reasoningText,
    })
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

    const postTurnHistory = store.getConversationModelMessages(projectId, conversationId, { includeImageParts })
    await agent.precomputeContext({
      providerId: command.payload.runtimeConfig.providerId,
      modelId: command.payload.runtimeConfig.modelId,
      runtimeConfig: command.payload.runtimeConfig,
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
  } finally {
    activeTurns.delete(created.turnId)
  }
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
  return {
  read: (input, context) => readWorkspacePath(input, withFreshness(context)),
  search: (input, context) => searchWorkspace(input, context),
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
  trace_retrieve: (input, context) => Promise.resolve(store.retrieveToolTraces(projectId, context.conversationId, input)),
  tool_docs: (input) => Promise.resolve(store.runToolDocsTool(projectId, input)),
  skills: (input) => Promise.resolve(store.runSkillsTool(projectId, input)),
  project_docs: (input, context) =>
    input.operation === "edit"
      ? withWorkspaceMutationLock(context.workspacePath, async () => store.runProjectDocsTool(projectId, context.workspacePath, input))
      : Promise.resolve(store.runProjectDocsTool(projectId, context.workspacePath, input)),
  repo_docs: (input, context) =>
    input.operation === "edit"
      ? withWorkspaceMutationLock(context.workspacePath, async () => store.runRepoDocsTool(projectId, context.workspacePath, input))
      : Promise.resolve(store.runRepoDocsTool(projectId, context.workspacePath, input)),
  soul: (input) => Promise.resolve(store.runSoulTool(projectId, input)),
  list_project_resources: (input) => Promise.resolve(listProjectResourcesForTool(store, projectId, input)),
  mcp_registry: async (input) => {
    if (!mcpRuntime) {
      throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
    }
    const output = await mcpRuntime.handleRegistryTool(input)
    if (output.tools && output.tools.length > 0) {
      options.exposeMcpServer?.(output.server?.id ?? input.serverName ?? input.serverId ?? input.preset ?? "playwright")
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
): ContextCompressionRuntime => ({
  enabled: process.env.SOCRATES_CONTEXT_COMPRESSION_ENABLED !== "false",
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
})

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

const formatWorkspaceCommandEnvironmentBrief = (): string =>
  [
    "Workspace Terminal commands run with a sanitized user-workspace environment.",
    "- Socrates runtime variables, app API URLs, runtime paths, provider API keys, NODE_ENV, npm/yarn production or omit flags, and CI are not inherited from the server process.",
    "- Safe OS basics such as PATH, HOME/user profile, shell identity, temp paths, locale variables, and Windows system roots are preserved.",
    "- Explicit command-level env assignments still work when a task intentionally needs them, for example NODE_ENV=production npm run build.",
  ].join("\n")

const formatSemanticRetrievalStatus = (status: ProjectEmbeddingStatus): string => {
  const warnings = status.warnings?.length ? `\n- Warnings: ${status.warnings.join(" ")}` : ""
  const provider = status.providerId && status.modelId ? `${status.providerId}/${status.modelId}` : "not configured"
  const counts = `documents total=${status.totalDocuments}, indexed=${status.indexedDocuments}, pending=${status.pendingDocuments}, failed=${status.failedDocuments}`

  if (!status.configured) {
    return [
      "Semantic retrieval: not configured.",
      `- Provider/model: ${provider}.`,
      `- Trace document state: ${counts}.`,
      "- Use trace_retrieve for lexical/exact search and inspect. Do not claim semantic retrieval was used.",
      warnings.trim(),
    ]
      .filter(Boolean)
      .join("\n")
  }

  const activeJob = status.activeJob ? `\n- Active indexing job: ${status.activeJob.status}.` : ""
  const lastError = status.lastError ? `\n- Last error: ${status.lastError}` : ""
  const state = semanticRetrievalState(status)
  const usage =
    status.ready && status.indexedDocuments > 0
      ? '- trace_retrieve supports mode="exact" for lexical search, mode="semantic" for fuzzy conceptual recall, mode="combined" for hybrid recall, and mode="audit" for runtime/tool history. Default remains exact.'
      : "- Treat trace_retrieve as lexical/exact only until indexing is ready. Do not claim semantic retrieval was used."

  return [
    `Semantic retrieval: ${state}.`,
    `- Provider/model: ${provider}.`,
    `- Trace document state: ${counts}.`,
    usage,
    activeJob.trim(),
    lastError.trim(),
    warnings.trim(),
  ]
    .filter(Boolean)
    .join("\n")
}

const semanticRetrievalState = (status: ProjectEmbeddingStatus): string => {
  if (status.status === "failed" || status.lastError) {
    return "failed"
  }
  if (status.ready && status.indexedDocuments > 0 && status.pendingDocuments > 0) {
    return "ready (partially indexed)"
  }
  if (status.ready && status.indexedDocuments > 0) {
    return "ready"
  }
  if (status.activeJob && (status.activeJob.status === "queued" || status.activeJob.status === "running")) {
    return "indexing"
  }
  if (status.ready) {
    return "ready, waiting for indexed documents"
  }
  return status.status ?? "not ready"
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
