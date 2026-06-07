import { describe, expect, it } from "vitest"
import {
  apiResponseSchema,
  approvalDecideCommandSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  chatConversationSubscribeCommandSchema,
  chatConversationUnsubscribeCommandSchema,
  chatMessageSendCommandSchema,
  chatTurnCancelCommandSchema,
  checkProjectEmbeddingsRequestSchema,
  checkProjectEmbeddingsResponseSchema,
  checkProviderCredentialRequestSchema,
  checkProviderCredentialResponseSchema,
  clientCommandSchema,
  completeOnboardingRequestSchema,
  completeOnboardingResponseSchema,
  configureProjectEmbeddingsRequestSchema,
  configureProjectEmbeddingsResponseSchema,
  connectionReadyEventSchema,
  contextCompactionCompletedEventSchema,
  contextCompactionFailedEventSchema,
  contextCompactionStartedEventSchema,
  contextUsageSnapshotEventSchema,
  conversationSchema,
  conversationUpdatedEventSchema,
  createConversationRequestSchema,
  createConversationMessageRequestSchema,
  createConversationMessageResponseSchema,
  createConversationResponseSchema,
  createProjectRequestSchema,
  createProjectResponseSchema,
  createProjectResourceRequestSchema,
  createProjectResourceResponseSchema,
  deleteConversationResponseSchema,
  deleteProviderCredentialResponseSchema,
  deleteProjectResourceResponseSchema,
  errorCreatedEventSchema,
  feedbackSubmitCommandSchema,
  getConversationResponseSchema,
  getMeResponseSchema,
  getProjectEmbeddingsStatusResponseSchema,
  getProviderCredentialsStatusResponseSchema,
  getProjectResponseSchema,
  inspectWorkspaceRequestSchema,
  inspectWorkspaceResponseSchema,
  listNotificationsResponseSchema,
  listProjectConversationsResponseSchema,
  listProjectResourcesResponseSchema,
  listProjectsResponseSchema,
  markAllNotificationsReadResponseSchema,
  markNotificationReadResponseSchema,
  messageCompletedEventSchema,
  messageSchema,
  memoryAgentCompletedEventSchema,
  memoryAgentFailedEventSchema,
  memoryAgentStartedEventSchema,
  memoryDiaryAppendedEventSchema,
  memoryPrimaryUpdatedEventSchema,
  memorySoulConfirmationRequestedEventSchema,
  memorySoulConfirmationResolvedEventSchema,
  memorySoulUpdatedEventSchema,
  notificationCreatedEventSchema,
  notificationReadEventSchema,
  patchProjectRequestSchema,
  patchProjectResponseSchema,
  pickWorkspaceFolderRequestSchema,
  pickWorkspaceFolderResponseSchema,
  reindexProjectEmbeddingsResponseSchema,
  setProviderCredentialSessionRequestSchema,
  setProviderCredentialSessionResponseSchema,
  projectResourceSchema,
  projectSchema,
  projectWorkspaceSchema,
  serverEventSchema,
  toolCallCompletedEventSchema,
  toolCallFailedEventSchema,
  toolCallOutputEventSchema,
  toolCallStartedEventSchema,
  turnCompletedEventSchema,
  turnCancelledEventSchema,
  turnFailedEventSchema,
  turnStartedEventSchema,
  uploadProjectResourcesResponseSchema,
  updateConversationRequestSchema,
  updateConversationResponseSchema,
  updateProjectWorkspaceRequestSchema,
  updateProjectWorkspaceResponseSchema,
  upsertProjectInstructionsRequestSchema,
  upsertProjectInstructionsResponseSchema,
  userSchema,
  agentAnswerDeltaEventSchema,
  agentThinkingDeltaEventSchema,
  bashToolInputSchema,
  bashToolModelInputSchema,
  applyPatchToolInputSchema,
  applyPatchToolModelInputSchema,
  editToolInputSchema,
  editToolModelInputSchema,
  listProjectResourcesToolInputSchema,
  listProjectResourcesToolOutputSchema,
  mcpRegistryToolModelInputSchema,
  normalizedToolCallSchema,
  projectNotesToolInputSchema,
  projectNotesToolOutputSchema,
  repoDocsToolInputSchema,
  repoDocsToolOutputSchema,
  readToolInputSchema,
  readToolOutputSchema,
  searchToolInputSchema,
  soulToolInputSchema,
  soulToolOutputSchema,
  socratesMemoryToolInputSchema,
  socratesMemoryToolOutputSchema,
  toolExecutionResultSchema,
  traceRetrieveToolInputSchema,
  traceRetrieveToolModelInputSchema,
  traceRetrieveToolOutputSchema,
  conversationToolRunSchema,
  editToolOutputSchema,
} from "./index"

const timestamp = "2026-05-13T21:30:00.000Z"

const user = {
  id: "user_1",
  displayName: "Ayush",
  onboardingCompleted: true,
}

const project = {
  id: "proj_1",
  userId: "user_1",
  name: "Socrates",
  status: "active",
  updatedAt: timestamp,
}

const workspace = {
  id: "pws_1",
  projectId: "proj_1",
  kind: "existing_folder",
  path: "/tmp/socrates",
  isPrimary: true,
  status: "active",
}

const resource = {
  id: "pres_1",
  projectId: "proj_1",
  name: "README.md",
  kind: "document",
  source: "uploaded",
  uri: "/tmp/socrates/.socrates/resources/README.md",
  sizeBytes: 2048,
  mimeType: "text/markdown",
  status: "active",
}

const instructions = {
  id: "pins_1",
  projectId: "proj_1",
  content: "Be direct.",
  updatedAt: timestamp,
}

const conversation = {
  id: "conv_1",
  projectId: "proj_1",
  title: "Build contracts",
  status: "active",
  updatedAt: timestamp,
}

const embeddingStatus = {
  configured: true,
  ready: true,
  providerId: "ollama",
  modelId: "embeddinggemma",
  configId: "embcfg_1",
  dimensions: 768,
  credentialSource: "none",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  status: "ready",
  totalDocuments: 10,
  indexedDocuments: 8,
  pendingDocuments: 2,
  failedDocuments: 0,
  activeJob: {
    id: "tjob_1",
    status: "running",
    createdAt: timestamp,
    startedAt: timestamp,
  },
  updatedAt: timestamp,
}

const userMessage = {
  id: "msg_user_1",
  conversationId: "conv_1",
  sessionId: "sess_1",
  turnId: "turn_1",
  role: "user",
  content: "Start the sprint",
  status: "completed",
  createdAt: timestamp,
}

const assistantMessage = {
  id: "msg_assistant_1",
  conversationId: "conv_1",
  sessionId: "sess_1",
  turnId: "turn_1",
  role: "assistant",
  content: "Done.",
  reasoning: "Checked the project context.",
  status: "completed",
  createdAt: timestamp,
}

const cancelledPartialAssistantMessage = {
  ...assistantMessage,
  id: "msg_assistant_cancelled_1",
  content: "Partial answer.",
  reasoning: undefined,
  partial: true,
  cancelled: true,
  cancellationReason: "User clicked stop",
  status: "cancelled",
}

function envelope<TType extends string, TPayload>(type: TType, payload: TPayload) {
  return {
    id: `evt_${type}`,
    type,
    schemaVersion: 1,
    timestamp,
    projectId: "proj_1",
    conversationId: "conv_1",
    sessionId: "sess_1",
    turnId: "turn_1",
    actor: {
      type: "main_agent",
      id: "agent_main",
      label: "Socrates",
    },
    payload,
  }
}

describe("api contracts", () => {
  it("parses successful and failed API responses", () => {
    const schema = apiResponseSchema(getMeResponseSchema)

    expect(schema.safeParse({ ok: true, data: { user } }).success).toBe(true)
    expect(
      schema.safeParse({
        ok: false,
        error: {
          code: "not_found",
          message: "Not found",
        },
      }).success,
    ).toBe(true)
  })

  it("rejects malformed API errors", () => {
    const schema = apiResponseSchema(getMeResponseSchema)

    expect(schema.safeParse({ ok: false, error: { code: "", message: "" } }).success).toBe(false)
  })
})

describe("entity contracts", () => {
  it("parses core entities", () => {
    expect(userSchema.safeParse(user).success).toBe(true)
    expect(projectSchema.safeParse(project).success).toBe(true)
    expect(projectWorkspaceSchema.safeParse(workspace).success).toBe(true)
    expect(projectResourceSchema.safeParse(resource).success).toBe(true)
    expect(conversationSchema.safeParse(conversation).success).toBe(true)
    expect(messageSchema.safeParse(userMessage).success).toBe(true)
    expect(messageSchema.safeParse(cancelledPartialAssistantMessage).success).toBe(true)
  })

  it("rejects missing required fields and invalid enums", () => {
    expect(projectSchema.safeParse({ ...project, name: undefined }).success).toBe(false)
    expect(projectWorkspaceSchema.safeParse({ ...workspace, status: "unknown" }).success).toBe(false)
    expect(messageSchema.safeParse({ ...userMessage, role: "robot" }).success).toBe(false)
  })
})

describe("http contracts", () => {
  it("parses onboarding contracts", () => {
    expect(completeOnboardingRequestSchema.safeParse({ displayName: "Ayush" }).success).toBe(true)
    expect(completeOnboardingResponseSchema.safeParse({ user }).success).toBe(true)
  })

  it("parses provider credential contracts without exposing secret values", () => {
    const status = {
      providerId: "openrouter",
      providerLabel: "OpenRouter",
      required: true,
      configured: true,
      source: "local_file",
      message: "Required for chat and context compression.",
    }

    expect(
      getProviderCredentialsStatusResponseSchema.safeParse({
        providers: [status],
        openRouterRequired: true,
        openAiRequiredForHostedEmbeddings: true,
        googleOptional: true,
      }).success,
    ).toBe(true)
    expect(setProviderCredentialSessionRequestSchema.safeParse({ providerId: "openrouter", apiKey: "sk-test", source: "local_file" }).success).toBe(true)
    expect(setProviderCredentialSessionResponseSchema.safeParse({ status }).success).toBe(true)
    expect(checkProviderCredentialRequestSchema.safeParse({ providerId: "openrouter" }).success).toBe(true)
    expect(
      checkProviderCredentialResponseSchema.safeParse({
        providerId: "openrouter",
        ok: true,
        configured: true,
        source: "session",
        message: "OpenRouter credential is configured.",
      }).success,
    ).toBe(true)
    expect(deleteProviderCredentialResponseSchema.safeParse({ status: { ...status, configured: false, source: "missing" } }).success).toBe(true)
    expect(
      getProviderCredentialsStatusResponseSchema.safeParse({
        providers: [{ ...status, apiKey: "must-not-parse" }],
        openRouterRequired: true,
        openAiRequiredForHostedEmbeddings: true,
        googleOptional: true,
      }).success,
    ).toBe(false)
  })

  it("parses project list, creation, and dashboard contracts", () => {
    expect(
      listProjectsResponseSchema.safeParse({
        projects: [{ project, primaryWorkspace: workspace, conversationCount: 1, lastActivityAt: timestamp }],
      }).success,
    ).toBe(true)
    expect(
      listProjectsResponseSchema.safeParse({
        projects: [{ project, conversationCount: 1 }],
      }).success,
    ).toBe(false)

    expect(
      createProjectRequestSchema.safeParse({
        name: "Socrates",
        creationMode: "existing_folder",
        workspacePath: "/tmp/socrates",
        scaffoldAction: "use_existing",
      }).success,
    ).toBe(true)

    expect(createProjectResponseSchema.safeParse({ project, primaryWorkspace: workspace }).success).toBe(true)
    expect(createProjectResponseSchema.safeParse({ project }).success).toBe(false)
    expect(
      getProjectResponseSchema.safeParse({
        project,
        primaryWorkspace: workspace,
        resources: [resource],
        conversations: [conversation],
        instructions,
      }).success,
    ).toBe(true)
    expect(
      getProjectResponseSchema.safeParse({
        project,
        resources: [],
        conversations: [],
      }).success,
    ).toBe(false)
  })

  it("parses project patch and resource contracts", () => {
    expect(patchProjectRequestSchema.safeParse({ name: "Socrates v2", status: "active" }).success).toBe(true)
    expect(patchProjectResponseSchema.safeParse({ project }).success).toBe(true)
    expect(listProjectResourcesResponseSchema.safeParse({ resources: [resource] }).success).toBe(true)
    expect(
      createProjectResourceRequestSchema.safeParse({
        name: "Docs",
        kind: "document",
        source: "uploaded",
        uri: "/tmp/docs.md",
      }).success,
    ).toBe(true)
    expect(createProjectResourceResponseSchema.safeParse({ resource }).success).toBe(true)
    expect(uploadProjectResourcesResponseSchema.safeParse({ resources: [resource] }).success).toBe(true)
    expect(deleteProjectResourceResponseSchema.safeParse({ deletedResourceId: resource.id }).success).toBe(true)
    expect(projectResourceSchema.safeParse(resource).success).toBe(true)
    expect(pickWorkspaceFolderRequestSchema.safeParse({ mode: "start_from_scratch" }).success).toBe(true)
    expect(
      pickWorkspaceFolderResponseSchema.safeParse({ path: "/tmp/socrates", folderName: "socrates" }).success,
    ).toBe(true)
    expect(inspectWorkspaceRequestSchema.safeParse({ workspacePath: "/tmp/socrates" }).success).toBe(true)
    expect(
      inspectWorkspaceResponseSchema.safeParse({
        workspacePath: "/tmp/socrates",
        folderName: "socrates",
        exists: true,
        isDirectory: true,
        hasSocratesDir: true,
        hasResourcesDir: false,
      }).success,
    ).toBe(true)
    expect(
      updateProjectWorkspaceRequestSchema.safeParse({
        workspacePath: "/tmp/socrates-v2",
        creationMode: "existing_folder",
        scaffoldAction: "reset",
      }).success,
    ).toBe(true)
    expect(updateProjectWorkspaceResponseSchema.safeParse({ primaryWorkspace: workspace, resources: [resource] }).success).toBe(true)
    expect(
      getProjectResponseSchema.safeParse({
        project,
        primaryWorkspace: workspace,
        resources: [resource],
        conversations: [conversation],
        instructions,
        embeddingStatus,
      }).success,
    ).toBe(true)
  })

  it("parses project embedding HTTP contracts", () => {
    expect(checkProjectEmbeddingsRequestSchema.safeParse({ providerId: "openai", modelId: "text-embedding-3-small" }).success).toBe(true)
    expect(
      checkProjectEmbeddingsRequestSchema.safeParse({
        providerId: "ollama",
        credentialSource: "none",
        ollamaBaseUrl: "http://127.0.0.1:11434",
      }).success,
    ).toBe(true)
    expect(checkProjectEmbeddingsRequestSchema.safeParse({ providerId: "huggingface" }).success).toBe(false)
    expect(
      checkProjectEmbeddingsResponseSchema.safeParse({
        providerId: "openai",
        modelId: "text-embedding-3-small",
        ok: true,
        dimensions: 1536,
        serverEnvAvailable: false,
        workspaceEnvCandidates: [{ fileName: ".env.local", hasOpenAiApiKey: true }],
        message: "Checked.",
      }).success,
    ).toBe(true)
    expect(
      configureProjectEmbeddingsRequestSchema.safeParse({
        providerId: "openai",
        modelId: "text-embedding-3-small",
        credentialSource: "workspace_env",
        workspaceEnvFile: ".env.local",
      }).success,
    ).toBe(true)
    expect(configureProjectEmbeddingsResponseSchema.safeParse({ status: embeddingStatus }).success).toBe(true)
    expect(getProjectEmbeddingsStatusResponseSchema.safeParse({ status: embeddingStatus }).success).toBe(true)
    expect(reindexProjectEmbeddingsResponseSchema.safeParse({ status: embeddingStatus }).success).toBe(true)
  })

  it("parses project instructions contracts", () => {
    expect(upsertProjectInstructionsRequestSchema.safeParse({ content: "Use the repo docs first." }).success).toBe(true)
    expect(upsertProjectInstructionsRequestSchema.safeParse({ content: "" }).success).toBe(false)
    expect(upsertProjectInstructionsResponseSchema.safeParse({ instructions }).success).toBe(true)
  })

  it("parses conversation creation contracts", () => {
    expect(listProjectConversationsResponseSchema.safeParse({ conversations: [conversation] }).success).toBe(true)
    expect(createConversationRequestSchema.safeParse({ title: "Build contracts" }).success).toBe(true)
    expect(createConversationRequestSchema.safeParse({}).success).toBe(true)
    expect(createConversationResponseSchema.safeParse({ conversation }).success).toBe(true)
    expect(
      getConversationResponseSchema.safeParse({
        conversation,
        messages: [userMessage, assistantMessage],
        toolRuns: [],
        partialTurns: [
          {
            turnId: "turn_interrupted",
            status: "running",
            answer: "Partial answer recovered from stream chunks.",
            reasoning: "Recovered reasoning.",
          },
        ],
        tokenUsage: {
          totalTokens: 12,
          inputTokens: 6,
          outputTokens: 4,
          reasoningTokens: 2,
        },
        costUsage: {
          totalCostUsd: 0.0012,
          totalTokens: 12,
          cachedInputTokens: 2,
          cacheWriteTokens: 1,
          turnCount: 1,
          costSource: "provider_reported",
          hasComputedCost: false,
          hasUnknownCost: false,
        },
        turnUsageReports: [
          {
            turnId: "turn_1",
            totalCostUsd: 0.0012,
            totalTokens: 12,
            inputTokens: 6,
            outputTokens: 4,
            reasoningTokens: 2,
            cachedInputTokens: 2,
            cacheWriteTokens: 1,
            uncachedInputTokens: 4,
            costSource: "provider_reported",
            providerBreakdown: [],
            modelBreakdown: [],
            callBreakdown: [],
            compactionBreakdown: [],
            qualityFlags: [],
          },
        ],
        contextUsage: {
          providerId: "openrouter",
          modelId: "deepseek/deepseek-v4-pro",
          contextWindowTokens: 180000,
          contextUsedTokens: 42000,
          contextLeftTokens: 138000,
          contextUsedPercent: 23.3,
        },
      }).success,
    ).toBe(true)
    expect(
      conversationToolRunSchema.safeParse({
        toolCallId: "tcall_1",
        conversationId: conversation.id,
        sessionId: "sess_1",
        turnId: "turn_1",
        toolName: "bash",
        status: "cancelled",
        requiresApproval: true,
        arguments: { command: "pwd" },
        summary: "Command exited with code 0.",
        durationMs: 12,
        approval: {
          approvalId: "appr_1",
          status: "approved",
          actionKind: "shell_command",
          title: "Approve shell command",
          actionPreview: "pwd",
          risk: "low",
          decision: "approved",
        },
        shell: {
          command: "pwd",
          cwd: "/tmp/socrates",
          status: "completed",
          operation: "run",
          platform: "darwin",
          shellKind: "posix",
          shellExecutable: "/bin/zsh",
          exitCode: 0,
          durationMs: 12,
          stdout: "/tmp/socrates\n",
          stderr: "",
        },
      }).success,
    ).toBe(true)
    expect(updateConversationRequestSchema.safeParse({ title: "Renamed chat" }).success).toBe(true)
    expect(updateConversationRequestSchema.safeParse({ title: "" }).success).toBe(false)
    expect(updateConversationResponseSchema.safeParse({ conversation }).success).toBe(true)
    expect(deleteConversationResponseSchema.safeParse({ deletedConversationId: conversation.id }).success).toBe(true)
    const notification = {
      id: "note_1",
      projectId: project.id,
      type: "memory.soul.updated",
      title: "Socrates soul updated",
      body: "identity was updated",
      severity: "info",
      payload: { diff: "--- old\n+++ new" },
      createdAt: timestamp,
    }
    expect(listNotificationsResponseSchema.safeParse({ notifications: [notification], unreadCount: 1 }).success).toBe(true)
    expect(markNotificationReadResponseSchema.safeParse({ notification: { ...notification, readAt: timestamp }, unreadCount: 0 }).success).toBe(true)
    expect(markAllNotificationsReadResponseSchema.safeParse({ notifications: [{ ...notification, readAt: timestamp }], unreadCount: 0 }).success).toBe(true)
    expect(createConversationMessageRequestSchema.safeParse({ content: "Hello" }).success).toBe(true)
    expect(createConversationMessageRequestSchema.safeParse({ content: "" }).success).toBe(false)
    expect(createConversationMessageResponseSchema.safeParse({ conversation, message: userMessage }).success).toBe(true)
  })

  it("rejects invalid HTTP payloads", () => {
    expect(completeOnboardingRequestSchema.safeParse({ displayName: "" }).success).toBe(false)
    expect(createProjectRequestSchema.safeParse({ name: "Socrates", creationMode: "clone" }).success).toBe(false)
    expect(createProjectRequestSchema.safeParse({ name: "Socrates", creationMode: "existing_folder" }).success).toBe(
      false,
    )
  })
})

describe("websocket client command contracts", () => {
  const runtimeConfig = {
    providerId: "openai",
    modelId: "gpt-5.4",
    thinkingEnabled: true,
    thinkingEffort: "medium",
    approvalMode: "manual",
    sandboxMode: "workspace_write",
  }

  const commands = [
    chatMessageSendCommandSchema.safeParse(
      envelope("chat.message.send", {
        clientMessageId: "client_msg_1",
        content: "Hello",
        runtimeConfig,
      }),
    ),
    chatTurnCancelCommandSchema.safeParse(envelope("chat.turn.cancel", { turnId: "turn_1", reason: "User stopped" })),
    chatConversationSubscribeCommandSchema.safeParse(
      envelope("chat.conversation.subscribe", { replayActiveTurn: true }),
    ),
    chatConversationUnsubscribeCommandSchema.safeParse(envelope("chat.conversation.unsubscribe", {})),
    approvalDecideCommandSchema.safeParse(
      envelope("approval.decide", { approvalId: "appr_1", decision: "approved" }),
    ),
    feedbackSubmitCommandSchema.safeParse(
      envelope("feedback.submit", {
        messageId: "msg_assistant_1",
        turnId: "turn_1",
        rating: "thumbs_up",
      }),
    ),
    clientCommandSchema.safeParse(envelope("terminal.stop", { terminalId: "term_1", reason: "Done" })),
    clientCommandSchema.safeParse(envelope("terminal.input", { terminalId: "term_1", data: "\u0003" })),
    clientCommandSchema.safeParse(envelope("terminal.input", { terminalId: "term_1", text: "yes", submit: true })),
    clientCommandSchema.safeParse(envelope("terminal.input", { terminalId: "term_1", key: "ArrowDown" })),
    clientCommandSchema.safeParse(envelope("terminal.resize", { terminalId: "term_1", cols: 120, rows: 32 })),
    clientCommandSchema.safeParse(envelope("terminal.rename", { terminalId: "term_1", name: "frontend" })),
  ]

  it("parses every V1 client command", () => {
    expect(commands.every((result) => result.success)).toBe(true)
  })

  it("rejects unknown command types and malformed payloads", () => {
    expect(clientCommandSchema.safeParse(envelope("chat.unknown", {})).success).toBe(false)
    expect(clientCommandSchema.safeParse(envelope("terminal.input", { terminalId: "term_1" })).success).toBe(false)
    expect(
      clientCommandSchema.safeParse(
        envelope("chat.message.send", {
          clientMessageId: "client_msg_1",
          content: "",
          runtimeConfig,
        }),
      ).success,
    ).toBe(false)
  })
})

describe("websocket server event contracts", () => {
  const serverEvents = [
    connectionReadyEventSchema.safeParse(
      envelope("connection.ready", {
        connectionId: "conn_1",
        serverTime: timestamp,
      }),
    ),
    turnStartedEventSchema.safeParse(envelope("turn.started", { turnId: "turn_1", userMessage })),
    conversationUpdatedEventSchema.safeParse(envelope("conversation.updated", { conversation })),
    agentThinkingDeltaEventSchema.safeParse(envelope("agent.thinking.delta", { text: "Considering files." })),
    agentAnswerDeltaEventSchema.safeParse(envelope("agent.answer.delta", { messageId: "msg_assistant_1", text: "Hi" })),
    toolCallStartedEventSchema.safeParse(
      envelope("tool.call.started", {
        toolCallId: "tcall_1",
        toolName: "read",
        category: "file",
        displayName: "Reading README.md",
        requiresApproval: false,
      }),
    ),
    toolCallOutputEventSchema.safeParse(
      envelope("tool.call.output", {
        toolCallId: "tcall_1",
        stream: "stdout",
        text: "ok",
      }),
    ),
    toolCallCompletedEventSchema.safeParse(
      envelope("tool.call.completed", {
        toolCallId: "tcall_1",
        summary: "Explored 1 file",
        metrics: {
          filesRead: 1,
        },
      }),
    ),
    toolCallFailedEventSchema.safeParse(
      envelope("tool.call.failed", {
        toolCallId: "tcall_1",
        error: {
          code: "tool_failed",
          message: "Tool failed",
        },
      }),
    ),
    approvalRequestedEventSchema.safeParse(
      envelope("approval.requested", {
        approvalId: "appr_1",
        toolCallId: "tcall_1",
        actionKind: "shell_command",
        title: "Run command",
        actionPreview: "pnpm test",
        risk: "medium",
      }),
    ),
    approvalResolvedEventSchema.safeParse(
      envelope("approval.resolved", {
        approvalId: "appr_1",
        decision: "approved",
      }),
    ),
    contextUsageSnapshotEventSchema.safeParse(
      envelope("context.usage.snapshot", {
        providerId: "openai",
        modelId: "gpt-5.4",
        contextWindowTokens: 258000,
        contextUsedTokens: 55000,
        contextLeftTokens: 203000,
        contextUsedPercent: 21.3,
      }),
    ),
    contextCompactionStartedEventSchema.safeParse(
      envelope("context.compaction.started", {
        snapshotId: "ctxcmp_1",
        reason: "threshold",
        contextUsedTokensEstimate: 161000,
        targetTokens: 120000,
      }),
    ),
    contextCompactionCompletedEventSchema.safeParse(
      envelope("context.compaction.completed", {
        snapshotId: "ctxcmp_1",
        inputTokensEstimate: 161000,
        outputTokensEstimate: 1800,
        contextUsedTokensEstimate: 116000,
      }),
    ),
    contextCompactionFailedEventSchema.safeParse(
      envelope("context.compaction.failed", {
        snapshotId: "ctxcmp_1",
        error: {
          code: "context_compaction_failed",
          message: "Compressor failed",
        },
      }),
    ),
    memoryAgentStartedEventSchema.safeParse(
      envelope("memory.agent.started", {
        jobId: "memjob_1",
        projectId: project.id,
        trigger: "idle",
        evidenceTokensEstimate: 1200,
      }),
    ),
    memoryAgentCompletedEventSchema.safeParse(
      envelope("memory.agent.completed", {
        jobId: "memjob_1",
        status: "completed",
        modelId: "deepseek/deepseek-v4-pro",
        diaryAppended: true,
        actionsApplied: 1,
        actionsRejected: 0,
      }),
    ),
    memoryAgentFailedEventSchema.safeParse(
      envelope("memory.agent.failed", {
        jobId: "memjob_1",
        error: {
          code: "memory_agent_failed",
          message: "failed",
        },
      }),
    ),
    memoryDiaryAppendedEventSchema.safeParse(envelope("memory.diary.appended", { jobId: "memjob_1", path: "/tmp/diary.md" })),
    memoryPrimaryUpdatedEventSchema.safeParse(
      envelope("memory.primary.updated", {
        jobId: "memjob_1",
        actionId: "memact_1",
        path: "/tmp/learned_patterns.md",
        targetKind: "learned_patterns",
      }),
    ),
    memorySoulConfirmationRequestedEventSchema.safeParse(
      envelope("memory.soul.confirmation.requested", {
        jobId: "memjob_1",
        actionId: "memact_1",
        confirmationId: "memconf_1",
        document: "identity",
        prompt: "You are about to make changes to the soul. Are you sure?",
      }),
    ),
    memorySoulConfirmationResolvedEventSchema.safeParse(
      envelope("memory.soul.confirmation.resolved", {
        jobId: "memjob_1",
        actionId: "memact_1",
        confirmationId: "memconf_1",
        document: "identity",
        decision: "yes",
      }),
    ),
    memorySoulUpdatedEventSchema.safeParse(
      envelope("memory.soul.updated", {
        jobId: "memjob_1",
        actionId: "memact_1",
        confirmationId: "memconf_1",
        document: "identity",
        path: "/tmp/identity.md",
        notificationId: "note_1",
      }),
    ),
    notificationCreatedEventSchema.safeParse(
      envelope("notification.created", {
        notification: {
          id: "note_1",
          projectId: project.id,
          type: "memory.soul.updated",
          title: "Socrates soul updated",
          severity: "info",
          createdAt: timestamp,
        },
      }),
    ),
    notificationReadEventSchema.safeParse(envelope("notification.read", { notificationId: "note_1", unreadCount: 0 })),
    messageCompletedEventSchema.safeParse(
      envelope("message.completed", {
        message: assistantMessage,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 10,
          totalTokens: 130,
        },
      }),
    ),
    turnCompletedEventSchema.safeParse(
      envelope("turn.completed", {
        turnId: "turn_1",
        assistantMessageId: "msg_assistant_1",
        summary: "Answered the user",
      }),
    ),
    turnFailedEventSchema.safeParse(
      envelope("turn.failed", {
        turnId: "turn_1",
        error: {
          code: "turn_failed",
          message: "Turn failed",
        },
      }),
    ),
    turnCancelledEventSchema.safeParse(
      envelope("turn.cancelled", {
        turnId: "turn_1",
        reason: "User stopped the run",
      }),
    ),
    serverEventSchema.safeParse(
      envelope("terminal.started", {
        terminalId: "term_1",
        name: "frontend",
        command: "pnpm dev",
        cwd: "/tmp/socrates",
        workspacePath: "/tmp/socrates",
        status: "running",
        platform: "darwin",
        shellKind: "posix",
        shellExecutable: "/bin/zsh",
        processId: "proc_1",
        autoDetached: false,
        awaitingInput: false,
        nextOutputSequence: 0,
        startedAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
    serverEventSchema.safeParse(
      envelope("terminal.data", {
        terminalId: "term_1",
        name: "frontend",
        command: "pnpm dev",
        cwd: "/tmp/socrates",
        workspacePath: "/tmp/socrates",
        status: "running",
        stream: "pty",
        text: "ready\n",
        sequence: 0,
        autoDetached: false,
        awaitingInput: false,
        nextOutputSequence: 1,
        startedAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
    serverEventSchema.safeParse(
      envelope("terminal.input.requested", {
        terminalId: "term_1",
        name: "scaffold",
        command: "npx create-example",
        cwd: "/tmp/socrates",
        workspacePath: "/tmp/socrates",
        status: "awaiting_input",
        prompt: "Continue?",
        secret: false,
        autoDetached: false,
        awaitingInput: true,
        lastPrompt: "Continue?",
        nextOutputSequence: 2,
        startedAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
    errorCreatedEventSchema.safeParse(
      envelope("error.created", {
        error: {
          code: "provider_error",
          message: "Provider failed",
        },
        recoverable: true,
      }),
    ),
  ]

  it("parses every V1 server event", () => {
    expect(serverEvents.every((result) => result.success)).toBe(true)
  })

  it("rejects unknown event types and malformed payloads", () => {
    expect(serverEventSchema.safeParse(envelope("planner.future", {})).success).toBe(false)
    expect(serverEventSchema.safeParse(envelope("tool.call.started", { toolCallId: "tcall_1" })).success).toBe(false)
  })
})

describe("tool contracts", () => {
  it("parses the V1 model-visible tool inputs", () => {
    expect(readToolInputSchema.safeParse({ path: "README.md", charLimit: 20_000, tokenLimit: 6_000 }).success).toBe(true)
    expect(readToolInputSchema.safeParse({ path: "README.md", tokenLimit: 6_001 }).success).toBe(false)
    expect(searchToolInputSchema.safeParse({ mode: "text", query: "Socrates", path: "src" }).success).toBe(true)
    expect(searchToolInputSchema.safeParse({ mode: "text", query: "Socrates", maxResults: 50 }).success).toBe(true)
    expect(searchToolInputSchema.safeParse({ mode: "text", query: "Socrates", maxResults: 51 }).success).toBe(false)
    expect(soulToolInputSchema.safeParse({ operation: "read", document: "both", charLimit: 20_000 }).success).toBe(true)
    expect(soulToolInputSchema.safeParse({ operation: "patch", document: "identity" }).success).toBe(false)
    expect(
      soulToolOutputSchema.safeParse({
        operation: "read",
        documents: [
          {
            document: "identity",
            path: "primary/identity.md",
            content: "# Identity",
            truncation: { truncated: false, charLimit: 20_000, returnedLength: 10 },
          },
        ],
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 100 },
      }).success,
    ).toBe(true)
    expect(editToolInputSchema.safeParse({ path: "README.md", oldString: "old", newString: "new" }).success).toBe(true)
    expect(editToolInputSchema.safeParse({ path: "README.md", content: "new" }).success).toBe(true)
    expect(editToolInputSchema.safeParse({ path: "README.md", content: "new", overwrite: true }).success).toBe(true)
    expect(editToolInputSchema.safeParse({ path: "README.md", oldString: "old", newString: "new", overwrite: true }).success).toBe(false)
    expect(editToolInputSchema.safeParse({ path: "README.md", oldString: "old", newString: "new", replaceAll: true }).success).toBe(true)
    expect(editToolInputSchema.safeParse({ path: "README.md" }).success).toBe(false)
    expect(editToolModelInputSchema.safeParse({ path: "README.md", oldString: "old", newString: "new" }).success).toBe(true)
    expect(editToolModelInputSchema.safeParse({ path: "README.md", content: "new" }).success).toBe(true)
    expect(editToolModelInputSchema.safeParse({ path: "README.md", content: "new", overwrite: true }).success).toBe(true)
    expect(editToolModelInputSchema.safeParse({ path: "README.md", oldString: "old", newString: "new", overwrite: true }).success).toBe(false)
    expect(editToolModelInputSchema.safeParse({ path: "README.md", content: "new", oldString: "old", newString: "new" }).success).toBe(false)
    expect(applyPatchToolInputSchema.safeParse({ patch: "--- a/README.md\n+++ b/README.md\n" }).success).toBe(true)
    expect(applyPatchToolInputSchema.safeParse({ patchText: "*** Begin Patch\n*** End Patch" }).success).toBe(true)
    expect(applyPatchToolInputSchema.safeParse({ patch: "one", patchText: "two" }).success).toBe(false)
    expect(applyPatchToolModelInputSchema.safeParse({ patchText: "*** Begin Patch\n*** End Patch" }).success).toBe(true)
    expect(applyPatchToolModelInputSchema.safeParse({ patch: "--- a/README.md\n+++ b/README.md\n" }).success).toBe(false)
    expect(
      readToolOutputSchema.safeParse({
        path: "README.md",
        kind: "file",
        content: "hello",
        sizeBytes: 5,
        mtimeMs: 10,
        contentHash: "hash_after",
        lineEnding: "lf",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 5 },
      }).success,
    ).toBe(true)
    expect(
      editToolOutputSchema.safeParse({
        changedFiles: [
          {
            path: "README.md",
            operation: "edited",
            verification: "verified",
            contentHashBefore: "hash_before",
            contentHashAfter: "hash_after",
            sizeBytesBefore: 3,
            sizeBytesAfter: 5,
            lineDelta: 1,
          },
          {
            path: "renamed.md",
            previousPath: "old.md",
            operation: "renamed",
            verification: "verified",
          },
          {
            path: "deleted.md",
            operation: "deleted",
            verification: "verified",
          },
        ],
        diff: "--- a/README.md\n+++ b/README.md\n",
        dryRun: false,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
      }).success,
    ).toBe(true)
    expect(bashToolInputSchema.safeParse({ command: "pnpm test", timeoutMs: 120_000 }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "start", command: "pnpm dev" }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "output", processId: "proc_1", outputSequence: 0 }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "status", terminalId: "term_1" }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "output" }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "stop" }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "status", name: "dev-server" }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "output", target: "frontend" }).success).toBe(true)
    expect(bashToolModelInputSchema.safeParse({ operation: "stop" }).success).toBe(true)
    expect(bashToolModelInputSchema.safeParse({ operation: "stop", name: "dev-server" }).success).toBe(true)
    expect(bashToolModelInputSchema.safeParse({ operation: "stop", terminalId: "term_1" }).success).toBe(false)
    expect(bashToolModelInputSchema.safeParse({ operation: "output", processId: "proc_1" }).success).toBe(false)
    expect(bashToolModelInputSchema.safeParse({ operation: "output", outputSequence: 0 }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", toolNames: ["read"], turnNo: 2, role: "user" }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ turnNo: 2, role: "user", scope: "project" }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ scope: "recent_conversations", conversationLimit: 3, perConversationLimit: 5 }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ mode: "semantic", scope: "project" }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ mode: "combined", conversationLimit: 3 }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", role: "user" }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", entryType: "assistant_response", hasAttachment: false }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ operation: "inspect", resultNumber: 1 }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ operation: "inspect", query: "README", role: "assistant" }).success).toBe(true)
    expect(
      traceRetrieveToolInputSchema.safeParse({ operation: "inspect", handle: "tdoc_1", startTurnNo: 2, turnLimit: 5 }).success,
    ).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", resultNumber: 1 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", query: "README", role: "assistant" }).success).toBe(true)
    expect(
      traceRetrieveToolModelInputSchema.safeParse({ query: "previous screenshots", command: "", paths: [], include: [], createdAfter: "" }).success,
    ).toBe(true)
    expect(
      traceRetrieveToolModelInputSchema.safeParse({ query: "previous screenshots", messageId: "msg_1", conversationId: "conv_1", mode: "exact" })
        .success,
    ).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ messageId: "msg_1" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ mode: "audit", toolId: "tcall_1" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ toolId: "tcall_1" }).success).toBe(false)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "exact", conversationTitle: "apply patch fix", conversationLimit: 10 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "exact", conversationId: "conv_1" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ mode: "exact", conversationLimit: 3, conversationOffset: 1, perConversationLimit: 5, updatedAfter: timestamp, updatedBefore: timestamp }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "exact", turnNo: 2 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ turnNo: 2, role: "assistant", conversationTitle: "apply patch fix" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "exact", role: "assistant", entryType: "assistant_response", hasAttachment: true, createdAfter: timestamp, createdBefore: timestamp }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "semantic" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "semantic", scope: "project", conversationTitle: "Trace source", conversationId: "conv_1", role: "user", entryType: "user_query", hasAttachment: false, createdAfter: timestamp, createdBefore: timestamp, limit: 10 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "semantic", conversationLimit: 50 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "semantic", turnNo: 2 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "semantic", charLimit: 1000 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "combined" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "combined", scope: "project", limit: 10 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "combined", conversationLimit: 50 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "exact", include: ["messages"] }).success).toBe(false)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "combined", paths: ["README.md"] }).success).toBe(false)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "semantic", command: "npm test" }).success).toBe(false)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "audit", include: ["tool_calls"] }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "audit", paths: ["README.md"], command: "npm test" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", handle: "tdoc_1" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", messageId: "msg_1" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", messageId: "msg_1", command: "npm test" }).success).toBe(false)
    expect(
      traceRetrieveToolModelInputSchema.safeParse({
        operation: "inspect",
        messageId: "msg_1",
        scope: "project",
        mode: "exact",
        conversationLimit: 10,
      }).success,
    ).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", conversationId: "conv_1", startTurnNo: 2 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", startTurnNo: 2 }).success).toBe(false)
    expect(mcpRegistryToolModelInputSchema.safeParse({ operation: "check", serverName: "playwright" }).success).toBe(true)
    expect(mcpRegistryToolModelInputSchema.safeParse({ operation: "check", serverId: "srv_1" }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", turnNo: 0 }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", role: "system" }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ turnId: "turn_1" }).success).toBe(false)
    expect(
      traceRetrieveToolOutputSchema.safeParse({
        results: [
          {
            resultNumber: 1,
            text: "README context",
            entryType: "user_query",
            conversationTitle: "Trace source",
            conversationId: conversation.id,
            messageId: "msg_1",
            messageNo: 2,
            provenanceKind: "original_turn",
            pairedUserMessageNo: 2,
            pairedUserPreview: "Question",
          },
          {
            resultNumber: 2,
            entryType: "qa_pair",
            conversationTitle: "Trace source",
            conversationId: conversation.id,
            turnNo: 2,
            turnId: "turn_1",
            userMessageId: "msg_user_1",
            assistantMessageId: "msg_assistant_1",
            userText: "Question",
            assistantText: "Answer",
            startedAt: timestamp,
          },
          {
            resultNumber: 3,
            entryType: "user_query",
            content: "Exact source",
            conversationTitle: "Trace source",
            conversationId: conversation.id,
            messageId: "msg_1",
            messageNo: 2,
            provenanceKind: "original_turn",
          },
        ],
        totalMatches: 3,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 200 },
        appliedFilters: { operation: "search", scope: "current_conversation", mode: "combined", turnNo: 2, role: "user" },
        warnings: ["Semantic trace retrieval is not configured for this project. Use the project dashboard to enable semantic search."],
      }).success,
    ).toBe(true)
    expect(socratesMemoryToolInputSchema.safeParse({ operation: "search", scope: "project", category: "diary", memoryLimit: 10 }).success).toBe(true)
    expect(socratesMemoryToolInputSchema.safeParse({ operation: "read", path: "diary/2026/06/2026-06-01.md", charLimit: 1000 }).success).toBe(true)
    expect(
      socratesMemoryToolInputSchema.safeParse({ operation: "search", scope: "primary", category: "tool_usage", query: "trace", searchMode: "keyword_all", modifiedAfter: timestamp }).success,
    ).toBe(true)
    expect(socratesMemoryToolInputSchema.safeParse({ operation: "search", searchMode: "regex" }).success).toBe(false)
    expect(
      socratesMemoryToolOutputSchema.safeParse({
        operation: "search",
        scope: "project",
        category: "project_memory",
        results: [
          {
            resultNumber: 1,
            resultType: "line_match",
            path: "project/MEMORY.md",
            matchedText: "trace",
            modifiedAt: timestamp,
            lineStart: 1,
            lineEnd: 1,
            inspectArgs: { operation: "read", path: "project/MEMORY.md", category: "project_memory" },
          },
        ],
        totalMatches: 1,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 100 },
      }).success,
    ).toBe(true)
    expect(projectNotesToolInputSchema.safeParse({ operation: "read" }).success).toBe(true)
    expect(projectNotesToolInputSchema.safeParse({ operation: "search", query: "decision" }).success).toBe(true)
    expect(projectNotesToolInputSchema.safeParse({ operation: "patch", oldText: "old", newText: "new" }).success).toBe(true)
    expect(projectNotesToolInputSchema.safeParse({ operation: "patch", oldText: "old" }).success).toBe(false)
    expect(repoDocsToolInputSchema.safeParse({ operation: "read" }).success).toBe(true)
    expect(repoDocsToolInputSchema.safeParse({ operation: "read", path: "REPO_RULES.md" }).success).toBe(true)
    expect(repoDocsToolInputSchema.safeParse({ operation: "search", query: "contract", path: "FRONTEND_BACKEND_CONTRACT.md" }).success).toBe(true)
    expect(repoDocsToolInputSchema.safeParse({ operation: "patch", path: "APP_FLOW.md", oldText: "old", newText: "new" }).success).toBe(true)
    expect(repoDocsToolInputSchema.safeParse({ operation: "patch", oldText: "old", newText: "new" }).success).toBe(false)
    expect(repoDocsToolInputSchema.safeParse({ operation: "read", path: "../README.md" }).success).toBe(false)
    expect(
      repoDocsToolOutputSchema.safeParse({
        operation: "search",
        paths: [".socrates/repo_docs/REPO_RULES.md"],
        matches: [{ path: ".socrates/repo_docs/REPO_RULES.md", line: 1, text: "# Repo Rules" }],
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 30 },
      }).success,
    ).toBe(true)
    expect(
      projectNotesToolOutputSchema.safeParse({
        operation: "patch",
        path: "/tmp/workspace/.socrates/PROJECT_NOTES.md",
        changed: true,
        content: "# PROJECT_NOTES",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 15 },
      }).success,
    ).toBe(true)
    expect(listProjectResourcesToolInputSchema.safeParse({ kind: "pdf", limit: 10 }).success).toBe(true)
    expect(listProjectResourcesToolInputSchema.safeParse({ source: "uploaded" }).success).toBe(false)
    expect(
      listProjectResourcesToolOutputSchema.safeParse({
        resources: [
          {
            id: resource.id,
            name: resource.name,
            kind: resource.kind,
            source: resource.source,
            uri: resource.uri,
            mimeType: resource.mimeType,
            sizeBytes: resource.sizeBytes,
            status: resource.status,
          },
        ],
        summary: "Listed 1 project resources.",
        totalResources: 1,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 100 },
      }).success,
    ).toBe(true)
  })

  it("rejects tools outside the V1 surface", () => {
    expect(normalizedToolCallSchema.safeParse({ toolCallId: "tcall_1", toolName: "glob", input: {} }).success).toBe(false)
    expect(
      normalizedToolCallSchema.safeParse({
        toolCallId: "tcall_1",
        toolName: "read",
        input: { path: "README.md" },
        providerMetadata: { google: { thoughtSignature: "sig_1" } },
      }).success,
    ).toBe(true)
    expect(
      toolExecutionResultSchema.safeParse({
        toolCallId: "tcall_1",
        toolName: "read",
        ok: false,
        error: { code: "tool_failed", message: "Tool failed" },
      }).success,
    ).toBe(true)
  })
})
