import { sql } from "drizzle-orm"
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

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
    authMode: text("auth_mode").notNull().default("api_key"),
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

export const messageAttachments = sqliteTable(
  "message_attachments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id"),
    turnId: text("turn_id"),
    messageId: text("message_id"),
    artifactId: text("artifact_id").notNull(),
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uri: text("uri").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    conversationIdx: index("message_attachments_conversation_idx").on(table.conversationId, table.createdAt),
    messageIdx: index("message_attachments_message_idx").on(table.messageId),
    statusIdx: index("message_attachments_status_idx").on(table.projectId, table.status),
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
    cacheWriteTokens: integer("cache_write_tokens"),
    uncachedInputTokens: integer("uncached_input_tokens"),
    toolCallTokens: integer("tool_call_tokens"),
    totalTokens: integer("total_tokens"),
    costUsd: real("cost_usd"),
    costSource: text("cost_source"),
    routedProvider: text("routed_provider"),
    pricingSnapshotJson: text("pricing_snapshot_json"),
    rawUsageJson: text("raw_usage_json"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    turnIdx: index("model_usage_turn_idx").on(table.turnId),
    modelCallIdx: index("model_usage_model_call_idx").on(table.modelCallId),
  }),
)

export const aiUsageEvents = sqliteTable(
  "ai_usage_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    uncachedInputTokens: integer("uncached_input_tokens"),
    totalTokens: integer("total_tokens"),
    costUsd: real("cost_usd"),
    costSource: text("cost_source").notNull(),
    routedProvider: text("routed_provider"),
    pricingSnapshotJson: text("pricing_snapshot_json"),
    rawUsageJson: text("raw_usage_json"),
    metadataJson: text("metadata_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    turnIdx: index("ai_usage_events_turn_idx").on(table.turnId),
    conversationIdx: index("ai_usage_events_conversation_idx").on(table.conversationId, table.createdAt),
    sourceIdx: uniqueIndex("ai_usage_events_source_idx").on(table.sourceKind, table.sourceId),
  }),
)

export const turnUsageReports = sqliteTable(
  "turn_usage_reports",
  {
    turnId: text("turn_id").primaryKey(),
    projectId: text("project_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    status: text("status").notNull(),
    totalCostUsd: real("total_cost_usd"),
    totalTokens: integer("total_tokens").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    uncachedInputTokens: integer("uncached_input_tokens").notNull(),
    costSource: text("cost_source").notNull(),
    providerBreakdownJson: text("provider_breakdown_json").notNull(),
    modelBreakdownJson: text("model_breakdown_json").notNull(),
    callBreakdownJson: text("call_breakdown_json").notNull(),
    compactionBreakdownJson: text("compaction_breakdown_json").notNull(),
    qualityFlagsJson: text("quality_flags_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    conversationIdx: index("turn_usage_reports_conversation_idx").on(table.conversationId, table.updatedAt),
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
    providerToolCallId: text("provider_tool_call_id"),
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
    stateVersion: integer("state_version").notNull().default(0),
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

export const agentTasks = sqliteTable(
  "agent_tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    rootTurnId: text("root_turn_id").notNull(),
    currentTurnId: text("current_turn_id").notNull(),
    status: text("status").notNull(),
    runtimeConfigJson: text("runtime_config_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    conversationStatusIdx: index("agent_tasks_conversation_status_idx").on(table.conversationId, table.status),
    currentTurnIdx: index("agent_tasks_current_turn_idx").on(table.currentTurnId),
  }),
)

export const agentTaskWaits = sqliteTable(
  "agent_task_waits",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    terminalId: text("terminal_id").notNull(),
    wakeOnJson: text("wake_on_json").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    wokenAt: text("woken_at"),
    wakeEvent: text("wake_event"),
  },
  (table) => ({
    terminalStatusIdx: index("agent_task_waits_terminal_status_idx").on(table.terminalId, table.status),
    taskStatusIdx: index("agent_task_waits_task_status_idx").on(table.taskId, table.status),
  }),
)

export const agentTaskTurns = sqliteTable(
  "agent_task_turns",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    turnId: text("turn_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    taskOrdinalIdx: uniqueIndex("agent_task_turns_task_ordinal_idx").on(table.taskId, table.ordinal),
    turnIdx: uniqueIndex("agent_task_turns_turn_idx").on(table.turnId),
  }),
)

export const taskEvidenceReferences = sqliteTable(
  "task_evidence_references",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    kind: text("kind").notNull(),
    selectorJson: text("selector_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    taskIdx: index("task_evidence_references_task_idx").on(table.taskId),
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

export const memoryAgentJobs = sqliteTable(
  "memory_agent_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    conversationId: text("conversation_id"),
    sessionId: text("session_id"),
    turnId: text("turn_id"),
    status: text("status").notNull(),
    trigger: text("trigger").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    fallbackModelIdsJson: text("fallback_model_ids_json"),
    evidenceTurnIdsJson: text("evidence_turn_ids_json").notNull(),
    evidenceTokensEstimate: integer("evidence_tokens_estimate").notNull(),
    outputJson: text("output_json"),
    errorId: text("error_id"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    projectStatusIdx: index("memory_agent_jobs_project_status_idx").on(table.projectId, table.status),
    turnIdx: index("memory_agent_jobs_turn_idx").on(table.turnId),
  }),
)

export const memoryAgentJournal = sqliteTable(
  "memory_agent_journal",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    summary: text("summary").notNull(),
    patternsObservedJson: text("patterns_observed_json").notNull(),
    skillsAffectedJson: text("skills_affected_json").notNull(),
    decisionsJson: text("decisions_json").notNull(),
    openInvestigationsJson: text("open_investigations_json").notNull(),
    nextRunFocusJson: text("next_run_focus_json").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    thinkingEnabled: integer("thinking_enabled", { mode: "boolean" }).notNull(),
    thinkingEffort: text("thinking_effort"),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    jobIdx: uniqueIndex("memory_agent_journal_job_idx").on(table.jobId),
    createdAtIdx: index("memory_agent_journal_created_at_idx").on(table.createdAt),
  }),
)

export const memoryNotes = sqliteTable(
  "memory_notes",
  {
    id: text("id").primaryKey(),
    noteNumber: integer("note_number").notNull(),
    status: text("status").notNull(),
    priority: text("priority").notNull(),
    intent: text("intent").notNull(),
    note: text("note").notNull(),
    normalizedNoteKey: text("normalized_note_key"),
    projectId: text("project_id"),
    conversationId: text("conversation_id"),
    sessionId: text("session_id"),
    turnId: text("turn_id"),
    messageId: text("message_id"),
    messageExcerpt: text("message_excerpt"),
    resolution: text("resolution"),
    outcome: text("outcome"),
    createdByAgent: text("created_by_agent").notNull(),
    createdAt: text("created_at").notNull(),
    claimedAt: text("claimed_at"),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    statusIdx: index("memory_notes_status_idx").on(table.status, table.noteNumber),
    sourceTurnIdx: index("memory_notes_source_turn_idx").on(table.turnId),
    normalizedKeyIdx: index("memory_notes_normalized_key_idx").on(table.normalizedNoteKey),
    sourceTurnAgentKeyIdx: index("memory_notes_source_turn_agent_key_idx").on(table.turnId, table.createdByAgent, table.normalizedNoteKey),
    conversationIdx: index("memory_notes_conversation_idx").on(table.conversationId),
    noteNumberIdx: uniqueIndex("memory_notes_number_idx").on(table.noteNumber),
  }),
)

export const skillWriterJobs = sqliteTable(
  "skill_writer_jobs",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    operation: text("operation").notNull(),
    skillName: text("skill_name").notNull(),
    projectId: text("project_id"),
    conversationId: text("conversation_id"),
    sessionId: text("session_id"),
    turnId: text("turn_id"),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id"),
    status: text("status").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    outputJson: text("output_json"),
    error: text("error"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    statusIdx: index("skill_writer_jobs_status_idx").on(table.status, table.startedAt),
    sourceIdx: index("skill_writer_jobs_source_idx").on(table.sourceKind, table.sourceId),
    skillIdx: index("skill_writer_jobs_skill_idx").on(table.scope, table.skillName),
  }),
)

export const projectMemoryAgentSettings = sqliteTable(
  "project_memory_agent_settings",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    thinkingEnabled: integer("thinking_enabled", { mode: "boolean" }).notNull(),
    thinkingEffort: text("thinking_effort"),
    ...timestamps,
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    projectIdx: uniqueIndex("project_memory_agent_settings_project_idx").on(table.projectId),
  }),
)

export const memoryAgentGlobalSettings = sqliteTable("memory_agent_global_settings", {
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull(),
  authMode: text("auth_mode").notNull().default("api_key"),
  modelId: text("model_id").notNull(),
  thinkingEnabled: integer("thinking_enabled", { mode: "boolean" }).notNull(),
  thinkingEffort: text("thinking_effort"),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  cadenceMinutes: integer("cadence_minutes").notNull(),
  ...timestamps,
  metadataJson: text("metadata_json"),
})

export const workerModelSettings = sqliteTable(
  "worker_model_settings",
  {
    id: text("id").primaryKey(),
    workerId: text("worker_id").notNull(),
    providerId: text("provider_id").notNull(),
    authMode: text("auth_mode").notNull().default("api_key"),
    modelId: text("model_id").notNull(),
    thinkingEnabled: integer("thinking_enabled", { mode: "boolean" }).notNull(),
    thinkingEffort: text("thinking_effort"),
    ...timestamps,
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    workerIdx: uniqueIndex("worker_model_settings_worker_idx").on(table.workerId),
  }),
)

export const memoryAgentGlobalState = sqliteTable("memory_agent_global_state", {
  id: text("id").primaryKey(),
  lastProcessedEventSequence: integer("last_processed_event_sequence").notNull(),
  lastRunAt: text("last_run_at"),
  lastCheckedAt: text("last_checked_at"),
  lastRealRunAt: text("last_real_run_at"),
  status: text("status").notNull(),
  activeJobId: text("active_job_id"),
  lastJobId: text("last_job_id"),
  error: text("error"),
  ...timestamps,
  metadataJson: text("metadata_json"),
})

export const memoryAgentChecks = sqliteTable(
  "memory_agent_checks",
  {
    id: text("id").primaryKey(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull(),
    reason: text("reason").notNull(),
    sequenceFrom: integer("sequence_from"),
    sequenceTo: integer("sequence_to").notNull(),
    turnCount: integer("turn_count").notNull(),
    toolCalls: integer("tool_calls").notNull(),
    fileChangeEvents: integer("file_change_events").notNull(),
    distinctChangedFiles: integer("distinct_changed_files").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    checkedAt: text("checked_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    checkedAtIdx: index("memory_agent_checks_checked_at_idx").on(table.checkedAt),
    statusIdx: index("memory_agent_checks_status_idx").on(table.status),
  }),
)

export const memoryAgentActions = sqliteTable(
  "memory_agent_actions",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    projectId: text("project_id").notNull(),
    turnId: text("turn_id"),
    targetKind: text("target_kind").notNull(),
    targetPath: text("target_path").notNull(),
    status: text("status").notNull(),
    requiresConfirmation: integer("requires_confirmation", { mode: "boolean" }).notNull(),
    confirmationId: text("confirmation_id"),
    beforeHash: text("before_hash"),
    afterHash: text("after_hash"),
    patchJson: text("patch_json").notNull(),
    rationale: text("rationale"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    appliedAt: text("applied_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    jobIdx: index("memory_agent_actions_job_idx").on(table.jobId),
    targetIdx: index("memory_agent_actions_target_idx").on(table.targetKind, table.status),
  }),
)

export const memoryAgentConfirmations = sqliteTable(
  "memory_agent_confirmations",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    actionId: text("action_id").notNull(),
    projectId: text("project_id").notNull(),
    document: text("document").notNull(),
    promptText: text("prompt_text").notNull(),
    responseText: text("response_text"),
    decision: text("decision"),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    requestedAt: text("requested_at").notNull(),
    decidedAt: text("decided_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    jobIdx: index("memory_agent_confirmations_job_idx").on(table.jobId),
    actionIdx: index("memory_agent_confirmations_action_idx").on(table.actionId),
  }),
)

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id"),
    conversationId: text("conversation_id"),
    turnId: text("turn_id"),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    severity: text("severity").notNull(),
    payloadJson: text("payload_json"),
    readAt: text("read_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    projectReadIdx: index("notifications_project_read_idx").on(table.projectId, table.readAt),
    createdIdx: index("notifications_created_idx").on(table.createdAt),
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

export const memoryDocIndexes = sqliteTable(
  "memory_doc_indexes",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    projectId: text("project_id").notNull(),
    path: text("path").notNull(),
    docType: text("doc_type").notNull(),
    ownerTool: text("owner_tool").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    contentHash: text("content_hash").notNull(),
    sectionCount: integer("section_count").notNull(),
    indexedAt: text("indexed_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    scopeProjectPathIdx: uniqueIndex("memory_doc_indexes_scope_project_path_idx").on(table.scope, table.projectId, table.path),
    projectIdx: index("memory_doc_indexes_project_idx").on(table.projectId),
  }),
)

export const memoryDocSections = sqliteTable(
  "memory_doc_sections",
  {
    id: text("id").primaryKey(),
    docIndexId: text("doc_index_id").notNull(),
    scope: text("scope").notNull(),
    projectId: text("project_id").notNull(),
    path: text("path").notNull(),
    docType: text("doc_type").notNull(),
    sectionId: text("section_id").notNull(),
    kind: text("kind").notNull(),
    tagsJson: text("tags_json").notNull(),
    heading: text("heading").notNull(),
    lineStart: integer("line_start").notNull(),
    lineEnd: integer("line_end").notNull(),
    content: text("content").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    summary: text("summary").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    updatedAt: text("updated_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    docSectionIdx: uniqueIndex("memory_doc_sections_doc_section_idx").on(table.docIndexId, table.sectionId),
    lookupIdx: index("memory_doc_sections_lookup_idx").on(table.scope, table.projectId, table.docType, table.sectionId),
  }),
)

export const retrievalIndexStates = sqliteTable(
  "retrieval_index_states",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    indexVersion: integer("index_version").notNull(),
    tableName: text("table_name"),
    status: text("status").notNull(),
    embeddingFingerprint: text("embedding_fingerprint"),
    lexicalReady: integer("lexical_ready", { mode: "boolean" }).notNull(),
    vectorReady: integer("vector_ready", { mode: "boolean" }).notNull(),
    traceParents: integer("trace_parents").notNull(),
    traceChunks: integer("trace_chunks").notNull(),
    memoryParents: integer("memory_parents").notNull(),
    memoryChunks: integer("memory_chunks").notNull(),
    lastError: text("last_error"),
    rebuildStartedAt: text("rebuild_started_at"),
    rebuildCompletedAt: text("rebuild_completed_at"),
    ...timestamps,
  },
  (table) => ({
    projectIdx: uniqueIndex("retrieval_index_states_project_idx").on(table.projectId),
    statusIdx: index("retrieval_index_states_status_idx").on(table.status),
  }),
)

export const retrievalJobs = sqliteTable(
  "retrieval_jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    kind: text("kind").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull(),
    error: text("error"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    projectStatusIdx: index("retrieval_jobs_project_status_idx").on(table.projectId, table.status, table.createdAt),
  }),
)

export const retrievalRuns = sqliteTable(
  "retrieval_runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    conversationId: text("conversation_id"),
    corpusKind: text("corpus_kind").notNull(),
    query: text("query").notNull(),
    mode: text("mode").notNull(),
    filtersJson: text("filters_json").notNull(),
    embeddingFingerprint: text("embedding_fingerprint"),
    status: text("status").notNull(),
    latencyMs: integer("latency_ms"),
    warningsJson: text("warnings_json"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    projectCreatedIdx: index("retrieval_runs_project_created_idx").on(table.projectId, table.createdAt),
    conversationIdx: index("retrieval_runs_conversation_idx").on(table.conversationId, table.createdAt),
  }),
)

export const retrievalResultDiagnostics = sqliteTable(
  "retrieval_result_diagnostics",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    rank: integer("rank").notNull(),
    chunkId: text("chunk_id").notNull(),
    parentId: text("parent_id").notNull(),
    rawScore: real("raw_score").notNull(),
    normalizedScore: real("normalized_score").notNull(),
    recencyReordered: integer("recency_reordered", { mode: "boolean" }).notNull(),
    selected: integer("selected", { mode: "boolean" }).notNull(),
    sourceRefJson: text("source_ref_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    runRankIdx: uniqueIndex("retrieval_result_diagnostics_run_rank_idx").on(table.runId, table.rank),
    parentIdx: index("retrieval_result_diagnostics_parent_idx").on(table.parentId),
  }),
)

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAt: text("applied_at").notNull(),
  checksum: text("checksum"),
})

// V2 Flow is deliberately isolated from every V1 conversation table. The V2
// store may reuse low-level provider/tool infrastructure, but all persisted
// ownership and lifecycle state lives under this `v2_` namespace.

export const v2Flows = sqliteTable(
  "v2_flows",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    status: text("status").notNull(),
    foregroundGoalId: text("foreground_goal_id"),
    contextPolicyJson: text("context_policy_json").notNull(),
    revision: integer("revision").notNull().default(0),
    lastEventSequence: integer("last_event_sequence").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    projectIdx: uniqueIndex("v2_flows_project_idx").on(table.projectId),
    statusUpdatedIdx: index("v2_flows_status_updated_idx").on(table.status, table.updatedAt),
    revisionCheck: check("v2_flows_revision_check", sql`${table.revision} >= 0`),
    eventSequenceCheck: check("v2_flows_event_sequence_check", sql`${table.lastEventSequence} >= 0`),
  }),
)

export const v2Goals = sqliteTable(
  "v2_goals",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    kind: text("kind").notNull().default("work"),
    status: text("status").notNull(),
    origin: text("origin").notNull(),
    priority: integer("priority").notNull().default(50),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    lastActiveAt: text("last_active_at").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    archivedAt: text("archived_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    flowOrdinalIdx: uniqueIndex("v2_goals_flow_ordinal_idx").on(table.flowId, table.ordinal),
    oneForegroundIdx: uniqueIndex("v2_goals_one_foreground_idx")
      .on(table.flowId)
      .where(sql`${table.status} = 'foreground'`),
    flowStatusIdx: index("v2_goals_flow_status_idx").on(table.flowId, table.status, table.lastActiveAt),
    projectStatusIdx: index("v2_goals_project_status_idx").on(table.projectId, table.status),
    ordinalCheck: check("v2_goals_ordinal_check", sql`${table.ordinal} > 0`),
    priorityCheck: check("v2_goals_priority_check", sql`${table.priority} BETWEEN 0 AND 100`),
  }),
)

export const v2GoalTransitions = sqliteTable(
  "v2_goal_transitions",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    goalId: text("goal_id").notNull(),
    turnId: text("turn_id"),
    routingRunId: text("routing_run_id"),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    reason: text("reason").notNull(),
    note: text("note"),
    sequence: integer("sequence").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    flowSequenceIdx: uniqueIndex("v2_goal_transitions_flow_sequence_idx").on(table.flowId, table.sequence),
    goalCreatedIdx: index("v2_goal_transitions_goal_created_idx").on(table.goalId, table.createdAt),
    turnIdx: index("v2_goal_transitions_turn_idx").on(table.turnId),
    routingRunIdx: index("v2_goal_transitions_routing_run_idx").on(table.routingRunId),
    sequenceCheck: check("v2_goal_transitions_sequence_check", sql`${table.sequence} > 0`),
  }),
)

export const v2GoalRoutingRuns = sqliteTable(
  "v2_goal_routing_runs",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    turnId: text("turn_id").notNull(),
    messageId: text("message_id").notNull(),
    foregroundGoalId: text("foreground_goal_id"),
    candidateGoalIdsJson: text("candidate_goal_ids_json").notNull(),
    selectedGoalId: text("selected_goal_id"),
    decision: text("decision"),
    confidence: real("confidence"),
    rationale: text("rationale"),
    clarificationQuestion: text("clarification_question"),
    clarificationCandidateGoalIdsJson: text("clarification_candidate_goal_ids_json").notNull().default("[]"),
    clarificationAnswerMessageId: text("clarification_answer_message_id"),
    providerId: text("provider_id"),
    modelId: text("model_id"),
    status: text("status").notNull(),
    fallbackReason: text("fallback_reason"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    turnIdx: uniqueIndex("v2_goal_routing_runs_turn_idx").on(table.turnId),
    flowStartedIdx: index("v2_goal_routing_runs_flow_started_idx").on(table.flowId, table.startedAt),
    selectedGoalIdx: index("v2_goal_routing_runs_selected_goal_idx").on(table.selectedGoalId),
    confidenceCheck: check(
      "v2_goal_routing_runs_confidence_check",
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`,
    ),
  }),
)

export const v2GoalCapsules = sqliteTable(
  "v2_goal_capsules",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    goalId: text("goal_id").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    decisionsJson: text("decisions_json").notNull(),
    openQuestionsJson: text("open_questions_json").notNull(),
    nextActionsJson: text("next_actions_json").notNull(),
    evidenceHandlesJson: text("evidence_handles_json").notNull(),
    sourceThroughSequence: integer("source_through_sequence").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    createdByTurnId: text("created_by_turn_id"),
    createdAt: text("created_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    goalVersionIdx: uniqueIndex("v2_goal_capsules_goal_version_idx").on(table.goalId, table.version),
    oneActiveIdx: uniqueIndex("v2_goal_capsules_one_active_idx")
      .on(table.goalId)
      .where(sql`${table.status} = 'active'`),
    flowCreatedIdx: index("v2_goal_capsules_flow_created_idx").on(table.flowId, table.createdAt),
    versionCheck: check("v2_goal_capsules_version_check", sql`${table.version} > 0`),
    sourceSequenceCheck: check("v2_goal_capsules_source_sequence_check", sql`${table.sourceThroughSequence} >= 0`),
    tokenEstimateCheck: check("v2_goal_capsules_token_estimate_check", sql`${table.tokenEstimate} >= 0`),
  }),
)

export const v2GoalMessageLinks = sqliteTable(
  "v2_goal_message_links",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    goalId: text("goal_id").notNull(),
    messageId: text("message_id").notNull(),
    turnId: text("turn_id"),
    relation: text("relation").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    goalMessageIdx: uniqueIndex("v2_goal_message_links_goal_message_idx").on(table.goalId, table.messageId, table.relation),
    messageIdx: index("v2_goal_message_links_message_idx").on(table.messageId),
    flowCreatedIdx: index("v2_goal_message_links_flow_created_idx").on(table.flowId, table.createdAt),
  }),
)

// A bridge owns one Classic conversation's projection into the project Flow.
// Its `goalId` is the conversation's most recently selected goal, not a
// permanent one-to-one assignment. Per-turn links below preserve the canonical
// many-to-many conversation <-> goal history. Tool/evidence ownership stays
// with the runtime that produced it.
export const v2ClassicConversationBridges = sqliteTable(
  "v2_classic_conversation_bridges",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    flowId: text("flow_id").notNull(),
    goalId: text("goal_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    activeOwner: text("active_owner").notNull().default("v2"),
    status: text("status").notNull().default("active"),
    lastV2MessageOrdinal: integer("last_v2_message_ordinal").notNull().default(0),
    lastClassicMessageCreatedAt: text("last_classic_message_created_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    goalIdx: index("v2_classic_bridges_goal_idx").on(table.goalId),
    conversationIdx: uniqueIndex("v2_classic_bridges_conversation_idx").on(table.conversationId),
    flowStatusIdx: index("v2_classic_bridges_flow_status_idx").on(table.flowId, table.status),
    ownerCheck: check("v2_classic_bridges_owner_check", sql`${table.activeOwner} IN ('v2', 'classic')`),
  }),
)

// Flow -> Classic is deterministic without making the relationship one-to-one:
// a goal has at most one preferred Classic home, while that conversation may
// contain turns belonging to any number of goals.
export const v2GoalClassicHomes = sqliteTable(
  "v2_goal_classic_homes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    flowId: text("flow_id").notNull(),
    goalId: text("goal_id").notNull(),
    bridgeId: text("bridge_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    goalIdx: uniqueIndex("v2_goal_classic_homes_goal_idx").on(table.goalId),
    conversationIdx: index("v2_goal_classic_homes_conversation_idx").on(table.conversationId),
    flowIdx: index("v2_goal_classic_homes_flow_idx").on(table.flowId),
  }),
)

// Classic turns are assigned to exactly one canonical project goal by the
// pre-turn Memory Router. This compact ledger is sufficient to reconstruct a
// multi-goal Classic conversation without replaying its full token history.
export const v2ClassicTurnGoalLinks = sqliteTable(
  "v2_classic_turn_goal_links",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    flowId: text("flow_id").notNull(),
    goalId: text("goal_id").notNull(),
    bridgeId: text("bridge_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    userMessageId: text("user_message_id").notNull(),
    assistantMessageId: text("assistant_message_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    turnIdx: uniqueIndex("v2_classic_turn_goal_links_turn_idx").on(table.turnId),
    goalCreatedIdx: index("v2_classic_turn_goal_links_goal_created_idx").on(table.goalId, table.createdAt),
    conversationCreatedIdx: index("v2_classic_turn_goal_links_conversation_created_idx").on(table.conversationId, table.createdAt),
  }),
)

export const v2ClassicMessageLinks = sqliteTable(
  "v2_classic_message_links",
  {
    id: text("id").primaryKey(),
    bridgeId: text("bridge_id").notNull(),
    v2MessageId: text("v2_message_id").notNull(),
    classicMessageId: text("classic_message_id").notNull(),
    direction: text("direction").notNull(),
    sourceRuntime: text("source_runtime").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    v2MessageIdx: uniqueIndex("v2_classic_message_links_v2_idx").on(table.v2MessageId),
    classicMessageIdx: uniqueIndex("v2_classic_message_links_classic_idx").on(table.classicMessageId),
    bridgeCreatedIdx: index("v2_classic_message_links_bridge_idx").on(table.bridgeId, table.createdAt),
    directionCheck: check("v2_classic_message_links_direction_check", sql`${table.direction} IN ('v2_to_classic', 'classic_to_v2')`),
    runtimeCheck: check("v2_classic_message_links_runtime_check", sql`${table.sourceRuntime} IN ('v2', 'classic')`),
  }),
)

export const v2Turns = sqliteTable(
  "v2_turns",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    ordinal: integer("ordinal").notNull(),
    userMessageId: text("user_message_id"),
    assistantMessageId: text("assistant_message_id"),
    status: text("status").notNull(),
    waitingReason: text("waiting_reason"),
    errorId: text("error_id"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    failedAt: text("failed_at"),
    cancelledAt: text("cancelled_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    flowOrdinalIdx: uniqueIndex("v2_turns_flow_ordinal_idx").on(table.flowId, table.ordinal),
    flowStatusIdx: index("v2_turns_flow_status_idx").on(table.flowId, table.status),
    goalStartedIdx: index("v2_turns_goal_started_idx").on(table.goalId, table.startedAt),
    projectStatusIdx: index("v2_turns_project_status_idx").on(table.projectId, table.status),
    ordinalCheck: check("v2_turns_ordinal_check", sql`${table.ordinal} > 0`),
  }),
)

export const v2TurnRuntimeConfigs = sqliteTable(
  "v2_turn_runtime_configs",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id").notNull(),
    flowId: text("flow_id").notNull(),
    providerId: text("provider_id").notNull(),
    authMode: text("auth_mode").notNull().default("api_key"),
    modelId: text("model_id").notNull(),
    thinkingEnabled: integer("thinking_enabled", { mode: "boolean" }).notNull(),
    thinkingEffort: text("thinking_effort"),
    approvalMode: text("approval_mode").notNull(),
    sandboxMode: text("sandbox_mode").notNull(),
    contextWindowTokens: integer("context_window_tokens"),
    providerOptionsJson: text("provider_options_json"),
    toolPolicyJson: text("tool_policy_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    turnIdx: uniqueIndex("v2_turn_runtime_configs_turn_idx").on(table.turnId),
    flowIdx: index("v2_turn_runtime_configs_flow_idx").on(table.flowId),
    contextWindowCheck: check(
      "v2_turn_runtime_configs_context_window_check",
      sql`${table.contextWindowTokens} IS NULL OR ${table.contextWindowTokens} > 0`,
    ),
  }),
)

export const v2Messages = sqliteTable(
  "v2_messages",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id"),
    ordinal: integer("ordinal").notNull(),
    role: text("role").notNull(),
    kind: text("kind").notNull().default("standard"),
    content: text("content").notNull(),
    reasoning: text("reasoning"),
    contentFormat: text("content_format").notNull().default("markdown"),
    status: text("status").notNull(),
    parentMessageId: text("parent_message_id"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    flowOrdinalIdx: uniqueIndex("v2_messages_flow_ordinal_idx").on(table.flowId, table.ordinal),
    turnIdx: index("v2_messages_turn_idx").on(table.turnId),
    goalCreatedIdx: index("v2_messages_goal_created_idx").on(table.goalId, table.createdAt),
    projectCreatedIdx: index("v2_messages_project_created_idx").on(table.projectId, table.createdAt),
    ordinalCheck: check("v2_messages_ordinal_check", sql`${table.ordinal} > 0`),
  }),
)

export const v2MessageAttachments = sqliteTable(
  "v2_message_attachments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    flowId: text("flow_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id"),
    messageId: text("message_id"),
    artifactId: text("artifact_id").notNull(),
    kind: text("kind").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uri: text("uri").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    flowCreatedIdx: index("v2_message_attachments_flow_created_idx").on(table.flowId, table.createdAt),
    messageIdx: index("v2_message_attachments_message_idx").on(table.messageId),
    artifactIdx: uniqueIndex("v2_message_attachments_artifact_idx").on(table.artifactId),
    projectStatusIdx: index("v2_message_attachments_project_status_idx").on(table.projectId, table.status),
    sizeCheck: check("v2_message_attachments_size_check", sql`${table.sizeBytes} >= 0`),
  }),
)

// Evidence rows are append-only for agent/runtime operations. Explicit user
// deletion is authorized by a short-lived row in v2_deletion_authorizations;
// pruning still changes only v2_context_items and v2_context_dispositions.
export const v2EvidenceItems = sqliteTable(
  "v2_evidence_items",
  {
    id: text("id").primaryKey(),
    handle: text("handle").notNull(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id"),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id"),
    sourceUri: text("source_uri"),
    title: text("title").notNull(),
    mimeType: text("mime_type"),
    content: text("content"),
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes"),
    tokenEstimate: integer("token_estimate"),
    locatorJson: text("locator_json"),
    createdAt: text("created_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    handleIdx: uniqueIndex("v2_evidence_items_handle_idx").on(table.handle),
    flowCreatedIdx: index("v2_evidence_items_flow_created_idx").on(table.flowId, table.createdAt),
    goalCreatedIdx: index("v2_evidence_items_goal_created_idx").on(table.goalId, table.createdAt),
    sourceIdx: index("v2_evidence_items_source_idx").on(table.sourceKind, table.sourceId),
    contentHashIdx: index("v2_evidence_items_content_hash_idx").on(table.flowId, table.contentHash),
    sizeCheck: check("v2_evidence_items_size_check", sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`),
    tokenCheck: check("v2_evidence_items_token_check", sql`${table.tokenEstimate} IS NULL OR ${table.tokenEstimate} >= 0`),
  }),
)

export const v2DeletionAuthorizations = sqliteTable(
  "v2_deletion_authorizations",
  {
    id: text("id").primaryKey(),
    targetKind: text("target_kind").notNull(),
    targetId: text("target_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    targetIdx: uniqueIndex("v2_deletion_authorizations_target_idx").on(table.targetKind, table.targetId),
    kindCheck: check("v2_deletion_authorizations_kind_check", sql`${table.targetKind} IN ('turn', 'goal', 'flow')`),
  }),
)

export const v2ContextItems = sqliteTable(
  "v2_context_items",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id"),
    kind: text("kind").notNull(),
    state: text("state").notNull(),
    content: text("content").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    rank: integer("rank").notNull(),
    activeFromTurnOrdinal: integer("active_from_turn_ordinal").notNull(),
    releasedAtTurnOrdinal: integer("released_at_turn_ordinal"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    flowStateRankIdx: index("v2_context_items_flow_state_rank_idx").on(table.flowId, table.state, table.rank),
    goalStateIdx: index("v2_context_items_goal_state_idx").on(table.goalId, table.state),
    turnIdx: index("v2_context_items_turn_idx").on(table.turnId),
    tokenCheck: check("v2_context_items_token_check", sql`${table.tokenEstimate} >= 0`),
    rankCheck: check("v2_context_items_rank_check", sql`${table.rank} >= 0`),
    activeOrdinalCheck: check("v2_context_items_active_ordinal_check", sql`${table.activeFromTurnOrdinal} > 0`),
    releaseOrdinalCheck: check(
      "v2_context_items_release_ordinal_check",
      sql`${table.releasedAtTurnOrdinal} IS NULL OR ${table.releasedAtTurnOrdinal} >= ${table.activeFromTurnOrdinal}`,
    ),
  }),
)

export const v2ContextItemSources = sqliteTable(
  "v2_context_item_sources",
  {
    id: text("id").primaryKey(),
    contextItemId: text("context_item_id").notNull(),
    evidenceItemId: text("evidence_item_id"),
    messageId: text("message_id"),
    capsuleId: text("capsule_id"),
    sourceOrder: integer("source_order").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    itemOrderIdx: uniqueIndex("v2_context_item_sources_item_order_idx").on(table.contextItemId, table.sourceOrder),
    evidenceIdx: index("v2_context_item_sources_evidence_idx").on(table.evidenceItemId),
    messageIdx: index("v2_context_item_sources_message_idx").on(table.messageId),
    capsuleIdx: index("v2_context_item_sources_capsule_idx").on(table.capsuleId),
    sourceOrderCheck: check("v2_context_item_sources_order_check", sql`${table.sourceOrder} >= 0`),
    exactlyOneSourceCheck: check(
      "v2_context_item_sources_exactly_one_check",
      sql`(CASE WHEN ${table.evidenceItemId} IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN ${table.messageId} IS NOT NULL THEN 1 ELSE 0 END + CASE WHEN ${table.capsuleId} IS NOT NULL THEN 1 ELSE 0 END) = 1`,
    ),
  }),
)

export const v2ContextDispositions = sqliteTable(
  "v2_context_dispositions",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id").notNull(),
    contextItemId: text("context_item_id").notNull(),
    version: integer("version").notNull(),
    disposition: text("disposition").notNull(),
    reason: text("reason").notNull(),
    decidedBy: text("decided_by").notNull(),
    unresolvedAgeTurns: integer("unresolved_age_turns"),
    unresolvedMaxAgeTurns: integer("unresolved_max_age_turns"),
    distillationInstruction: text("distillation_instruction"),
    replacementContextItemId: text("replacement_context_item_id"),
    createdAt: text("created_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    itemVersionIdx: uniqueIndex("v2_context_dispositions_item_version_idx").on(table.contextItemId, table.version),
    flowCreatedIdx: index("v2_context_dispositions_flow_created_idx").on(table.flowId, table.createdAt),
    goalDispositionIdx: index("v2_context_dispositions_goal_disposition_idx").on(table.goalId, table.disposition),
    turnIdx: index("v2_context_dispositions_turn_idx").on(table.turnId),
    versionCheck: check("v2_context_dispositions_version_check", sql`${table.version} > 0`),
    unresolvedBoundsCheck: check(
      "v2_context_dispositions_unresolved_bounds_check",
      sql`(${table.disposition} = 'unresolved' AND ${table.unresolvedAgeTurns} IS NOT NULL AND ${table.unresolvedMaxAgeTurns} IS NOT NULL AND ${table.unresolvedAgeTurns} >= 0 AND ${table.unresolvedMaxAgeTurns} BETWEEN 1 AND 3 AND ${table.unresolvedAgeTurns} <= ${table.unresolvedMaxAgeTurns}) OR (${table.disposition} <> 'unresolved' AND ${table.unresolvedAgeTurns} IS NULL AND ${table.unresolvedMaxAgeTurns} IS NULL)`,
    ),
    distillInstructionCheck: check(
      "v2_context_dispositions_distill_instruction_check",
      sql`${table.disposition} <> 'distill' OR ${table.distillationInstruction} IS NOT NULL`,
    ),
  }),
)

export const v2RuntimeEvents = sqliteTable(
  "v2_runtime_events",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id"),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    source: text("source").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    flowSequenceIdx: uniqueIndex("v2_runtime_events_flow_sequence_idx").on(table.flowId, table.sequence),
    projectSequenceIdx: index("v2_runtime_events_project_sequence_idx").on(table.projectId, table.sequence),
    goalSequenceIdx: index("v2_runtime_events_goal_sequence_idx").on(table.goalId, table.sequence),
    turnSequenceIdx: index("v2_runtime_events_turn_sequence_idx").on(table.turnId, table.sequence),
    typeIdx: index("v2_runtime_events_type_idx").on(table.type),
    sequenceCheck: check("v2_runtime_events_sequence_check", sql`${table.sequence} > 0`),
    typeCheck: check("v2_runtime_events_type_check", sql`${table.type} LIKE 'v2.%'`),
  }),
)

export const v2ModelCalls = sqliteTable(
  "v2_model_calls",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id"),
    role: text("role").notNull(),
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
    turnIdx: index("v2_model_calls_turn_idx").on(table.turnId),
    flowStartedIdx: index("v2_model_calls_flow_started_idx").on(table.flowId, table.startedAt),
    roleStatusIdx: index("v2_model_calls_role_status_idx").on(table.role, table.status),
  }),
)

export const v2UsageEvents = sqliteTable(
  "v2_usage_events",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id"),
    modelCallId: text("model_call_id").notNull(),
    providerId: text("provider_id").notNull(),
    modelId: text("model_id").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    reasoningTokens: integer("reasoning_tokens").notNull(),
    cachedInputTokens: integer("cached_input_tokens").notNull(),
    totalTokens: integer("total_tokens").notNull(),
    costUsd: real("cost_usd"),
    costSource: text("cost_source").notNull(),
    rawUsageJson: text("raw_usage_json"),
    createdAt: text("created_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    modelCallIdx: uniqueIndex("v2_usage_events_model_call_idx").on(table.modelCallId),
    flowCreatedIdx: index("v2_usage_events_flow_created_idx").on(table.flowId, table.createdAt),
    turnIdx: index("v2_usage_events_turn_idx").on(table.turnId),
    tokenCheck: check(
      "v2_usage_events_token_check",
      sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.reasoningTokens} >= 0 AND ${table.cachedInputTokens} >= 0 AND ${table.totalTokens} >= 0`,
    ),
    costCheck: check("v2_usage_events_cost_check", sql`${table.costUsd} IS NULL OR ${table.costUsd} >= 0`),
  }),
)

export const v2ToolCalls = sqliteTable(
  "v2_tool_calls",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id").notNull(),
    modelCallId: text("model_call_id"),
    providerToolCallId: text("provider_tool_call_id"),
    toolName: text("tool_name").notNull(),
    status: text("status").notNull(),
    argumentsJson: text("arguments_json").notNull(),
    resultJson: text("result_json"),
    requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull(),
    approvalId: text("approval_id"),
    errorId: text("error_id"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    turnIdx: index("v2_tool_calls_turn_idx").on(table.turnId),
    flowStatusIdx: index("v2_tool_calls_flow_status_idx").on(table.flowId, table.status),
    goalStartedIdx: index("v2_tool_calls_goal_started_idx").on(table.goalId, table.startedAt),
    approvalIdx: index("v2_tool_calls_approval_idx").on(table.approvalId),
  }),
)

export const v2Approvals = sqliteTable(
  "v2_approvals",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id").notNull(),
    toolCallId: text("tool_call_id"),
    status: text("status").notNull(),
    actionKind: text("action_kind").notNull(),
    actionJson: text("action_json").notNull(),
    decision: text("decision"),
    reason: text("reason"),
    decidedBy: text("decided_by"),
    requestedAt: text("requested_at").notNull(),
    decidedAt: text("decided_at"),
    expiresAt: text("expires_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    flowStatusIdx: index("v2_approvals_flow_status_idx").on(table.flowId, table.status),
    turnIdx: index("v2_approvals_turn_idx").on(table.turnId),
    toolCallIdx: uniqueIndex("v2_approvals_tool_call_idx").on(table.toolCallId),
  }),
)

export const v2TerminalSessions = sqliteTable(
  "v2_terminal_sessions",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id"),
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
    stateVersion: integer("state_version").notNull().default(0),
    lastPrompt: text("last_prompt"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    flowStatusIdx: index("v2_terminal_sessions_flow_status_idx").on(table.flowId, table.status),
    goalStatusIdx: index("v2_terminal_sessions_goal_status_idx").on(table.goalId, table.status),
    turnIdx: index("v2_terminal_sessions_turn_idx").on(table.turnId),
    processIdx: index("v2_terminal_sessions_process_idx").on(table.processId),
    stateVersionCheck: check("v2_terminal_sessions_state_version_check", sql`${table.stateVersion} >= 0`),
  }),
)

export const v2TerminalOutputChunks = sqliteTable(
  "v2_terminal_output_chunks",
  {
    id: text("id").primaryKey(),
    terminalSessionId: text("terminal_session_id").notNull(),
    flowId: text("flow_id").notNull(),
    sequence: integer("sequence").notNull(),
    stream: text("stream").notNull(),
    text: text("text").notNull(),
    redacted: integer("redacted", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => ({
    terminalSequenceIdx: uniqueIndex("v2_terminal_output_chunks_terminal_sequence_idx").on(
      table.terminalSessionId,
      table.sequence,
    ),
    flowCreatedIdx: index("v2_terminal_output_chunks_flow_created_idx").on(table.flowId, table.createdAt),
    sequenceCheck: check("v2_terminal_output_chunks_sequence_check", sql`${table.sequence} >= 0`),
  }),
)

export const v2Errors = sqliteTable(
  "v2_errors",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
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
    flowCreatedIdx: index("v2_errors_flow_created_idx").on(table.flowId, table.createdAt),
    turnIdx: index("v2_errors_turn_idx").on(table.turnId),
    codeIdx: index("v2_errors_code_idx").on(table.code),
  }),
)

export const v2Artifacts = sqliteTable(
  "v2_artifacts",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id"),
    kind: text("kind").notNull(),
    path: text("path"),
    uri: text("uri"),
    contentHash: text("content_hash"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes"),
    createdAt: text("created_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    flowCreatedIdx: index("v2_artifacts_flow_created_idx").on(table.flowId, table.createdAt),
    goalCreatedIdx: index("v2_artifacts_goal_created_idx").on(table.goalId, table.createdAt),
    turnIdx: index("v2_artifacts_turn_idx").on(table.turnId),
    contentHashIdx: index("v2_artifacts_content_hash_idx").on(table.contentHash),
    sizeCheck: check("v2_artifacts_size_check", sql`${table.sizeBytes} IS NULL OR ${table.sizeBytes} >= 0`),
  }),
)

export const v2AgentTasks = sqliteTable(
  "v2_agent_tasks",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    rootTurnId: text("root_turn_id").notNull(),
    currentTurnId: text("current_turn_id").notNull(),
    status: text("status").notNull(),
    runtimeConfigJson: text("runtime_config_json").notNull(),
    waitingOnTerminalIdsJson: text("waiting_on_terminal_ids_json").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    completedAt: text("completed_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    flowStatusIdx: index("v2_agent_tasks_flow_status_idx").on(table.flowId, table.status),
    goalStatusIdx: index("v2_agent_tasks_goal_status_idx").on(table.goalId, table.status),
    currentTurnIdx: index("v2_agent_tasks_current_turn_idx").on(table.currentTurnId),
    rootTurnIdx: uniqueIndex("v2_agent_tasks_root_turn_idx").on(table.rootTurnId),
  }),
)

export const v2SpeechJobs = sqliteTable(
  "v2_speech_jobs",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id"),
    messageId: text("message_id"),
    kind: text("kind").notNull(),
    engine: text("engine").notNull(),
    modelId: text("model_id").notNull(),
    status: text("status").notNull(),
    inputArtifactId: text("input_artifact_id"),
    inputText: text("input_text"),
    outputArtifactId: text("output_artifact_id"),
    transcriptText: text("transcript_text"),
    voiceId: text("voice_id"),
    speed: real("speed"),
    language: text("language"),
    durationMs: integer("duration_ms"),
    errorId: text("error_id"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    flowStatusIdx: index("v2_speech_jobs_flow_status_idx").on(table.flowId, table.status),
    messageIdx: index("v2_speech_jobs_message_idx").on(table.messageId),
    turnIdx: index("v2_speech_jobs_turn_idx").on(table.turnId),
    engineModelIdx: index("v2_speech_jobs_engine_model_idx").on(table.engine, table.modelId),
    engineModelAllowlistCheck: check(
      "v2_speech_jobs_engine_model_allowlist_check",
      sql`(${table.kind} = 'transcription' AND ${table.engine} = 'local_whisper' AND ${table.modelId} IN ('base.en', 'small.en') AND ${table.inputArtifactId} IS NOT NULL AND ${table.inputText} IS NULL AND ${table.voiceId} IS NULL AND ${table.speed} IS NULL) OR (${table.kind} = 'transcription' AND ${table.engine} = 'openrouter' AND ${table.modelId} IN ('nvidia/parakeet-tdt-0.6b-v3', 'microsoft/mai-transcribe-1.5', 'mistralai/voxtral-mini-transcribe') AND ${table.inputArtifactId} IS NOT NULL AND ${table.inputText} IS NULL AND ${table.voiceId} IS NULL AND ${table.speed} IS NULL) OR (${table.kind} = 'synthesis' AND ${table.engine} = 'local_kokoro' AND ${table.modelId} = 'kokoro-82m' AND ${table.inputArtifactId} IS NULL AND ${table.inputText} IS NOT NULL AND ${table.voiceId} IS NOT NULL AND ${table.speed} BETWEEN 0.5 AND 2 AND ${table.transcriptText} IS NULL)`,
    ),
    durationCheck: check("v2_speech_jobs_duration_check", sql`${table.durationMs} IS NULL OR ${table.durationMs} >= 0`),
  }),
)

export const v2Feedback = sqliteTable(
  "v2_feedback",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id"),
    messageId: text("message_id").notNull(),
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
    messageIdx: uniqueIndex("v2_feedback_message_idx").on(table.messageId),
    flowCreatedIdx: index("v2_feedback_flow_created_idx").on(table.flowId, table.createdAt),
    goalCreatedIdx: index("v2_feedback_goal_created_idx").on(table.goalId, table.createdAt),
    targetIdx: index("v2_feedback_target_idx").on(table.turnId, table.modelCallId),
    ratingCheck: check("v2_feedback_rating_check", sql`${table.rating} IN ('thumbs_up', 'thumbs_down')`),
  }),
)

// Secret values are intentionally never persisted here. This table owns only
// the resumable request lifecycle and the non-secret MCP binding metadata.
export const v2CredentialInputRequests = sqliteTable(
  "v2_credential_input_requests",
  {
    id: text("id").primaryKey(),
    flowId: text("flow_id").notNull(),
    projectId: text("project_id").notNull(),
    goalId: text("goal_id"),
    turnId: text("turn_id").notNull(),
    toolCallId: text("tool_call_id").notNull(),
    providerToolCallId: text("provider_tool_call_id"),
    serverId: text("server_id").notNull(),
    serverLabel: text("server_label"),
    envKey: text("env_key").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    requestedAt: text("requested_at").notNull(),
    resolvedAt: text("resolved_at"),
    metadataJson: text("metadata_json"),
  },
  (table) => ({
    flowStatusIdx: index("v2_credential_input_requests_flow_status_idx").on(table.flowId, table.status),
    turnStatusIdx: index("v2_credential_input_requests_turn_status_idx").on(table.turnId, table.status),
    toolCallIdx: uniqueIndex("v2_credential_input_requests_tool_call_idx").on(table.toolCallId, table.envKey),
    statusCheck: check(
      "v2_credential_input_requests_status_check",
      sql`${table.status} IN ('pending', 'submitted', 'cancelled', 'expired')`,
    ),
    sourceCheck: check(
      "v2_credential_input_requests_source_check",
      sql`${table.source} IN ('user_input', 'workspace_env')`,
    ),
  }),
)
