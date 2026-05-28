import { z } from "zod"
import { apiErrorSchema } from "./api"
import { idSchema, messageSchema, timestampSchema } from "./entities"
import { providerIdSchema, thinkingEffortSchema } from "./models"
import { terminalStatusSchema, toolNameSchema } from "./tools"

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
    content: z.string(),
    attachmentIds: z.array(idSchema).max(12).optional(),
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
    text: z.string().optional(),
    key: z.enum(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Ctrl-C"]).optional(),
    submit: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.text === undefined && input.key === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "terminal input requires text or key",
      })
    }
  })

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
export const approvalDecideCommandSchema = socketEnvelopeSchema("approval.decide", approvalDecidePayloadSchema)
export const terminalStopCommandSchema = socketEnvelopeSchema("terminal.stop", terminalStopPayloadSchema)
export const terminalInputCommandSchema = socketEnvelopeSchema("terminal.input", terminalInputPayloadSchema)
export const terminalRenameCommandSchema = socketEnvelopeSchema("terminal.rename", terminalRenamePayloadSchema)
export const feedbackSubmitCommandSchema = socketEnvelopeSchema("feedback.submit", feedbackSubmitPayloadSchema)

export const clientCommandSchema = z.discriminatedUnion("type", [
  chatMessageSendCommandSchema,
  chatTurnCancelCommandSchema,
  approvalDecideCommandSchema,
  terminalStopCommandSchema,
  terminalInputCommandSchema,
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
    error: apiErrorSchema,
    modelCallId: idSchema.optional(),
    stepIndex: z.number().int().nonnegative().optional(),
  })
  .strict()

export const approvalRequestedPayloadSchema = z
  .object({
    approvalId: idSchema,
    toolCallId: idSchema.optional(),
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
  })
  .strict()

export const contextCompactionFailedPayloadSchema = z
  .object({
    snapshotId: idSchema.optional(),
    error: apiErrorSchema,
  })
  .strict()

export const modelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    reasoningTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  })
  .strict()

export const messageCompletedPayloadSchema = z
  .object({
    message: messageSchema,
    usage: modelUsageSchema.optional(),
  })
  .strict()

export const turnCompletedPayloadSchema = z
  .object({
    turnId: idSchema,
    assistantMessageId: idSchema.optional(),
    summary: z.string().optional(),
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

export const terminalOutputStreamSchema = z.enum(["stdout", "stderr", "log", "result", "input"])

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

export const terminalInputRequestedPayloadSchema = terminalEventPayloadBaseSchema
  .extend({
    prompt: z.string().optional(),
    secret: z.boolean().optional(),
  })
  .strict()

export const connectionReadyEventSchema = socketEnvelopeSchema("connection.ready", connectionReadyPayloadSchema)
export const turnStartedEventSchema = socketEnvelopeSchema("turn.started", turnStartedPayloadSchema)
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
export const messageCompletedEventSchema = socketEnvelopeSchema("message.completed", messageCompletedPayloadSchema)
export const turnCompletedEventSchema = socketEnvelopeSchema("turn.completed", turnCompletedPayloadSchema)
export const turnFailedEventSchema = socketEnvelopeSchema("turn.failed", turnFailedPayloadSchema)
export const turnCancelledEventSchema = socketEnvelopeSchema("turn.cancelled", turnCancelledPayloadSchema)
export const errorCreatedEventSchema = socketEnvelopeSchema("error.created", errorCreatedPayloadSchema)
export const terminalStartedEventSchema = socketEnvelopeSchema("terminal.started", terminalEventPayloadBaseSchema)
export const terminalOutputEventSchema = socketEnvelopeSchema("terminal.output", terminalOutputPayloadSchema)
export const terminalStatusEventSchema = socketEnvelopeSchema("terminal.status", terminalEventPayloadBaseSchema)
export const terminalInputRequestedEventSchema = socketEnvelopeSchema("terminal.input.requested", terminalInputRequestedPayloadSchema)
export const terminalCompletedEventSchema = socketEnvelopeSchema("terminal.completed", terminalEventPayloadBaseSchema)
export const terminalStoppedEventSchema = socketEnvelopeSchema("terminal.stopped", terminalEventPayloadBaseSchema)
export const terminalStaleEventSchema = socketEnvelopeSchema("terminal.stale", terminalEventPayloadBaseSchema)

export const serverEventSchema = z.discriminatedUnion("type", [
  connectionReadyEventSchema,
  turnStartedEventSchema,
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
  messageCompletedEventSchema,
  turnCompletedEventSchema,
  turnFailedEventSchema,
  turnCancelledEventSchema,
  errorCreatedEventSchema,
  terminalStartedEventSchema,
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
export type ApprovalDecidePayload = z.infer<typeof approvalDecidePayloadSchema>
export type TerminalStopPayload = z.infer<typeof terminalStopPayloadSchema>
export type TerminalInputPayload = z.infer<typeof terminalInputPayloadSchema>
export type TerminalRenamePayload = z.infer<typeof terminalRenamePayloadSchema>
export type FeedbackSubmitPayload = z.infer<typeof feedbackSubmitPayloadSchema>
export type ClientCommand = z.infer<typeof clientCommandSchema>
export type ServerEvent = z.infer<typeof serverEventSchema>
export type SocketMessage = z.infer<typeof socketMessageSchema>
