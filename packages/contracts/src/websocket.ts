import { z } from "zod"
import { apiErrorSchema } from "./api"
import { idSchema, messageSchema, timestampSchema } from "./entities"
import { providerIdSchema, thinkingEffortSchema } from "./models"
import { toolNameSchema } from "./tools"

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
    content: z.string().min(1),
    runtimeConfig: runtimeConfigSchema,
  })
  .strict()

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
export const feedbackSubmitCommandSchema = socketEnvelopeSchema("feedback.submit", feedbackSubmitPayloadSchema)

export const clientCommandSchema = z.discriminatedUnion("type", [
  chatMessageSendCommandSchema,
  chatTurnCancelCommandSchema,
  approvalDecideCommandSchema,
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
  })
  .strict()

export const agentAnswerDeltaPayloadSchema = z
  .object({
    messageId: idSchema,
    text: z.string(),
  })
  .strict()

export const toolCallCategorySchema = z.enum(["file", "search", "shell", "git", "patch", "resource", "trace", "other"])

export const toolCallStartedPayloadSchema = z
  .object({
    toolCallId: idSchema,
    toolName: toolNameSchema,
    category: toolCallCategorySchema,
    displayName: z.string().min(1),
    argsPreview: z.string().optional(),
    requiresApproval: z.boolean(),
  })
  .strict()

export const toolCallOutputPayloadSchema = z
  .object({
    toolCallId: idSchema,
    stream: z.enum(["stdout", "stderr", "log", "result"]),
    text: z.string().optional(),
    data: z.unknown().optional(),
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
  })
  .strict()

export const toolCallFailedPayloadSchema = z
  .object({
    toolCallId: idSchema,
    error: apiErrorSchema,
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
  })
  .strict()

export const errorCreatedPayloadSchema = z
  .object({
    error: apiErrorSchema,
    recoverable: z.boolean(),
  })
  .strict()

export const connectionReadyEventSchema = socketEnvelopeSchema("connection.ready", connectionReadyPayloadSchema)
export const turnStartedEventSchema = socketEnvelopeSchema("turn.started", turnStartedPayloadSchema)
export const agentThinkingDeltaEventSchema = socketEnvelopeSchema("agent.thinking.delta", agentThinkingDeltaPayloadSchema)
export const agentAnswerDeltaEventSchema = socketEnvelopeSchema("agent.answer.delta", agentAnswerDeltaPayloadSchema)
export const toolCallStartedEventSchema = socketEnvelopeSchema("tool.call.started", toolCallStartedPayloadSchema)
export const toolCallOutputEventSchema = socketEnvelopeSchema("tool.call.output", toolCallOutputPayloadSchema)
export const toolCallCompletedEventSchema = socketEnvelopeSchema("tool.call.completed", toolCallCompletedPayloadSchema)
export const toolCallFailedEventSchema = socketEnvelopeSchema("tool.call.failed", toolCallFailedPayloadSchema)
export const approvalRequestedEventSchema = socketEnvelopeSchema("approval.requested", approvalRequestedPayloadSchema)
export const approvalResolvedEventSchema = socketEnvelopeSchema("approval.resolved", approvalResolvedPayloadSchema)
export const contextUsageSnapshotEventSchema = socketEnvelopeSchema(
  "context.usage.snapshot",
  contextUsageSnapshotPayloadSchema,
)
export const messageCompletedEventSchema = socketEnvelopeSchema("message.completed", messageCompletedPayloadSchema)
export const turnCompletedEventSchema = socketEnvelopeSchema("turn.completed", turnCompletedPayloadSchema)
export const turnFailedEventSchema = socketEnvelopeSchema("turn.failed", turnFailedPayloadSchema)
export const turnCancelledEventSchema = socketEnvelopeSchema("turn.cancelled", turnCancelledPayloadSchema)
export const errorCreatedEventSchema = socketEnvelopeSchema("error.created", errorCreatedPayloadSchema)

export const serverEventSchema = z.discriminatedUnion("type", [
  connectionReadyEventSchema,
  turnStartedEventSchema,
  agentThinkingDeltaEventSchema,
  agentAnswerDeltaEventSchema,
  toolCallStartedEventSchema,
  toolCallOutputEventSchema,
  toolCallCompletedEventSchema,
  toolCallFailedEventSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  contextUsageSnapshotEventSchema,
  messageCompletedEventSchema,
  turnCompletedEventSchema,
  turnFailedEventSchema,
  turnCancelledEventSchema,
  errorCreatedEventSchema,
])

export const socketMessageSchema = z.union([clientCommandSchema, serverEventSchema])

export type SchemaVersion = z.infer<typeof schemaVersionSchema>
export type ActorRef = z.infer<typeof actorRefSchema>
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>
export type ModelUsage = z.infer<typeof modelUsageSchema>
export type ChatMessageSendPayload = z.infer<typeof chatMessageSendPayloadSchema>
export type ChatTurnCancelPayload = z.infer<typeof chatTurnCancelPayloadSchema>
export type ApprovalDecidePayload = z.infer<typeof approvalDecidePayloadSchema>
export type FeedbackSubmitPayload = z.infer<typeof feedbackSubmitPayloadSchema>
export type ClientCommand = z.infer<typeof clientCommandSchema>
export type ServerEvent = z.infer<typeof serverEventSchema>
export type SocketMessage = z.infer<typeof socketMessageSchema>
