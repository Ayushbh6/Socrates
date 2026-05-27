import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

const timestamps = {
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  onboardingCompleted: integer("onboarding_completed", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  onboardedAt: text("onboarded_at"),
  metadataJson: text("metadata_json"),
})

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    userStatusIdx: index("projects_user_status_idx").on(table.userId, table.status),
    updatedAtIdx: index("projects_updated_at_idx").on(table.updatedAt),
  }),
)

export const projectWorkspaces = sqliteTable(
  "project_workspaces",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(),
    path: text("path"),
    gitRepoRoot: text("git_repo_root"),
    gitBranch: text("git_branch"),
    gitCommit: text("git_commit"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull(),
    status: text("status").notNull(),
    ...timestamps,
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    projectIdx: index("project_workspaces_project_idx").on(table.projectId),
    primaryIdx: index("project_workspaces_primary_idx").on(table.projectId, table.isPrimary),
  }),
)

export const projectResources = sqliteTable(
  "project_resources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    artifactId: text("artifact_id"),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    uri: text("uri"),
    status: text("status").notNull(),
    errorId: text("error_id"),
    ...timestamps,
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    projectIdx: index("project_resources_project_idx").on(table.projectId),
    statusIdx: index("project_resources_status_idx").on(table.projectId, table.status),
  }),
)

export const projectInstructions = sqliteTable(
  "project_instructions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    title: text("title"),
    content: text("content").notNull(),
    status: text("status").notNull(),
    ...timestamps,
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    projectStatusIdx: index("project_instructions_project_status_idx").on(table.projectId, table.status),
  }),
)

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    userId: text("user_id").notNull(),
    title: text("title"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    projectStatusIdx: index("conversations_project_status_idx").on(table.projectId, table.status),
    updatedAtIdx: index("conversations_updated_at_idx").on(table.updatedAt),
  }),
)

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    projectId: text("project_id").notNull(),
    projectWorkspaceId: text("project_workspace_id"),
    workspacePath: text("workspace_path"),
    workspaceName: text("workspace_name"),
    gitRepoRoot: text("git_repo_root"),
    gitBranch: text("git_branch"),
    gitCommit: text("git_commit"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    closedAt: text("closed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    conversationIdx: index("sessions_conversation_idx").on(table.conversationId),
    projectIdx: index("sessions_project_idx").on(table.projectId),
  }),
)

export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    userMessageId: text("user_message_id"),
    assistantMessageId: text("assistant_message_id"),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    failedAt: text("failed_at"),
    cancelledAt: text("cancelled_at"),
    errorId: text("error_id"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    conversationStatusIdx: index("turns_conversation_status_idx").on(table.conversationId, table.status),
    sessionIdx: index("turns_session_idx").on(table.sessionId),
  }),
)

export const turnRuntimeConfigs = sqliteTable(
  "turn_runtime_configs",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    thinkingEnabled: integer("thinking_enabled", { mode: "boolean" }).notNull(),
    thinkingEffort: text("thinking_effort"),
    approvalMode: text("approval_mode").notNull(),
    sandboxMode: text("sandbox_mode").notNull(),
    temperature: real("temperature"),
    maxOutputTokens: integer("max_output_tokens"),
    contextWindowTokens: integer("context_window_tokens"),
    toolPolicyJson: text("tool_policy_json"),
    providerOptionsJson: text("provider_options_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    turnIdx: index("turn_runtime_configs_turn_idx").on(table.turnId),
  }),
)

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id"),
    role: text("role").notNull(),
    content: text("content").notNull(),
    contentFormat: text("content_format").notNull(),
    status: text("status").notNull(),
    parentMessageId: text("parent_message_id"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    conversationIdx: index("messages_conversation_idx").on(table.conversationId, table.createdAt),
    turnIdx: index("messages_turn_idx").on(table.turnId),
  }),
)

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id"),
    conversationId: text("conversation_id"),
    sessionId: text("session_id"),
    turnId: text("turn_id"),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    source: text("source").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    sequenceIdx: uniqueIndex("events_sequence_idx").on(table.sequence),
    sessionSequenceIdx: index("events_session_sequence_idx").on(table.sessionId, table.sequence),
    projectSequenceIdx: index("events_project_sequence_idx").on(table.projectId, table.sequence),
    turnSequenceIdx: index("events_turn_sequence_idx").on(table.turnId, table.sequence),
    typeIdx: index("events_type_idx").on(table.type),
  }),
)

export const modelCalls = sqliteTable(
  "model_calls",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    runtimeConfigId: text("runtime_config_id"),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    status: text("status").notNull(),
    requestJson: text("request_json").notNull(),
    providerRequestJson: text("provider_request_json"),
    responseJson: text("response_json"),
    providerResponseJson: text("provider_response_json"),
    errorId: text("error_id"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    turnIdx: index("model_calls_turn_idx").on(table.turnId),
    statusIdx: index("model_calls_status_idx").on(table.status),
  }),
)

export const modelStreamChunks = sqliteTable(
  "model_stream_chunks",
  {
    id: text("id").primaryKey(),
    modelCallId: text("model_call_id").notNull(),
    turnId: text("turn_id").notNull(),
    sequence: integer("sequence").notNull(),
    channel: text("channel").notNull(),
    text: text("text"),
    payloadJson: text("payload_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    callSequenceIdx: index("model_stream_chunks_call_sequence_idx").on(table.modelCallId, table.sequence),
    turnIdx: index("model_stream_chunks_turn_idx").on(table.turnId),
  }),
)

export const modelUsage = sqliteTable(
  "model_usage",
  {
    id: text("id").primaryKey(),
    modelCallId: text("model_call_id").notNull(),
    turnId: text("turn_id").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    toolCallTokens: integer("tool_call_tokens"),
    totalTokens: integer("total_tokens"),
    costUsd: real("cost_usd"),
    rawUsageJson: text("raw_usage_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    turnIdx: index("model_usage_turn_idx").on(table.turnId),
    modelCallIdx: index("model_usage_model_call_idx").on(table.modelCallId),
  }),
)

export const contextUsageSnapshots = sqliteTable(
  "context_usage_snapshots",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id"),
    modelCallId: text("model_call_id"),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    contextWindowTokens: integer("context_window_tokens").notNull(),
    contextUsedTokens: integer("context_used_tokens").notNull(),
    contextLeftTokens: integer("context_left_tokens").notNull(),
    contextUsedPercent: real("context_used_percent").notNull(),
    compactionStatus: text("compaction_status"),
    createdAt: text("created_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    conversationIdx: index("context_usage_conversation_idx").on(table.conversationId, table.createdAt),
    turnIdx: index("context_usage_turn_idx").on(table.turnId),
  }),
)

export const contextCompactionSnapshots = sqliteTable(
  "context_compaction_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id"),
    previousSnapshotId: text("previous_snapshot_id"),
    status: text("status").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    reason: text("reason").notNull(),
    sourceMessageIdsJson: text("source_message_ids_json").notNull(),
    sourceTurnIdsJson: text("source_turn_ids_json").notNull(),
    summaryJson: text("summary_json"),
    renderedSummary: text("rendered_summary"),
    sourceHandlesJson: text("source_handles_json"),
    inputTokensEstimate: integer("input_tokens_estimate"),
    outputTokensEstimate: integer("output_tokens_estimate"),
    contextTokensBefore: integer("context_tokens_before").notNull(),
    contextTokensAfter: integer("context_tokens_after"),
    targetTokens: integer("target_tokens").notNull(),
    compressorProviderId: text("compressor_provider_id").notNull(),
    compressorModelId: text("compressor_model_id").notNull(),
    usageJson: text("usage_json"),
    errorId: text("error_id"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    conversationActiveIdx: index("context_compaction_conversation_active_idx").on(table.conversationId, table.active),
    turnIdx: index("context_compaction_turn_idx").on(table.turnId),
    statusIdx: index("context_compaction_status_idx").on(table.status),
  }),
)

export const toolCalls = sqliteTable(
  "tool_calls",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    modelCallId: text("model_call_id"),
    toolName: text("tool_name").notNull(),
    status: text("status").notNull(),
    argumentsJson: text("arguments_json").notNull(),
    resultJson: text("result_json"),
    errorId: text("error_id"),
    requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull(),
    approvalId: text("approval_id"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    turnIdx: index("tool_calls_turn_idx").on(table.turnId),
    statusIdx: index("tool_calls_status_idx").on(table.status),
  }),
)

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    toolCallId: text("tool_call_id"),
    status: text("status").notNull(),
    actionKind: text("action_kind").notNull(),
    actionJson: text("action_json").notNull(),
    decision: text("decision"),
    decidedBy: text("decided_by"),
    requestedAt: text("requested_at").notNull(),
    decidedAt: text("decided_at"),
    expiresAt: text("expires_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    statusIdx: index("approvals_status_idx").on(table.status),
    turnIdx: index("approvals_turn_idx").on(table.turnId),
  }),
)

export const shellCommands = sqliteTable(
  "shell_commands",
  {
    id: text("id").primaryKey(),
    toolCallId: text("tool_call_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    command: text("command").notNull(),
    cwd: text("cwd").notNull(),
    status: text("status").notNull(),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    durationMs: integer("duration_ms"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    turnIdx: index("shell_commands_turn_idx").on(table.turnId),
    toolCallIdx: index("shell_commands_tool_call_idx").on(table.toolCallId),
  }),
)

export const shellOutputChunks = sqliteTable(
  "shell_output_chunks",
  {
    id: text("id").primaryKey(),
    shellCommandId: text("shell_command_id").notNull(),
    sequence: integer("sequence").notNull(),
    stream: text("stream").notNull(),
    text: text("text").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    commandSequenceIdx: index("shell_output_chunks_command_sequence_idx").on(table.shellCommandId, table.sequence),
  }),
)

export const terminalSessions = sqliteTable(
  "terminal_sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    workspacePath: text("workspace_path").notNull(),
    name: text("name").notNull(),
    command: text("command").notNull(),
    cwd: text("cwd").notNull(),
    status: text("status").notNull(),
    platform: text("platform"),
    shellKind: text("shell_kind"),
    shellExecutable: text("shell_executable"),
    processId: text("process_id"),
    exitCode: integer("exit_code"),
    signal: text("signal"),
    autoDetached: integer("auto_detached", { mode: "boolean" }).notNull(),
    awaitingInput: integer("awaiting_input", { mode: "boolean" }).notNull(),
    lastPrompt: text("last_prompt"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    conversationIdx: index("terminal_sessions_conversation_idx").on(table.conversationId),
    statusIdx: index("terminal_sessions_status_idx").on(table.conversationId, table.status),
    processIdx: index("terminal_sessions_process_idx").on(table.processId),
  }),
)

export const terminalOutputChunks = sqliteTable(
  "terminal_output_chunks",
  {
    id: text("id").primaryKey(),
    terminalSessionId: text("terminal_session_id").notNull(),
    sequence: integer("sequence").notNull(),
    stream: text("stream").notNull(),
    text: text("text").notNull(),
    redacted: integer("redacted", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    terminalSequenceIdx: index("terminal_output_chunks_session_sequence_idx").on(table.terminalSessionId, table.sequence),
  }),
)

export const fileOperations = sqliteTable(
  "file_operations",
  {
    id: text("id").primaryKey(),
    toolCallId: text("tool_call_id"),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    operation: text("operation").notNull(),
    path: text("path").notNull(),
    oldPath: text("old_path"),
    contentHashBefore: text("content_hash_before"),
    contentHashAfter: text("content_hash_after"),
    status: text("status").notNull(),
    errorId: text("error_id"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    turnIdx: index("file_operations_turn_idx").on(table.turnId),
    pathIdx: index("file_operations_path_idx").on(table.path),
  }),
)

export const patches = sqliteTable(
  "patches",
  {
    id: text("id").primaryKey(),
    toolCallId: text("tool_call_id"),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    status: text("status").notNull(),
    diffText: text("diff_text").notNull(),
    filesJson: text("files_json"),
    approvalId: text("approval_id"),
    errorId: text("error_id"),
    createdAt: text("created_at").notNull(),
    appliedAt: text("applied_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    turnIdx: index("patches_turn_idx").on(table.turnId),
    statusIdx: index("patches_status_idx").on(table.status),
  }),
)

export const errors = sqliteTable(
  "errors",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id"),
    sessionId: text("session_id"),
    turnId: text("turn_id"),
    source: text("source").notNull(),
    code: text("code").notNull(),
    message: text("message").notNull(),
    stack: text("stack"),
    detailsJson: text("details_json"),
    recoverable: integer("recoverable", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    codeIdx: index("errors_code_idx").on(table.code),
    turnIdx: index("errors_turn_idx").on(table.turnId),
  }),
)

export const traceDocuments = sqliteTable(
  "trace_documents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    conversationId: text("conversation_id"),
    turnId: text("turn_id"),
    sourceKind: text("source_kind").notNull(),
    sourceTable: text("source_table").notNull(),
    sourceId: text("source_id").notNull(),
    handle: text("handle").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    importance: text("importance"),
    preserveVerbatim: integer("preserve_verbatim", { mode: "boolean" }).notNull(),
    chunkIndex: integer("chunk_index"),
    tokenCountEstimate: integer("token_count_estimate"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    projectCreatedIdx: index("trace_documents_project_created_idx").on(table.projectId, table.createdAt),
    conversationCreatedIdx: index("trace_documents_conversation_created_idx").on(table.conversationId, table.createdAt),
    turnIdx: index("trace_documents_turn_idx").on(table.turnId),
    sourceIdx: index("trace_documents_source_idx").on(table.sourceTable, table.sourceId),
    handleIdx: uniqueIndex("trace_documents_handle_idx").on(table.handle),
    kindIdx: index("trace_documents_kind_idx").on(table.sourceKind),
  }),
)

export const traceIndexJobs = sqliteTable(
  "trace_index_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    conversationId: text("conversation_id"),
    turnId: text("turn_id"),
    jobKind: text("job_kind").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull(),
    errorId: text("error_id"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    projectStatusIdx: index("trace_index_jobs_project_status_idx").on(table.projectId, table.status),
    turnIdx: index("trace_index_jobs_turn_idx").on(table.turnId),
    kindStatusIdx: index("trace_index_jobs_kind_status_idx").on(table.jobKind, table.status),
  }),
)

export const projectEmbeddingConfigs = sqliteTable(
  "project_embedding_configs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    dimensions: integer("dimensions"),
    credentialSource: text("credential_source").notNull(),
    workspaceEnvFile: text("workspace_env_file"),
    ollamaBaseUrl: text("ollama_base_url"),
    status: text("status").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    lastError: text("last_error"),
    lastCheckedAt: text("last_checked_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    projectActiveIdx: index("project_embedding_configs_project_active_idx").on(table.projectId, table.active),
    providerModelIdx: index("project_embedding_configs_provider_model_idx").on(table.providerId, table.modelId),
  }),
)

export const traceEmbeddings = sqliteTable(
  "trace_embeddings",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    traceDocumentId: text("trace_document_id").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    dimensions: integer("dimensions").notNull(),
    contentHash: text("content_hash").notNull(),
    vectorJson: text("vector_json").notNull(),
    usageJson: text("usage_json"),
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    embeddedAt: text("embedded_at"),
  },
  (table) => ({
    projectProviderIdx: index("trace_embeddings_project_provider_idx").on(table.projectId, table.providerId, table.modelId, table.dimensions),
    traceDocumentIdx: index("trace_embeddings_document_idx").on(table.traceDocumentId),
    statusIdx: index("trace_embeddings_status_idx").on(table.projectId, table.status),
    activeContentIdx: uniqueIndex("trace_embeddings_active_content_idx").on(
      table.traceDocumentId,
      table.providerId,
      table.modelId,
      table.dimensions,
      table.contentHash,
    ),
  }),
)

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id"),
    conversationId: text("conversation_id"),
    sessionId: text("session_id"),
    turnId: text("turn_id"),
    kind: text("kind").notNull(),
    path: text("path"),
    contentHash: text("content_hash"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    projectIdx: index("artifacts_project_idx").on(table.projectId),
    turnIdx: index("artifacts_turn_idx").on(table.turnId),
  }),
)

export const voiceInputs = sqliteTable(
  "voice_inputs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id"),
    messageId: text("message_id"),
    audioArtifactId: text("audio_artifact_id"),
    transcriptionProviderId: text("transcription_provider_id"),
    transcriptionModelId: text("transcription_model_id"),
    language: text("language"),
    transcriptText: text("transcript_text"),
    rawTranscriptJson: text("raw_transcript_json"),
    confidence: real("confidence"),
    durationMs: integer("duration_ms"),
    status: text("status").notNull(),
    errorId: text("error_id"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    messageIdx: index("voice_inputs_message_idx").on(table.messageId),
    turnIdx: index("voice_inputs_turn_idx").on(table.turnId),
  }),
)

export const audioOutputs = sqliteTable(
  "audio_outputs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id"),
    messageId: text("message_id").notNull(),
    audioArtifactId: text("audio_artifact_id"),
    providerId: text("provider_id"),
    modelId: text("model_id"),
    voiceId: text("voice_id"),
    sourceTextHash: text("source_text_hash"),
    durationMs: integer("duration_ms"),
    status: text("status").notNull(),
    errorId: text("error_id"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    messageIdx: index("audio_outputs_message_idx").on(table.messageId),
    turnIdx: index("audio_outputs_turn_idx").on(table.turnId),
  }),
)

export const messageFeedback = sqliteTable(
  "message_feedback",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id"),
    messageId: text("message_id"),
    modelCallId: text("model_call_id"),
    rating: text("rating").notNull(),
    reasonCode: text("reason_code"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    messageIdx: index("message_feedback_message_idx").on(table.messageId),
    targetIdx: index("message_feedback_target_idx").on(table.turnId, table.modelCallId),
  }),
)

export const sessionState = sqliteTable("session_state", {
  sessionId: text("session_id").primaryKey(),
  activeTurnId: text("active_turn_id"),
  lastEventSequence: integer("last_event_sequence").notNull(),
  stateJson: text("state_json").notNull(),
  updatedAt: text("updated_at").notNull(),
})

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAt: text("applied_at").notNull(),
  checksum: text("checksum"),
})
