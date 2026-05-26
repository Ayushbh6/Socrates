import type { WebSocket } from "ws"
import {
  DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS,
  findModelOption,
  type ContextCompactionLifecycleEvent,
  type ContextCompressionRuntime,
  type SocratesAgent,
  type ToolExecutors,
} from "@socrates/core"
import type { ClientCommand, ModelUsage, ProjectResource } from "@socrates/contracts"
import { normalizeError, SocratesError } from "@socrates/shared"
import { editWorkspace, formatPythonEnvironmentHints, inspectPythonEnvironment, readWorkspacePath, searchWorkspace } from "@socrates/workspace"
import { apiError } from "../../http"
import type { SocratesStore } from "../../services/store"
import type { ActiveTurns } from "../activeTurns"
import { appendAndSend, makeEvent, sendEvent } from "../eventSender"

const requireCommandScope = (command: ClientCommand): { projectId: string; conversationId: string } => {
  if (!command.projectId || !command.conversationId) {
    throw new SocratesError("missing_command_scope", "projectId and conversationId are required for this command")
  }
  return { projectId: command.projectId, conversationId: command.conversationId }
}

const contextBudgetTokens = DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS.hardCapTokens

export const handleChatMessageSend = async (
  socket: WebSocket,
  store: SocratesStore,
  agent: SocratesAgent,
  activeTurns: ActiveTurns,
  command: Extract<ClientCommand, { type: "chat.message.send" }>,
): Promise<void> => {
  const { projectId, conversationId } = requireCommandScope(command)
  const created = store.createTurnFromUserMessage(projectId, conversationId, command.payload)
  const abortController = activeTurns.create(created.turnId)

  sendEvent(
    socket,
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

  const history = store.getConversationModelMessages(projectId, conversationId)
  const workspacePath = store.getPrimaryWorkspacePath(projectId)
  const promptContext = {
    ...store.getAgentContext(projectId),
    workspaceGuidance: formatPythonEnvironmentHints(inspectPythonEnvironment(workspacePath)),
  }
  const modelCallIds: string[] = []
  const latestUsageByModelCallId = new Map<string, ModelUsage>()
  let latestModelCallId: string | undefined

  let answerText = ""
  let reasoningText = ""
  let latestUsage: ModelUsage | undefined
  let lastAnswerModelCallId: string | undefined

  try {
    for await (const agentEvent of agent.streamTurn({
      projectId,
      conversationId,
      sessionId: created.sessionId,
      turnId: created.turnId,
      providerId: command.payload.runtimeConfig.providerId,
      modelId: command.payload.runtimeConfig.modelId,
      runtimeConfig: command.payload.runtimeConfig,
      messages: history,
      promptContext,
      workspacePath,
      toolExecutors: createToolExecutors(store, projectId, activeTurns),
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
          sendContextUsageSnapshot(socket, store, {
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
        appendAndSend(socket, store, event, "server")
        return activeTurns.waitForApproval(created.turnId, approvalId, abortController.signal)
      },
      abortSignal: abortController.signal,
    })) {
      if (
        agentEvent.type === "context.compaction.started" ||
        agentEvent.type === "context.compaction.completed" ||
        agentEvent.type === "context.compaction.failed"
      ) {
        sendContextCompactionEvent(socket, store, agentEvent, {
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
          { text: agentEvent.text },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "main_agent" },
          },
        )
        appendAndSend(socket, store, event, "core")
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
          { messageId: modelCallId, text },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "main_agent" },
          },
        )
        appendAndSend(socket, store, event, "core")
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

      if (agentEvent.type === "model.failed") {
        throw agentEvent.error
      }

      if (agentEvent.type === "tool.call.started") {
        store.createToolCall({
          toolCallId: agentEvent.toolCallId,
          conversationId,
          sessionId: created.sessionId,
          turnId: created.turnId,
          toolName: agentEvent.toolName,
          arguments: agentEvent.input ?? agentEvent.argsPreview ?? {},
          requiresApproval: agentEvent.requiresApproval,
          ...(latestModelCallId ? { modelCallId: latestModelCallId } : {}),
        })
        const event = makeEvent(
          "tool.call.started",
          {
            toolCallId: agentEvent.toolCallId,
            toolName: agentEvent.toolName,
            category: agentEvent.category,
            displayName: agentEvent.displayName,
            argsPreview: agentEvent.argsPreview,
            requiresApproval: agentEvent.requiresApproval,
          },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "tool", id: agentEvent.toolCallId, label: agentEvent.toolName },
          },
        )
        appendAndSend(socket, store, event, "tool")
      }

      if (agentEvent.type === "tool.call.output") {
        if (agentEvent.text) {
          store.appendShellOutput(agentEvent.toolCallId, agentEvent.stream, agentEvent.text)
        }
        const event = makeEvent(
          "tool.call.output",
          {
            toolCallId: agentEvent.toolCallId,
            stream: agentEvent.stream,
            text: agentEvent.text,
            data: agentEvent.data,
          },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "tool", id: agentEvent.toolCallId },
          },
        )
        appendAndSend(socket, store, event, "tool")
      }

      if (agentEvent.type === "tool.call.completed") {
        store.completeToolCall(agentEvent.toolCallId, agentEvent.output)
        if (isBashOutput(agentEvent.output)) {
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
            summary: agentEvent.summary,
            resultPreview: agentEvent.resultPreview,
            metrics: agentEvent.metrics,
            durationMs: agentEvent.durationMs,
          },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "tool", id: agentEvent.toolCallId, label: agentEvent.toolName },
          },
        )
        appendAndSend(socket, store, event, "tool")
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
            error: apiError(agentEvent.error.code, agentEvent.error.message, { details: agentEvent.error.details }),
          },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "tool", id: agentEvent.toolCallId, label: agentEvent.toolName },
          },
        )
        appendAndSend(socket, store, event, "tool")
      }

      if (agentEvent.type === "approval.resolved") {
        if (agentEvent.decision === "approved") {
          store.markToolRunningByApproval(agentEvent.approvalId)
        }
        const event = makeEvent(
          "approval.resolved",
          { approvalId: agentEvent.approvalId, toolCallId: agentEvent.toolCallId, decision: agentEvent.decision },
          {
            projectId,
            conversationId,
            sessionId: created.sessionId,
            turnId: created.turnId,
            actor: { type: "system" },
          },
        )
        appendAndSend(socket, store, event, "server")
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
        ...(latestUsageByModelCallId.get(modelCallId) ? { usage: toStoredUsage(latestUsageByModelCallId.get(modelCallId) as ModelUsage) } : {}),
      })
    }

    const messageCompleted = makeEvent(
      "message.completed",
      {
        message: assistantMessage,
        ...(latestUsage ? { usage: toContractUsage(latestUsage) } : {}),
      },
      {
        projectId,
        conversationId,
        sessionId: created.sessionId,
        turnId: created.turnId,
        actor: { type: "main_agent" },
      },
    )
    appendAndSend(socket, store, messageCompleted, "core")

    const turnCompleted = makeEvent(
      "turn.completed",
      {
        turnId: created.turnId,
        assistantMessageId: assistantMessage.id,
        summary: "Agent response completed.",
      },
      {
        projectId,
        conversationId,
        sessionId: created.sessionId,
        turnId: created.turnId,
        actor: { type: "main_agent" },
      },
    )
    appendAndSend(socket, store, turnCompleted, "core")
    store.indexTurnTraceDocuments(projectId, conversationId, created.turnId)

    const postTurnHistory = store.getConversationModelMessages(projectId, conversationId)
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
    appendAndSend(socket, store, failed, "core")
    store.indexTurnTraceDocuments(projectId, conversationId, created.turnId)
  } finally {
    activeTurns.delete(created.turnId)
  }
}

const createToolExecutors = (store: SocratesStore, projectId: string, activeTurns: ActiveTurns): ToolExecutors => ({
  read: (input, context) => readWorkspacePath(input, context),
  search: (input, context) => searchWorkspace(input, context),
  edit: (input, context) => editWorkspace(input, context),
  bash: async (input, context) => {
    const toolCallId = context.toolCallId ?? "unknown"
    store.createShellCommand({
      toolCallId,
      conversationId: context.conversationId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      command: input.command,
      cwd: input.cwd ?? context.workspacePath,
    })
    try {
      const output = await activeTurns.getShellSession(context.turnId, context.workspacePath).run(input, context)
      if (output.timedOut) {
        activeTurns.resetShellSession(context.turnId, context.workspacePath)
      }
      return output
    } catch (error) {
      store.failShellCommand(toolCallId)
      throw error
    }
  },
  trace_retrieve: (input, context) => Promise.resolve(store.retrieveToolTraces(projectId, context.conversationId, input)),
  list_project_resources: (input) => Promise.resolve(listProjectResourcesForTool(store, projectId, input)),
})

const sendContextCompactionEvent = (
  socket: WebSocket,
  store: SocratesStore,
  agentEvent: ContextCompactionLifecycleEvent,
  context: { projectId: string; conversationId: string; sessionId: string; turnId: string },
): void => {
  if (agentEvent.type === "context.compaction.started") {
    appendAndSend(
      socket,
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
    appendAndSend(
      socket,
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

  appendAndSend(
    socket,
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
  socket: WebSocket,
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
  appendAndSend(
    socket,
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

const ensureParagraphBoundary = (text: string): string => (text.endsWith("\n\n") ? "" : "\n\n")

const toContractUsage = (usage: ModelUsage) => ({
  ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
  ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
})

const toStoredUsage = (usage: ModelUsage) => ({
  ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
  ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
  ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
})

const isBashOutput = (output: unknown): output is { cwd: string; exitCode: number | null; signal?: string | null; durationMs: number } =>
  typeof output === "object" &&
  output !== null &&
  "command" in output &&
  "cwd" in output &&
  "stdout" in output &&
  "stderr" in output &&
  "durationMs" in output

const isEditOutput = (output: unknown): output is { changedFiles: Array<{ path: string; operation: string }>; diff: string } =>
  typeof output === "object" && output !== null && "changedFiles" in output && "diff" in output
