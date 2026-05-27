import { describe, expect, it } from "vitest"
import {
  apiResponseSchema,
  approvalDecideCommandSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
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
  listProjectConversationsResponseSchema,
  listProjectResourcesResponseSchema,
  listProjectsResponseSchema,
  messageCompletedEventSchema,
  messageSchema,
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
  editToolInputSchema,
  listProjectResourcesToolInputSchema,
  listProjectResourcesToolOutputSchema,
  normalizedToolCallSchema,
  readToolInputSchema,
  searchToolInputSchema,
  toolExecutionResultSchema,
  traceRetrieveToolInputSchema,
  traceRetrieveToolOutputSchema,
  conversationToolRunSchema,
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
  ]

  it("parses every V1 client command", () => {
    expect(commands.every((result) => result.success)).toBe(true)
  })

  it("rejects unknown command types and malformed payloads", () => {
    expect(clientCommandSchema.safeParse(envelope("chat.unknown", {})).success).toBe(false)
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
  it("parses the six V1 model-visible tool inputs", () => {
    expect(readToolInputSchema.safeParse({ path: "README.md", charLimit: 20_000 }).success).toBe(true)
    expect(searchToolInputSchema.safeParse({ mode: "text", query: "Socrates", path: "src" }).success).toBe(true)
    expect(
      editToolInputSchema.safeParse({
        operations: [{ type: "replace", path: "README.md", oldText: "old", newText: "new" }],
      }).success,
    ).toBe(true)
    expect(bashToolInputSchema.safeParse({ command: "pnpm test", timeoutMs: 120_000 }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "start", command: "pnpm dev" }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "output", processId: "proc_1", outputSequence: 0 }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "output" }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", toolNames: ["read"], turnNo: 2, role: "user" }).success).toBe(true)
    expect(
      traceRetrieveToolInputSchema.safeParse({ operation: "inspect", handle: "tdoc_1", startTurnNo: 2, turnLimit: 5 }).success,
    ).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", turnNo: 0 }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", role: "system" }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ turnId: "turn_1" }).success).toBe(false)
    expect(
      traceRetrieveToolOutputSchema.safeParse({
        results: [
          {
            handle: "tdoc_1",
            kind: "message",
            projectId: project.id,
            conversationId: conversation.id,
            turnId: "turn_1",
            messageId: "msg_1",
            sourceId: "msg_1",
            source: { table: "messages", id: "msg_1" },
            conversation: {
              id: conversation.id,
              title: "Trace source",
              status: "active",
              updatedAt: "2026-05-25T00:00:00.000Z",
              isCurrentConversation: false,
            },
            inspectArgs: { operation: "inspect", messageId: "msg_1" },
            title: "User message",
            snippet: "README context",
            score: 0.5,
            turnNo: 2,
            messageRole: "user",
          },
          {
            handle: "tdoc_2",
            kind: "exact_source",
            projectId: project.id,
            conversationId: conversation.id,
            turnId: "turn_1",
            messageId: "msg_1",
            sourceId: "msg_1",
            title: "User message",
            content: "Exact source",
            source: { table: "messages", id: "msg_1" },
            conversation: {
              id: conversation.id,
              title: "Trace source",
              status: "active",
              updatedAt: "2026-05-25T00:00:00.000Z",
              isCurrentConversation: true,
            },
            turnNo: 2,
            messageRole: "user",
            truncation: { truncated: false, charLimit: 20_000, returnedLength: 12 },
          },
        ],
        totalMatches: 2,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 200 },
        appliedFilters: { operation: "search", scope: "current_conversation", mode: "combined", turnNo: 2, role: "user" },
        warnings: ["Semantic trace retrieval is not configured for this project. Use the project dashboard to enable semantic search."],
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
