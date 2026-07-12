import { z } from "zod"
import { apiErrorSchema } from "./api"
import { conversationSchema, idSchema, messageSchema, notificationSchema, timestampSchema } from "./entities"
import { memoryAgentSignalSnapshotSchema } from "./http"
import { providerAuthModeSchema, providerIdSchema, thinkingEffortSchema, turnUsageReportSchema } from "./models"
import { memoryNoteImportanceSchema, skillScopeSchema, terminalStatusSchema, toolNameSchema } from "./tools"
import { MAX_INLINE_MESSAGE_CHARS, MAX_MESSAGE_ATTACHMENTS } from "./attachments"

export const schemaVersionSchema = z.literal(1)

export const actorTypeSchema = z.enum([
  "user",
  "main_agent",
  "planner",
  "worker",
  "sub_agent",
  "tool",
  "system",
])

export const actorRefSchema = z
  .object({
    type: actorTypeSchema,
    id: idSchema.optional(),
    parentId: idSchema.optional(),
    label: z.string().min(1).optional(),
  })
  .strict()

const socketEnvelopeBaseShape = {
  id: idSchema,
  schemaVersion: schemaVersionSchema,
  timestamp: timestampSchema,
  projectId: idSchema.optional(),
  conversationId: idSchema.optional(),
  sessionId: idSchema.optional(),
  turnId: idSchema.optional(),
  actor: actorRefSchema.optional(),
}

export const socketEnvelopeSchema = <TType extends string, TPayload extends z.ZodTypeAny>(
  type: TType,
  payloadSchema: TPayload,
) =>
  z
    .object({
      ...socketEnvelopeBaseShape,
      type: z.literal(type),
      payload: payloadSchema,
    })
    .strict()

export const runtimeConfigSchema = z
  .object({
    providerId: providerIdSchema,
    authMode: providerAuthModeSchema.optional(),
    modelId: z.string().min(1),
    thinkingEnabled: z.boolean(),
    thinkingEffort: thinkingEffortSchema.optional(),
    approvalMode: z.enum(["manual", "approve_all", "read_only_auto"]),
    sandboxMode: z.enum(["read_only", "workspace_write", "danger_full_access"]),
  })
  .strict()

export const chatMessageSendPayloadSchema = z
  .object({
    clientMessageId: idSchema,
    content: z.string().max(MAX_INLINE_MESSAGE_CHARS),
    attachmentIds: z.array(idSchema).max(MAX_MESSAGE_ATTACHMENTS).optional(),
    runtimeConfig: runtimeConfigSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.content.trim() && (input.attachmentIds ?? []).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "content is required unless at least one attachment is present",
      })
    }
  })

export const chatTurnCancelPayloadSchema = z
  .object({
    turnId: idSchema,
    reason: z.string().optional(),
  })
  .strict()

export const chatConversationSubscribePayloadSchema = z
  .object({
    replayActiveTurn: z.boolean().optional(),
  })
  .strict()

export const chatConversationUnsubscribePayloadSchema = z.object({}).strict()

export const approvalDecidePayloadSchema = z
  .object({
    approvalId: idSchema,
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().optional(),
  })
  .strict()

export const terminalStopPayloadSchema = z
  .object({
    terminalId: idSchema,
    reason: z.string().optional(),
  })
  .strict()

export const terminalInputPayloadSchema = z
  .object({
    terminalId: idSchema,
    data: z.string().optional(),
    text: z.string().optional(),
    key: z.enum(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Ctrl-C"]).optional(),
    submit: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.data === undefined && input.text === undefined && input.key === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
        message: "terminal input requires data, text, or key",
      })
    }
  })

export const terminalResizePayloadSchema = z
  .object({
    terminalId: idSchema,
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(500),
  })
  .strict()

export const terminalRenamePayloadSchema = z
  .object({
    terminalId: idSchema,
    name: z.string().min(1),
  })
  .strict()

export const feedbackSubmitPayloadSchema = z
  .object({
    messageId: idSchema,
    turnId: idSchema.optional(),
    modelCallId: idSchema.optional(),
    rating: z.enum(["thumbs_up", "thumbs_down"]),
    reasonCode: z.string().min(1).optional(),
    note: z.string().optional(),
  })
  .strict()

export const chatMessageSendCommandSchema = socketEnvelopeSchema("chat.message.send", chatMessageSendPayloadSchema)
export const chatTurnCancelCommandSchema = socketEnvelopeSchema("chat.turn.cancel", chatTurnCancelPayloadSchema)
export const chatConversationSubscribeCommandSchema = socketEnvelopeSchema(
  "chat.conversation.subscribe",
  chatConversationSubscribePayloadSchema,
)
export const chatConversationUnsubscribeCommandSchema = socketEnvelopeSchema(
  "chat.conversation.unsubscribe",
  chatConversationUnsubscribePayloadSchema,
)
export const approvalDecideCommandSchema = socketEnvelopeSchema("approval.decide", approvalDecidePayloadSchema)
export const terminalStopCommandSchema = socketEnvelopeSchema("terminal.stop", terminalStopPayloadSchema)
export const terminalInputCommandSchema = socketEnvelopeSchema("terminal.input", terminalInputPayloadSchema)
export const terminalResizeCommandSchema = socketEnvelopeSchema("terminal.resize", terminalResizePayloadSchema)
export const terminalRenameCommandSchema = socketEnvelopeSchema("terminal.rename", terminalRenamePayloadSchema)
export const feedbackSubmitCommandSchema = socketEnvelopeSchema("feedback.submit", feedbackSubmitPayloadSchema)

export const clientCommandSchema = z.discriminatedUnion("type", [
  chatMessageSendCommandSchema,
  chatTurnCancelCommandSchema,
  chatConversationSubscribeCommandSchema,
  chatConversationUnsubscribeCommandSchema,
  approvalDecideCommandSchema,
  terminalStopCommandSchema,
  terminalInputCommandSchema,
  terminalResizeCommandSchema,
  terminalRenameCommandSchema,
  feedbackSubmitCommandSchema,
])

export const connectionReadyPayloadSchema = z
  .object({
    connectionId: idSchema,
    serverTime: timestampSchema,
  })
  .strict()

export const turnStartedPayloadSchema = z
  .object({
    turnId: idSchema,
    userMessage: messageSchema,
  })
  .strict()

export const turnWaitingPayloadSchema = z
  .object({
    turnId: idSchema,
    terminalNames: z.array(z.string().min(1).max(96)).min(1).max(8),
    wakeOn: z.array(z.enum(["completed", "failed", "input_required"])).min(1).max(3),
    reason: z.string().min(1).max(64),
  })
  .strict()

export const turnResumedPayloadSchema = z
  .object({
    turnId: idSchema,
    resumedFromTurnId: idSchema,
    terminalName: z.string().min(1).max(96),
    wakeEvent: z.enum(["completed", "failed", "input_required"]),
  })
  .strict()

export const conversationUpdatedPayloadSchema = z
  .object({
    conversation: conversationSchema,
  })
  .strict()

export const agentThinkingDeltaPayloadSchema = z
  .object({
    text: z.string(),
    modelCallId: idSchema.optional(),
    stepIndex: z.number().int().nonnegative().optional(),
  })
  .strict()

export const agentAnswerDeltaPayloadSchema = z
  .object({
    messageId: idSchema,
    text: z.string(),
    modelCallId: idSchema.optional(),
    stepIndex: z.number().int().nonnegative().optional(),
  })
  .strict()

export const toolCallCategorySchema = z.enum(["file", "search", "shell", "git", "patch", "resource", "trace", "mcp", "other"])

export const toolCallStartedPayloadSchema = z
  .object({
    toolCallId: idSchema,
    providerToolCallId: z.string().min(1).optional(),
    toolName: toolNameSchema,
    category: toolCallCategorySchema,
    displayName: z.string().min(1),
    argsPreview: z.string().optional(),
    requiresApproval: z.boolean(),
    modelCallId: idSchema.optional(),
    stepIndex: z.number().int().nonnegative().optional(),
  })
  .strict()

export const toolCallStreamingPayloadSchema = z
  .object({
    toolCallId: idSchema,
    providerToolCallId: z.string().min(1).optional(),
    toolName: toolNameSchema,
    category: toolCallCategorySchema,
    displayName: z.string().min(1),
    argsPreview: z.string().optional(),
    pathPreview: z.string().optional(),
    modelCallId: idSchema.optional(),
    stepIndex: z.number().int().nonnegative().optional(),
  })
  .strict()

export const toolCallOutputPayloadSchema = z
  .object({
    toolCallId: idSchema,
    providerToolCallId: z.string().min(1).optional(),
    stream: z.enum(["stdout", "stderr", "log", "result"]),
    text: z.string().optional(),
    data: z.unknown().optional(),
    modelCallId: idSchema.optional(),
    stepIndex: z.number().int().nonnegative().optional(),
  })
  .strict()

export const toolCallMetricsSchema = z
  .object({
    filesRead: z.number().int().nonnegative().optional(),
    filesEdited: z.number().int().nonnegative().optional(),
    commandsRun: z.number().int().nonnegative().optional(),
    searchesRun: z.number().int().nonnegative().optional(),
  })
  .strict()

export const toolCallCompletedPayloadSchema = z
  .object({
    toolCallId: idSchema,
    providerToolCallId: z.string().min(1).optional(),
    summary: z.string().min(1),
    resultPreview: z.string().optional(),
    metrics: toolCallMetricsSchema.optional(),
    durationMs: z.number().int().nonnegative().optional(),
    modelCallId: idSchema.optional(),
    stepIndex: z.number().int().nonnegative().optional(),
  })
  .strict()

export const toolCallFailedPayloadSchema = z
  .object({
    toolCallId: idSchema,
    providerToolCallId: z.string().min(1).optional(),
    error: apiErrorSchema,
    modelCallId: idSchema.optional(),
    stepIndex: z.number().int().nonnegative().optional(),
  })
  .strict()

export const approvalRequestedPayloadSchema = z
  .object({
    approvalId: idSchema,
    toolCallId: idSchema.optional(),
    providerToolCallId: z.string().min(1).optional(),
    actionKind: z.enum(["shell_command", "file_write", "patch_apply", "git_commit", "git_push", "other"]),
    title: z.string().min(1),
    description: z.string().optional(),
    actionPreview: z.string(),
    risk: z.enum(["low", "medium", "high"]),
  })
  .strict()

export const approvalResolvedPayloadSchema = z
  .object({
    approvalId: idSchema,
    toolCallId: idSchema.optional(),
    providerToolCallId: z.string().min(1).optional(),
    decision: z.enum(["approved", "rejected"]),
  })
  .strict()

export const contextUsageSnapshotPayloadSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    contextWindowTokens: z.number().int().nonnegative(),
    contextUsedTokens: z.number().int().nonnegative(),
    contextLeftTokens: z.number().int().nonnegative(),
    contextUsedPercent: z.number().min(0).max(100),
  })
  .strict()

export const contextCompactionStartedPayloadSchema = z
  .object({
    snapshotId: idSchema,
    reason: z.enum(["precompute", "threshold", "emergency", "manual"]),
    contextUsedTokensEstimate: z.number().int().nonnegative(),
    targetTokens: z.number().int().positive(),
  })
  .strict()

export const contextCompactionCompletedPayloadSchema = z
  .object({
    snapshotId: idSchema,
    inputTokensEstimate: z.number().int().nonnegative(),
    outputTokensEstimate: z.number().int().nonnegative(),
    contextUsedTokensEstimate: z.number().int().nonnegative(),
    // Optional only for replay compatibility with snapshots created before size classes existed.
    sizeClass: z.enum(["excellent", "preferred", "acceptable"]).optional(),
  })
  .strict()

export const contextCompactionFailedPayloadSchema = z
  .object({
    snapshotId: idSchema.optional(),
    error: apiErrorSchema,
  })
  .strict()

export const memoryAgentStartedPayloadSchema = z
  .object({
    jobId: idSchema,
    trigger: z.enum(["scheduled", "manual"]),
    sequenceFrom: z.number().int().positive().optional(),
    sequenceTo: z.number().int().nonnegative().optional(),
    evidenceTokensEstimate: z.number().int().nonnegative(),
  })
  .strict()

export const memoryAgentCompletedPayloadSchema = z
  .object({
    jobId: idSchema,
    status: z.enum(["completed"]),
    providerId: providerIdSchema,
    modelId: z.string().min(1),
    sequenceFrom: z.number().int().positive().optional(),
    sequenceTo: z.number().int().nonnegative().optional(),
  })
  .strict()

export const memoryAgentFailedPayloadSchema = z
  .object({
    jobId: idSchema.optional(),
    error: apiErrorSchema,
  })
  .strict()

export const memoryAgentCheckedPayloadSchema = z
  .object({
    checkId: idSchema,
    trigger: z.enum(["scheduled", "manual"]),
    status: z.enum(["skipped"]),
    reason: z.string().min(1),
    pending: memoryAgentSignalSnapshotSchema,
    checkedAt: z.string().min(1),
  })
  .strict()

export const memoryPrimaryUpdatedPayloadSchema = z
  .object({
    jobId: idSchema,
    actionId: idSchema,
    path: z.string().min(1),
    targetKind: z.enum(["tool_usage", "skills", "user_profile"]),
    rationale: z.string().min(1).optional(),
  })
  .strict()

export const memoryNoteCreatedPayloadSchema = z
  .object({
    noteNumber: z.number().int().positive(),
    importance: memoryNoteImportanceSchema,
    defaultSkillScope: skillScopeSchema.optional(),
  })
  .strict()

export const memoryNoteCompletedPayloadSchema = z
  .object({
    noteNumber: z.number().int().positive(),
  })
  .strict()

export const memorySkillProposalPayloadSchema = z
  .object({
    jobId: idSchema.optional(),
    actionId: idSchema,
    notificationId: idSchema.optional(),
    scope: z.enum(["global", "project"]),
    operation: z.enum(["create", "update"]),
    skillName: z.string().min(1),
    skillTitle: z.string().min(1).optional(),
    projectId: idSchema.optional(),
    path: z.string().min(1).optional(),
  })
  .strict()

export const memorySkillUpdatedPayloadSchema = z
  .object({
    jobId: idSchema,
    scope: z.enum(["global", "project"]),
    operation: z.enum(["create", "update"]),
    skillName: z.string().min(1),
    path: z.string().min(1),
    sourceKind: z.string().min(1),
    sourceId: idSchema.optional(),
  })
  .strict()

export const memorySkillWriterStartedPayloadSchema = z
  .object({
    jobId: idSchema,
    scope: skillScopeSchema,
    operation: z.enum(["create", "update"]),
    skillName: z.string().min(1),
    sourceKind: z.string().min(1),
    sourceId: idSchema.optional(),
  })
  .strict()

export const memorySkillWriterFailedPayloadSchema = z
  .object({
    jobId: idSchema,
    scope: skillScopeSchema,
    operation: z.enum(["create", "update"]),
    skillName: z.string().min(1),
    error: apiErrorSchema,
  })
  .strict()

export const memorySoulConfirmationRequestedPayloadSchema = z
  .object({
    jobId: idSchema,
    actionId: idSchema,
    confirmationId: idSchema,
    document: z.literal("identity"),
    prompt: z.string().min(1),
  })
  .strict()

export const memorySoulConfirmationResolvedPayloadSchema = z
  .object({
    jobId: idSchema,
    actionId: idSchema,
    confirmationId: idSchema,
    document: z.literal("identity"),
    decision: z.enum(["yes", "no", "invalid"]),
  })
  .strict()

export const memorySoulUpdatedPayloadSchema = z
  .object({
    jobId: idSchema,
    actionId: idSchema,
    confirmationId: idSchema,
    document: z.literal("identity"),
    path: z.string().min(1),
    notificationId: idSchema,
    rationale: z.string().min(1).optional(),
  })
  .strict()

export const notificationCreatedPayloadSchema = z
  .object({
    notification: notificationSchema,
  })
  .strict()

export const notificationReadPayloadSchema = z
  .object({
    notificationId: idSchema,
    unreadCount: z.number().int().nonnegative(),
  })
  .strict()

export const modelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    uncachedInputTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    costSource: z.enum(["provider_reported", "computed", "unknown"]).optional(),
  })
  .strict()

export const messageCompletedPayloadSchema = z
  .object({
    message: messageSchema,
    usage: modelUsageSchema.optional(),
    turnUsageReport: turnUsageReportSchema.optional(),
  })
  .strict()

export const turnCompletedPayloadSchema = z
  .object({
    turnId: idSchema,
    assistantMessageId: idSchema.optional(),
    summary: z.string().optional(),
    turnUsageReport: turnUsageReportSchema.optional(),
  })
  .strict()

export const turnFailedPayloadSchema = z
  .object({
    turnId: idSchema,
    error: apiErrorSchema,
  })
  .strict()

export const turnCancelledPayloadSchema = z
  .object({
    turnId: idSchema,
    reason: z.string().optional(),
    partialAssistantMessage: messageSchema.optional(),
  })
  .strict()

export const errorCreatedPayloadSchema = z
  .object({
    error: apiErrorSchema,
    recoverable: z.boolean(),
  })
  .strict()

export const terminalOutputStreamSchema = z.enum(["stdout", "stderr", "log", "result", "input", "pty"])

export const terminalEventPayloadBaseSchema = z
  .object({
    terminalId: idSchema,
    name: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1),
    workspacePath: z.string().min(1),
    status: terminalStatusSchema,
    platform: z.string().min(1).optional(),
    shellKind: z.enum(["posix", "powershell", "cmd"]).optional(),
    shellExecutable: z.string().min(1).optional(),
    processId: z.string().min(1).optional(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    autoDetached: z.boolean(),
    awaitingInput: z.boolean(),
    stateVersion: z.number().int().nonnegative().optional(),
    lastPrompt: z.string().optional(),
    nextOutputSequence: z.number().int().nonnegative().optional(),
    startedAt: z.string().min(1),
    updatedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),
  })
  .strict()

export const terminalOutputPayloadSchema = terminalEventPayloadBaseSchema
  .extend({
    stream: terminalOutputStreamSchema,
    text: z.string(),
    sequence: z.number().int().nonnegative().optional(),
    redacted: z.boolean().optional(),
  })
  .strict()

export const terminalDataPayloadSchema = terminalOutputPayloadSchema

export const terminalInputRequestedPayloadSchema = terminalEventPayloadBaseSchema
  .extend({
    prompt: z.string().optional(),
    secret: z.boolean().optional(),
  })
  .strict()

export const connectionReadyEventSchema = socketEnvelopeSchema("connection.ready", connectionReadyPayloadSchema)
export const turnStartedEventSchema = socketEnvelopeSchema("turn.started", turnStartedPayloadSchema)
export const turnWaitingEventSchema = socketEnvelopeSchema("turn.waiting", turnWaitingPayloadSchema)
export const turnResumedEventSchema = socketEnvelopeSchema("turn.resumed", turnResumedPayloadSchema)
export const conversationUpdatedEventSchema = socketEnvelopeSchema("conversation.updated", conversationUpdatedPayloadSchema)
export const agentThinkingDeltaEventSchema = socketEnvelopeSchema("agent.thinking.delta", agentThinkingDeltaPayloadSchema)
export const agentAnswerDeltaEventSchema = socketEnvelopeSchema("agent.answer.delta", agentAnswerDeltaPayloadSchema)
export const toolCallStartedEventSchema = socketEnvelopeSchema("tool.call.started", toolCallStartedPayloadSchema)
export const toolCallStreamingEventSchema = socketEnvelopeSchema("tool.call.streaming", toolCallStreamingPayloadSchema)
export const toolCallOutputEventSchema = socketEnvelopeSchema("tool.call.output", toolCallOutputPayloadSchema)
export const toolCallCompletedEventSchema = socketEnvelopeSchema("tool.call.completed", toolCallCompletedPayloadSchema)
export const toolCallFailedEventSchema = socketEnvelopeSchema("tool.call.failed", toolCallFailedPayloadSchema)
export const approvalRequestedEventSchema = socketEnvelopeSchema("approval.requested", approvalRequestedPayloadSchema)
export const approvalResolvedEventSchema = socketEnvelopeSchema("approval.resolved", approvalResolvedPayloadSchema)
export const contextUsageSnapshotEventSchema = socketEnvelopeSchema(
  "context.usage.snapshot",
  contextUsageSnapshotPayloadSchema,
)
export const contextCompactionStartedEventSchema = socketEnvelopeSchema(
  "context.compaction.started",
  contextCompactionStartedPayloadSchema,
)
export const contextCompactionCompletedEventSchema = socketEnvelopeSchema(
  "context.compaction.completed",
  contextCompactionCompletedPayloadSchema,
)
export const contextCompactionFailedEventSchema = socketEnvelopeSchema(
  "context.compaction.failed",
  contextCompactionFailedPayloadSchema,
)
export const memoryAgentStartedEventSchema = socketEnvelopeSchema("memory.agent.started", memoryAgentStartedPayloadSchema)
export const memoryAgentCompletedEventSchema = socketEnvelopeSchema("memory.agent.completed", memoryAgentCompletedPayloadSchema)
export const memoryAgentFailedEventSchema = socketEnvelopeSchema("memory.agent.failed", memoryAgentFailedPayloadSchema)
export const memoryAgentCheckedEventSchema = socketEnvelopeSchema("memory.agent.checked", memoryAgentCheckedPayloadSchema)
export const memoryPrimaryUpdatedEventSchema = socketEnvelopeSchema("memory.primary.updated", memoryPrimaryUpdatedPayloadSchema)
export const memoryNoteCreatedEventSchema = socketEnvelopeSchema("memory.note.created", memoryNoteCreatedPayloadSchema)
export const memoryNoteCompletedEventSchema = socketEnvelopeSchema("memory.note.completed", memoryNoteCompletedPayloadSchema)
export const memorySkillProposedEventSchema = socketEnvelopeSchema("memory.skill.proposed", memorySkillProposalPayloadSchema)
export const memorySkillApprovedEventSchema = socketEnvelopeSchema("memory.skill.approved", memorySkillProposalPayloadSchema)
export const memorySkillUpdatedEventSchema = socketEnvelopeSchema("memory.skill.updated", memorySkillUpdatedPayloadSchema)
export const memorySkillWriterStartedEventSchema = socketEnvelopeSchema("memory.skill_writer.started", memorySkillWriterStartedPayloadSchema)
export const memorySkillWriterFailedEventSchema = socketEnvelopeSchema("memory.skill_writer.failed", memorySkillWriterFailedPayloadSchema)
export const memorySoulConfirmationRequestedEventSchema = socketEnvelopeSchema(
  "memory.soul.confirmation.requested",
  memorySoulConfirmationRequestedPayloadSchema,
)
export const memorySoulConfirmationResolvedEventSchema = socketEnvelopeSchema(
  "memory.soul.confirmation.resolved",
  memorySoulConfirmationResolvedPayloadSchema,
)
export const memorySoulUpdatedEventSchema = socketEnvelopeSchema("memory.soul.updated", memorySoulUpdatedPayloadSchema)
export const notificationCreatedEventSchema = socketEnvelopeSchema("notification.created", notificationCreatedPayloadSchema)
export const notificationReadEventSchema = socketEnvelopeSchema("notification.read", notificationReadPayloadSchema)
export const messageCompletedEventSchema = socketEnvelopeSchema("message.completed", messageCompletedPayloadSchema)
export const turnCompletedEventSchema = socketEnvelopeSchema("turn.completed", turnCompletedPayloadSchema)
export const turnFailedEventSchema = socketEnvelopeSchema("turn.failed", turnFailedPayloadSchema)
export const turnCancelledEventSchema = socketEnvelopeSchema("turn.cancelled", turnCancelledPayloadSchema)
export const errorCreatedEventSchema = socketEnvelopeSchema("error.created", errorCreatedPayloadSchema)
export const terminalStartedEventSchema = socketEnvelopeSchema("terminal.started", terminalEventPayloadBaseSchema)
export const terminalDataEventSchema = socketEnvelopeSchema("terminal.data", terminalDataPayloadSchema)
export const terminalOutputEventSchema = socketEnvelopeSchema("terminal.output", terminalOutputPayloadSchema)
export const terminalStatusEventSchema = socketEnvelopeSchema("terminal.status", terminalEventPayloadBaseSchema)
export const terminalInputRequestedEventSchema = socketEnvelopeSchema("terminal.input.requested", terminalInputRequestedPayloadSchema)
export const terminalCompletedEventSchema = socketEnvelopeSchema("terminal.completed", terminalEventPayloadBaseSchema)
export const terminalStoppedEventSchema = socketEnvelopeSchema("terminal.stopped", terminalEventPayloadBaseSchema)
export const terminalStaleEventSchema = socketEnvelopeSchema("terminal.stale", terminalEventPayloadBaseSchema)

export const serverEventSchema = z.discriminatedUnion("type", [
  connectionReadyEventSchema,
  turnStartedEventSchema,
  turnWaitingEventSchema,
  turnResumedEventSchema,
  conversationUpdatedEventSchema,
  agentThinkingDeltaEventSchema,
  agentAnswerDeltaEventSchema,
  toolCallStartedEventSchema,
  toolCallStreamingEventSchema,
  toolCallOutputEventSchema,
  toolCallCompletedEventSchema,
  toolCallFailedEventSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  contextUsageSnapshotEventSchema,
  contextCompactionStartedEventSchema,
  contextCompactionCompletedEventSchema,
  contextCompactionFailedEventSchema,
  memoryAgentStartedEventSchema,
  memoryAgentCompletedEventSchema,
  memoryAgentFailedEventSchema,
  memoryAgentCheckedEventSchema,
  memoryPrimaryUpdatedEventSchema,
  memoryNoteCreatedEventSchema,
  memoryNoteCompletedEventSchema,
  memorySkillProposedEventSchema,
  memorySkillApprovedEventSchema,
  memorySkillUpdatedEventSchema,
  memorySkillWriterStartedEventSchema,
  memorySkillWriterFailedEventSchema,
  memorySoulConfirmationRequestedEventSchema,
  memorySoulConfirmationResolvedEventSchema,
  memorySoulUpdatedEventSchema,
  notificationCreatedEventSchema,
  notificationReadEventSchema,
  messageCompletedEventSchema,
  turnCompletedEventSchema,
  turnFailedEventSchema,
  turnCancelledEventSchema,
  errorCreatedEventSchema,
  terminalStartedEventSchema,
  terminalDataEventSchema,
  terminalOutputEventSchema,
  terminalStatusEventSchema,
  terminalInputRequestedEventSchema,
  terminalCompletedEventSchema,
  terminalStoppedEventSchema,
  terminalStaleEventSchema,
])

export const socketMessageSchema = z.union([clientCommandSchema, serverEventSchema])

export type SchemaVersion = z.infer<typeof schemaVersionSchema>
export type ActorRef = z.infer<typeof actorRefSchema>
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>
export type ModelUsage = z.infer<typeof modelUsageSchema>
export type ChatMessageSendPayload = z.infer<typeof chatMessageSendPayloadSchema>
export type ChatTurnCancelPayload = z.infer<typeof chatTurnCancelPayloadSchema>
export type ChatConversationSubscribePayload = z.infer<typeof chatConversationSubscribePayloadSchema>
export type ChatConversationUnsubscribePayload = z.infer<typeof chatConversationUnsubscribePayloadSchema>
export type ApprovalDecidePayload = z.infer<typeof approvalDecidePayloadSchema>
export type TerminalStopPayload = z.infer<typeof terminalStopPayloadSchema>
export type TerminalInputPayload = z.infer<typeof terminalInputPayloadSchema>
export type TerminalResizePayload = z.infer<typeof terminalResizePayloadSchema>
export type TerminalRenamePayload = z.infer<typeof terminalRenamePayloadSchema>
export type FeedbackSubmitPayload = z.infer<typeof feedbackSubmitPayloadSchema>
export type ClientCommand = z.infer<typeof clientCommandSchema>
export type ServerEvent = z.infer<typeof serverEventSchema>
export type SocketMessage = z.infer<typeof socketMessageSchema>
