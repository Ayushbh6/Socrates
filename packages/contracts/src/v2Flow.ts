import { z } from "zod"
import { MAX_INLINE_MESSAGE_CHARS, MAX_MESSAGE_ATTACHMENTS } from "./attachments"
import { apiErrorSchema } from "./api"
import { idSchema, timestampSchema } from "./entities"
import { providerAuthModeSchema, providerIdSchema, thinkingEffortSchema } from "./models"

/**
 * V2 Flow is intentionally a standalone contract surface.
 *
 * Nothing in this file is added to the V1 HTTP or socket unions. Consumers must
 * opt into these `v2.*` schemas explicitly, which keeps Classic conversations
 * wire-compatible and prevents a V2 payload from being accepted accidentally by
 * a V1 handler.
 */

export const V2_FLOW_SCHEMA_VERSION = 2 as const
export const V2_CONTEXT_UNRESOLVED_MAX_AGE_TURNS = 3 as const
export const V2_CONTEXT_UNRESOLVED_MAX_ITEMS = 5 as const

export const V2_OPENROUTER_STT_MODEL_IDS = [
  "nvidia/parakeet-tdt-0.6b-v3",
  "microsoft/mai-transcribe-1.5",
  "mistralai/voxtral-mini-transcribe",
] as const

export const V2_LOCAL_WHISPER_MODEL_IDS = ["base.en", "small.en"] as const
export const V2_LOCAL_KOKORO_MODEL_ID = "kokoro-82m" as const

export const v2FlowSchemaVersionSchema = z.literal(V2_FLOW_SCHEMA_VERSION)

export const v2FlowStatusSchema = z.enum(["active", "suspended", "archived"])

export const v2FlowSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    status: v2FlowStatusSchema,
    foregroundGoalId: idSchema.optional(),
    revision: z.number().int().nonnegative(),
    lastEventSequence: z.number().int().nonnegative(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    archivedAt: timestampSchema.optional(),
  })
  .strict()

export const v2GoalStatusSchema = z.enum(["foreground", "parked", "blocked", "completed", "discarded", "archived"])
export const v2GoalOriginSchema = z.enum(["router", "user", "recovery", "system"])
export const v2GoalKindSchema = z.enum(["general", "work"])

export const v2GoalSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    ordinal: z.number().int().positive(),
    title: z.string().min(1).max(200),
    summary: z.string().max(20_000).optional(),
    kind: v2GoalKindSchema,
    status: v2GoalStatusSchema,
    origin: v2GoalOriginSchema,
    priority: z.number().int().min(0).max(100),
    pinned: z.boolean(),
    lastActiveAt: timestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    archivedAt: timestampSchema.optional(),
  })
  .strict()

export const v2GoalTransitionReasonSchema = z.enum([
  "created",
  "router_decision",
  "user_intent",
  "focus_switch",
  "blocked",
  "resumed",
  "completed",
  "discarded",
  "archived",
  "reopened",
  "auto_archived",
  "recovery",
])

export const v2GoalTransitionSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    goalId: idSchema,
    turnId: idSchema.optional(),
    routingRunId: idSchema.optional(),
    fromStatus: v2GoalStatusSchema.nullable(),
    toStatus: v2GoalStatusSchema,
    reason: v2GoalTransitionReasonSchema,
    note: z.string().max(2_000).optional(),
    sequence: z.number().int().positive(),
    createdAt: timestampSchema,
  })
  .strict()

export const v2GoalRoutingDecisionSchema = z.enum([
  "continue_foreground",
  "resume_parked",
  "create_goal",
  "clarify",
])
export const v2GoalRoutingStatusSchema = z.enum(["running", "awaiting_clarification", "completed", "failed", "fallback"])

export const v2GoalRouterOutputSchema = z
  .object({
    action: z.enum(["use", "create", "clarify"]),
    candidates: z.array(z.number().int().min(1).max(5)).max(5),
    title: z.string().min(1).max(200).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const candidates = [...new Set(value.candidates)]
    if (candidates.length !== value.candidates.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates"], message: "Candidate numbers must be unique." })
    }
    if (value.action === "use" && (candidates.length !== 1 || value.title !== null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates"], message: "Use requires one candidate and a null title." })
    }
    if (value.action === "create" && (candidates.length !== 0 || !value.title?.trim())) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["title"], message: "Create requires a short title and no candidates." })
    }
    if (value.action === "clarify" && (candidates.length < 2 || value.title !== null)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates"], message: "Clarify requires two to five candidates and a null title." })
    }
  })
export type V2GoalRouterOutput = z.infer<typeof v2GoalRouterOutputSchema>

export const v2GoalRoutingRunSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    turnId: idSchema,
    messageId: idSchema,
    foregroundGoalId: idSchema.optional(),
    candidateGoalIds: z.array(idSchema).max(32),
    selectedGoalId: idSchema.optional(),
    decision: v2GoalRoutingDecisionSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    rationale: z.string().max(4_000).optional(),
    clarificationQuestion: z.string().min(1).max(1_000).optional(),
    clarificationCandidateGoalIds: z.array(idSchema).max(5),
    clarificationAnswerMessageId: idSchema.optional(),
    providerId: providerIdSchema.optional(),
    modelId: z.string().min(1).optional(),
    status: v2GoalRoutingStatusSchema,
    fallbackReason: z.string().max(2_000).optional(),
    startedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === "completed" || value.status === "fallback") && !value.decision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision"],
        message: "A completed or fallback routing run requires a decision.",
      })
    }
    if (value.status === "awaiting_clarification" && (value.decision !== "clarify" || !value.clarificationQuestion || value.clarificationCandidateGoalIds.length < 2)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clarificationQuestion"],
        message: "A clarification routing run requires a question and at least two plausible focus candidates.",
      })
    }
    if (value.decision && value.decision !== "clarify" && !value.selectedGoalId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedGoalId"],
        message: "A non-clarification routing decision requires a selected goal.",
      })
    }
  })

export const v2GoalCapsuleStatusSchema = z.enum(["active", "superseded", "final"])

export const v2GoalCapsuleSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    goalId: idSchema,
    version: z.number().int().positive(),
    status: v2GoalCapsuleStatusSchema,
    summary: z.string().min(1).max(30_000),
    decisions: z.array(z.string().min(1).max(4_000)).max(100),
    openQuestions: z.array(z.string().min(1).max(4_000)).max(100),
    nextActions: z.array(z.string().min(1).max(4_000)).max(100),
    evidenceHandles: z.array(z.string().min(1).max(512)).max(500),
    sourceThroughSequence: z.number().int().nonnegative(),
    tokenEstimate: z.number().int().nonnegative(),
    createdByTurnId: idSchema.optional(),
    createdAt: timestampSchema,
  })
  .strict()

export const v2GoalMessageRelationSchema = z.enum(["primary", "context", "reference"])

export const v2GoalMessageLinkSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    goalId: idSchema,
    messageId: idSchema,
    turnId: idSchema.optional(),
    relation: v2GoalMessageRelationSchema,
    createdAt: timestampSchema,
  })
  .strict()

export const v2TurnStatusSchema = z.enum([
  "queued",
  "routing",
  "awaiting_clarification",
  "running",
  "waiting",
  "suspended",
  "completed",
  "failed",
  "cancelled",
])

export const v2TurnSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    ordinal: z.number().int().positive(),
    userMessageId: idSchema.optional(),
    assistantMessageId: idSchema.optional(),
    status: v2TurnStatusSchema,
    waitingReason: z.string().max(1_000).optional(),
    errorId: idSchema.optional(),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    failedAt: timestampSchema.optional(),
    cancelledAt: timestampSchema.optional(),
  })
  .strict()

export const v2RuntimeConfigSchema = z
  .object({
    providerId: providerIdSchema,
    authMode: providerAuthModeSchema.optional(),
    modelId: z.string().min(1),
    thinkingEnabled: z.boolean(),
    thinkingEffort: thinkingEffortSchema.optional(),
    approvalMode: z.enum(["manual", "approve_all", "read_only_auto"]),
    sandboxMode: z.enum(["read_only", "workspace_write", "danger_full_access"]),
    contextWindowTokens: z.number().int().positive().optional(),
  })
  .strict()

export const v2MessageRoleSchema = z.enum(["user", "assistant", "system", "tool", "developer"])
export const v2MessageStatusSchema = z.enum(["streaming", "completed", "failed", "cancelled"])
export const v2MessageKindSchema = z.enum(["standard", "routing_clarification", "bridge_import"])
export const v2MessageAttachmentKindSchema = z.enum(["image", "text", "skill_zip", "audio"])
export const v2MessageAttachmentStatusSchema = z.enum(["draft", "attached", "deleted"])

export const v2MessageAttachmentSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    flowId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema.optional(),
    messageId: idSchema.optional(),
    artifactId: idSchema,
    kind: v2MessageAttachmentKindSchema,
    fileName: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(255),
    sizeBytes: z.number().int().nonnegative(),
    uri: z.string().min(1),
    url: z.string().min(1).optional(),
    status: v2MessageAttachmentStatusSchema,
    createdAt: timestampSchema,
  })
  .strict()

export const v2MessageSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema.optional(),
    ordinal: z.number().int().positive(),
    role: v2MessageRoleSchema,
    kind: v2MessageKindSchema,
    content: z.string(),
    reasoning: z.string().optional(),
    status: v2MessageStatusSchema,
    parentMessageId: idSchema.optional(),
    attachments: z.array(v2MessageAttachmentSchema).max(MAX_MESSAGE_ATTACHMENTS).optional(),
    createdAt: timestampSchema,
    completedAt: timestampSchema.optional(),
  })
  .strict()

export const v2EvidenceKindSchema = z.enum([
  "user_attachment",
  "tool_output",
  "terminal_output",
  "file",
  "pdf_page",
  "retrieval_chunk",
  "web_resource",
  "model_output",
  "system",
])

export const v2EvidenceItemSchema = z
  .object({
    id: idSchema,
    handle: z.string().min(1).max(512),
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema.optional(),
    sourceKind: v2EvidenceKindSchema,
    sourceId: idSchema.optional(),
    sourceUri: z.string().min(1).optional(),
    title: z.string().min(1).max(1_000),
    mimeType: z.string().min(1).max(255).optional(),
    content: z.string().optional(),
    contentHash: z.string().min(1).max(256),
    sizeBytes: z.number().int().nonnegative().optional(),
    tokenEstimate: z.number().int().nonnegative().optional(),
    locator: z.unknown().optional(),
    createdAt: timestampSchema,
  })
  .strict()

export const v2ContextItemKindSchema = z.enum([
  "system_instruction",
  "project_instruction",
  "message",
  "message_pair",
  "goal_capsule",
  "evidence_exact",
  "evidence_distill",
  "retrieval_result",
])
export const v2ContextItemStateSchema = z.enum(["active", "released"])

export const v2ContextItemSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema.optional(),
    kind: v2ContextItemKindSchema,
    state: v2ContextItemStateSchema,
    content: z.string(),
    tokenEstimate: z.number().int().nonnegative(),
    rank: z.number().int().nonnegative(),
    activeFromTurnOrdinal: z.number().int().positive(),
    releasedAtTurnOrdinal: z.number().int().positive().optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()

export const v2ContextItemSourceSchema = z
  .object({
    id: idSchema,
    contextItemId: idSchema,
    evidenceItemId: idSchema.optional(),
    messageId: idSchema.optional(),
    capsuleId: idSchema.optional(),
    sourceOrder: z.number().int().nonnegative(),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const populated = [value.evidenceItemId, value.messageId, value.capsuleId].filter(Boolean).length
    if (populated !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Exactly one context item source must be set.",
      })
    }
  })

export const v2ContextDispositionKindSchema = z.enum(["keep_exact", "distill", "release", "unresolved"])
export const v2ContextDispositionActorSchema = z.enum(["main_agent", "distiller", "policy", "recovery"])

export const v2ContextDispositionSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema,
    contextItemId: idSchema,
    version: z.number().int().positive(),
    disposition: v2ContextDispositionKindSchema,
    reason: z.string().min(1).max(4_000),
    decidedBy: v2ContextDispositionActorSchema,
    unresolvedAgeTurns: z.number().int().min(0).max(V2_CONTEXT_UNRESOLVED_MAX_AGE_TURNS).optional(),
    unresolvedMaxAgeTurns: z.number().int().min(1).max(V2_CONTEXT_UNRESOLVED_MAX_AGE_TURNS).optional(),
    distillationInstruction: z.string().min(1).max(4_000).optional(),
    replacementContextItemId: idSchema.optional(),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.disposition === "unresolved") {
      if (value.unresolvedAgeTurns === undefined || value.unresolvedMaxAgeTurns === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["unresolvedAgeTurns"],
          message: "Unresolved dispositions require age and maximum-age fields.",
        })
      } else if (value.unresolvedAgeTurns > value.unresolvedMaxAgeTurns) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["unresolvedAgeTurns"],
          message: "An unresolved item cannot be older than its maximum age.",
        })
      }
    } else if (value.unresolvedAgeTurns !== undefined || value.unresolvedMaxAgeTurns !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unresolvedAgeTurns"],
        message: "Only unresolved dispositions may carry unresolved age fields.",
      })
    }
    if (value.disposition === "distill" && !value.distillationInstruction) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["distillationInstruction"],
        message: "Distillation requires a focused instruction.",
      })
    }
  })

export const v2ContextPolicySchema = z
  .object({
    unresolvedMaxItems: z.number().int().min(1).max(V2_CONTEXT_UNRESOLVED_MAX_ITEMS),
    unresolvedMaxAgeTurns: z.number().int().min(1).max(V2_CONTEXT_UNRESOLVED_MAX_AGE_TURNS),
    softPressurePercent: z.number().min(1).max(100),
    hardPressurePercent: z.number().min(1).max(100),
    targetAfterCompactionPercent: z.number().min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.softPressurePercent >= value.hardPressurePercent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["softPressurePercent"],
        message: "Soft pressure must be lower than hard pressure.",
      })
    }
    if (value.targetAfterCompactionPercent >= value.softPressurePercent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetAfterCompactionPercent"],
        message: "The compaction target must be lower than soft pressure.",
      })
    }
  })

export const v2RuntimeEventSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema.optional(),
    sequence: z.number().int().positive(),
    type: z.string().regex(/^v2\./),
    source: z.string().min(1).max(100),
    payload: z.unknown(),
    createdAt: timestampSchema,
  })
  .strict()

export const v2ModelCallRoleSchema = z.enum([
  "main_agent",
  "frontier_agent",
  "memory_router",
  "goal_router",
  "context_distiller",
  "context_compactor",
])
export const v2RuntimeStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"])

export const v2ModelCallSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema.optional(),
    role: v2ModelCallRoleSchema,
    providerId: providerIdSchema,
    modelId: z.string().min(1),
    status: v2RuntimeStatusSchema,
    errorId: idSchema.optional(),
    startedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
  })
  .strict()

export const v2UsageEventSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema.optional(),
    modelCallId: idSchema,
    providerId: providerIdSchema,
    modelId: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    createdAt: timestampSchema,
  })
  .strict()

export const v2ToolCallStatusSchema = z.enum([
  "pending",
  "awaiting_approval",
  "running",
  "completed",
  "failed",
  "cancelled",
])

export const v2ToolCallSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema,
    modelCallId: idSchema.optional(),
    toolName: z.string().min(1).max(200),
    status: v2ToolCallStatusSchema,
    arguments: z.unknown(),
    result: z.unknown().optional(),
    requiresApproval: z.boolean(),
    approvalId: idSchema.optional(),
    errorId: idSchema.optional(),
    startedAt: timestampSchema.optional(),
    completedAt: timestampSchema.optional(),
  })
  .strict()

export const v2ApprovalStatusSchema = z.enum(["pending", "approved", "rejected", "expired", "cancelled"])

export const v2ApprovalSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema,
    toolCallId: idSchema.optional(),
    status: v2ApprovalStatusSchema,
    actionKind: z.string().min(1).max(200),
    action: z.unknown(),
    decision: z.enum(["approved", "rejected"]).optional(),
    reason: z.string().max(2_000).optional(),
    requestedAt: timestampSchema,
    decidedAt: timestampSchema.optional(),
  })
  .strict()

export const v2TerminalStatusSchema = z.enum([
  "starting",
  "running",
  "awaiting_input",
  "detached",
  "exited",
  "stopped",
  "stale",
  "missing",
])

export const v2TerminalSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema.optional(),
    name: z.string().min(1).max(96),
    command: z.string().min(1),
    cwd: z.string().min(1),
    status: v2TerminalStatusSchema,
    awaitingInput: z.boolean(),
    stateVersion: z.number().int().nonnegative(),
    exitCode: z.number().int().optional(),
    startedAt: timestampSchema,
    updatedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
  })
  .strict()

export const v2ErrorSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema.optional(),
    source: z.string().min(1).max(200),
    code: z.string().min(1).max(200),
    message: z.string().min(1),
    recoverable: z.boolean(),
    details: z.unknown().optional(),
    createdAt: timestampSchema,
  })
  .strict()

export const v2ArtifactSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema.optional(),
    kind: z.string().min(1).max(200),
    path: z.string().min(1).optional(),
    uri: z.string().min(1).optional(),
    contentHash: z.string().min(1).max(256).optional(),
    mimeType: z.string().min(1).max(255).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    createdAt: timestampSchema,
  })
  .strict()

export const v2AgentTaskStatusSchema = z.enum(["running", "waiting", "ready", "completed", "failed", "cancelled"])

export const v2AgentTaskSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    rootTurnId: idSchema,
    currentTurnId: idSchema,
    status: v2AgentTaskStatusSchema,
    runtimeConfig: v2RuntimeConfigSchema,
    waitingOnTerminalIds: z.array(idSchema).max(8),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
  })
  .strict()

export const v2FeedbackRatingSchema = z.enum(["thumbs_up", "thumbs_down"])

export const v2FeedbackSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema.optional(),
    messageId: idSchema,
    modelCallId: idSchema.optional(),
    rating: v2FeedbackRatingSchema,
    reasonCode: z.string().min(1).max(200).optional(),
    note: z.string().max(4_000).optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()

export const v2McpSecretSourceSchema = z.enum(["user_input", "workspace_env"])
export const v2CredentialInputStatusSchema = z.enum(["pending", "submitted", "cancelled", "expired"])

export const v2CredentialInputRequestSchema = z
  .object({
    id: idSchema,
    flowId: idSchema,
    projectId: idSchema,
    goalId: idSchema.optional(),
    turnId: idSchema,
    toolCallId: idSchema,
    providerToolCallId: z.string().min(1).optional(),
    serverId: z.string().min(1).max(64),
    serverLabel: z.string().min(1).max(120).optional(),
    envKey: z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    source: v2McpSecretSourceSchema,
    status: v2CredentialInputStatusSchema,
    requestedAt: timestampSchema,
    resolvedAt: timestampSchema.optional(),
  })
  .strict()

export const v2LocalWhisperModelSchema = z.enum(V2_LOCAL_WHISPER_MODEL_IDS)
export const v2OpenRouterSttModelSchema = z.enum(V2_OPENROUTER_STT_MODEL_IDS)
export const v2LocalKokoroModelSchema = z.literal(V2_LOCAL_KOKORO_MODEL_ID)
export const v2SpeechJobStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"])

const v2SpeechJobBaseShape = {
  id: idSchema,
  flowId: idSchema,
  projectId: idSchema,
  goalId: idSchema.optional(),
  turnId: idSchema.optional(),
  messageId: idSchema.optional(),
  status: v2SpeechJobStatusSchema,
  language: z.string().min(1).max(64).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  errorId: idSchema.optional(),
  createdAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  completedAt: timestampSchema.optional(),
}

export const v2LocalWhisperSpeechJobSchema = z
  .object({
    ...v2SpeechJobBaseShape,
    kind: z.literal("transcription"),
    engine: z.literal("local_whisper"),
    modelId: v2LocalWhisperModelSchema,
    inputArtifactId: idSchema,
    transcriptText: z.string().optional(),
  })
  .strict()

export const v2OpenRouterSpeechJobSchema = z
  .object({
    ...v2SpeechJobBaseShape,
    kind: z.literal("transcription"),
    engine: z.literal("openrouter"),
    modelId: v2OpenRouterSttModelSchema,
    inputArtifactId: idSchema,
    transcriptText: z.string().optional(),
  })
  .strict()

export const v2LocalKokoroSpeechJobSchema = z
  .object({
    ...v2SpeechJobBaseShape,
    kind: z.literal("synthesis"),
    engine: z.literal("local_kokoro"),
    modelId: v2LocalKokoroModelSchema,
    inputText: z.string().min(1).max(100_000),
    voiceId: z.string().min(1).max(128),
    speed: z.number().min(0.5).max(2),
    outputArtifactId: idSchema.optional(),
  })
  .strict()

export const v2SpeechJobSchema = z.discriminatedUnion("engine", [
  v2LocalWhisperSpeechJobSchema,
  v2OpenRouterSpeechJobSchema,
  v2LocalKokoroSpeechJobSchema,
])

export const V2_FLOW_SNAPSHOT_MESSAGE_LIMIT = 100
export const V2_FLOW_MESSAGE_PAGE_MAX = 200

export const v2MessageWindowSchema = z
  .object({
    hasEarlier: z.boolean(),
    beforeOrdinal: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.hasEarlier && value.beforeOrdinal === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["beforeOrdinal"],
        message: "A message cursor is required when earlier Flow messages are available.",
      })
    }
    if (!value.hasEarlier && value.beforeOrdinal !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["beforeOrdinal"],
        message: "A message cursor must be omitted when the Flow window is complete.",
      })
    }
  })

export const v2FlowSnapshotSchema = z
  .object({
    flow: v2FlowSchema,
    foregroundGoal: v2GoalSchema.optional(),
    goals: z.array(v2GoalSchema),
    latestCapsules: z.array(v2GoalCapsuleSchema),
    messages: z.array(v2MessageSchema),
    messageWindow: v2MessageWindowSchema,
    activeTurn: v2TurnSchema.optional(),
    activeTerminals: z.array(v2TerminalSchema),
    pendingApprovals: z.array(v2ApprovalSchema),
    pendingClarification: v2GoalRoutingRunSchema.optional(),
    lastEventSequence: z.number().int().nonnegative(),
  })
  .strict()

export const v2EnsureFlowRequestSchema = z.object({}).strict()
export const v2EnsureFlowResponseSchema = z.object({ snapshot: v2FlowSnapshotSchema }).strict()
export const v2GetFlowResponseSchema = v2EnsureFlowResponseSchema

export const v2ListFlowMessagesRequestSchema = z
  .object({
    beforeOrdinal: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(V2_FLOW_MESSAGE_PAGE_MAX).default(V2_FLOW_SNAPSHOT_MESSAGE_LIMIT),
  })
  .strict()

export const v2ListFlowMessagesResponseSchema = z
  .object({
    messages: z.array(v2MessageSchema).max(V2_FLOW_MESSAGE_PAGE_MAX),
    messageWindow: v2MessageWindowSchema,
  })
  .strict()

export const v2ListTimelineRequestSchema = z
  .object({
    afterSequence: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).default(100),
  })
  .strict()

export const v2TimelineItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), sequence: z.number().int().positive(), message: v2MessageSchema }).strict(),
  z.object({ kind: z.literal("goal_transition"), sequence: z.number().int().positive(), transition: v2GoalTransitionSchema }).strict(),
  z.object({ kind: z.literal("runtime_event"), sequence: z.number().int().positive(), event: v2RuntimeEventSchema }).strict(),
])

export const v2ListTimelineResponseSchema = z
  .object({
    items: z.array(v2TimelineItemSchema),
    nextSequence: z.number().int().nonnegative().optional(),
  })
  .strict()

export const v2ListGoalsResponseSchema = z.object({ goals: z.array(v2GoalSchema) }).strict()
export const v2GetGoalResponseSchema = z
  .object({
    goal: v2GoalSchema,
    latestCapsule: v2GoalCapsuleSchema.optional(),
    transitions: z.array(v2GoalTransitionSchema),
    messages: z.array(v2MessageSchema),
  })
  .strict()

const v2CreateSpeechJobBaseShape = {
  goalId: idSchema.optional(),
  turnId: idSchema.optional(),
  messageId: idSchema.optional(),
  language: z.string().min(1).max(64).optional(),
}

export const v2CreateSpeechJobRequestSchema = z.discriminatedUnion("engine", [
  z
    .object({
      ...v2CreateSpeechJobBaseShape,
      kind: z.literal("transcription"),
      engine: z.literal("local_whisper"),
      modelId: v2LocalWhisperModelSchema,
      inputArtifactId: idSchema,
    })
    .strict(),
  z
    .object({
      ...v2CreateSpeechJobBaseShape,
      kind: z.literal("transcription"),
      engine: z.literal("openrouter"),
      modelId: v2OpenRouterSttModelSchema,
      inputArtifactId: idSchema,
    })
    .strict(),
  z
    .object({
      ...v2CreateSpeechJobBaseShape,
      kind: z.literal("synthesis"),
      engine: z.literal("local_kokoro"),
      modelId: v2LocalKokoroModelSchema,
      inputText: z.string().min(1).max(100_000),
      voiceId: z.string().min(1).max(128),
      speed: z.number().min(0.5).max(2).default(1),
    })
    .strict(),
])

export const v2CreateSpeechJobResponseSchema = z.object({ job: v2SpeechJobSchema }).strict()

export const v2ContextDispositionDecisionInputSchema = z
  .object({
    contextItemId: idSchema,
    disposition: v2ContextDispositionKindSchema,
    reason: z.string().min(1).max(4_000),
    unresolvedAgeTurns: z.number().int().min(0).max(V2_CONTEXT_UNRESOLVED_MAX_AGE_TURNS).optional(),
    unresolvedMaxAgeTurns: z.number().int().min(1).max(V2_CONTEXT_UNRESOLVED_MAX_AGE_TURNS).optional(),
    distillationInstruction: z.string().min(1).max(4_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.disposition === "unresolved") {
      if (value.unresolvedAgeTurns === undefined || value.unresolvedMaxAgeTurns === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["unresolvedAgeTurns"],
          message: "Unresolved dispositions require age and maximum-age fields.",
        })
      } else if (value.unresolvedAgeTurns > value.unresolvedMaxAgeTurns) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["unresolvedAgeTurns"],
          message: "An unresolved item cannot be older than its maximum age.",
        })
      }
    } else if (value.unresolvedAgeTurns !== undefined || value.unresolvedMaxAgeTurns !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["unresolvedAgeTurns"],
        message: "Only unresolved dispositions may carry unresolved age fields.",
      })
    }
    if (value.disposition === "distill" && !value.distillationInstruction) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["distillationInstruction"],
        message: "Distillation requires a focused instruction.",
      })
    }
  })

export const v2ContextDispositionBatchRequestSchema = z
  .object({
    turnId: idSchema,
    decisions: z.array(v2ContextDispositionDecisionInputSchema).min(1).max(64),
  })
  .strict()

export const v2ContextDispositionBatchResponseSchema = z
  .object({ dispositions: z.array(v2ContextDispositionSchema) })
  .strict()

export const v2ActorTypeSchema = z.enum(["user", "main_agent", "worker", "tool", "system"])
export const v2ActorSchema = z
  .object({
    type: v2ActorTypeSchema,
    id: idSchema.optional(),
    label: z.string().min(1).max(200).optional(),
  })
  .strict()

const v2SocketEnvelopeBaseShape = {
  id: idSchema,
  schemaVersion: v2FlowSchemaVersionSchema,
  timestamp: timestampSchema,
  projectId: idSchema,
  flowId: idSchema,
  goalId: idSchema.optional(),
  turnId: idSchema.optional(),
  actor: v2ActorSchema.optional(),
}

export const v2SocketEnvelopeSchema = <TType extends string, TPayload extends z.ZodTypeAny>(
  type: TType,
  payloadSchema: TPayload,
) =>
  z
    .object({
      ...v2SocketEnvelopeBaseShape,
      type: z.literal(type),
      payload: payloadSchema,
    })
    .strict()

export const v2FlowSubscribePayloadSchema = z
  .object({ afterSequence: z.number().int().nonnegative().optional(), replayActiveTurn: z.boolean().optional() })
  .strict()
export const v2FlowUnsubscribePayloadSchema = z.object({}).strict()

export const v2MessageSendPayloadSchema = z
  .object({
    clientMessageId: idSchema,
    content: z.string().max(MAX_INLINE_MESSAGE_CHARS),
    attachmentIds: z.array(idSchema).max(MAX_MESSAGE_ATTACHMENTS).optional(),
    foregroundGoalIdAtCompose: idSchema.optional(),
    runtimeConfig: v2RuntimeConfigSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.content.trim() && (value.attachmentIds ?? []).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["content"],
        message: "Content is required unless at least one attachment is present.",
      })
    }
  })

export const v2RoutingClarificationRespondPayloadSchema = z
  .object({
    routingRunId: idSchema,
    answerMessageId: idSchema,
    answer: z.string().trim().min(1).max(MAX_INLINE_MESSAGE_CHARS),
  })
  .strict()

export const v2FocusActionSchema = z.enum(["switch", "pause", "finish", "reopen", "archive", "pin", "unpin"])
export const v2FocusUpdatePayloadSchema = z
  .object({
    goalId: idSchema,
    action: v2FocusActionSchema,
    note: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()

export const v2TurnCancelPayloadSchema = z
  .object({ turnId: idSchema, reason: z.string().max(1_000).optional() })
  .strict()
export const v2ApprovalDecidePayloadSchema = z
  .object({ approvalId: idSchema, decision: z.enum(["approved", "rejected"]), reason: z.string().max(2_000).optional() })
  .strict()
export const v2FeedbackSubmitPayloadSchema = z
  .object({
    messageId: idSchema,
    turnId: idSchema.optional(),
    modelCallId: idSchema.optional(),
    rating: v2FeedbackRatingSchema,
    reasonCode: z.string().min(1).max(200).optional(),
    note: z.string().max(4_000).optional(),
  })
  .strict()
export const v2CredentialInputSubmitPayloadSchema = z
  .object({
    credentialRequestId: idSchema,
    turnId: idSchema,
    decision: z.enum(["submitted", "cancelled"]),
    value: z.string().min(1).max(20_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decision === "submitted" && value.value === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "A credential value is required when submitting.",
      })
    }
    if (value.decision === "cancelled" && value.value !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "Cancelled credential input must not include a value.",
      })
    }
  })
export const v2TerminalStopPayloadSchema = z
  .object({ terminalId: idSchema, reason: z.string().max(1_000).optional() })
  .strict()
export const v2TerminalInputPayloadSchema = z
  .object({
    terminalId: idSchema,
    data: z.string().optional(),
    text: z.string().optional(),
    key: z.enum(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Ctrl-C"]).optional(),
    submit: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.data === undefined && value.text === undefined && value.key === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
        message: "Terminal input requires data, text, or key.",
      })
    }
  })
export const v2TerminalResizePayloadSchema = z
  .object({ terminalId: idSchema, cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(500) })
  .strict()
export const v2TerminalRenamePayloadSchema = z
  .object({ terminalId: idSchema, name: z.string().min(1).max(96) })
  .strict()

export const v2FlowSubscribeCommandSchema = v2SocketEnvelopeSchema("v2.flow.subscribe", v2FlowSubscribePayloadSchema)
export const v2FlowUnsubscribeCommandSchema = v2SocketEnvelopeSchema("v2.flow.unsubscribe", v2FlowUnsubscribePayloadSchema)
export const v2MessageSendCommandSchema = v2SocketEnvelopeSchema("v2.message.send", v2MessageSendPayloadSchema)
export const v2RoutingClarificationRespondCommandSchema = v2SocketEnvelopeSchema(
  "v2.routing.clarification.respond",
  v2RoutingClarificationRespondPayloadSchema,
)
export const v2FocusUpdateCommandSchema = v2SocketEnvelopeSchema("v2.focus.update", v2FocusUpdatePayloadSchema)
export const v2TurnCancelCommandSchema = v2SocketEnvelopeSchema("v2.turn.cancel", v2TurnCancelPayloadSchema)
export const v2ApprovalDecideCommandSchema = v2SocketEnvelopeSchema("v2.approval.decide", v2ApprovalDecidePayloadSchema)
export const v2FeedbackSubmitCommandSchema = v2SocketEnvelopeSchema("v2.feedback.submit", v2FeedbackSubmitPayloadSchema)
export const v2CredentialInputSubmitCommandSchema = v2SocketEnvelopeSchema(
  "v2.credential.input.submit",
  v2CredentialInputSubmitPayloadSchema,
)
export const v2TerminalStopCommandSchema = v2SocketEnvelopeSchema("v2.terminal.stop", v2TerminalStopPayloadSchema)
export const v2TerminalInputCommandSchema = v2SocketEnvelopeSchema("v2.terminal.input", v2TerminalInputPayloadSchema)
export const v2TerminalResizeCommandSchema = v2SocketEnvelopeSchema("v2.terminal.resize", v2TerminalResizePayloadSchema)
export const v2TerminalRenameCommandSchema = v2SocketEnvelopeSchema("v2.terminal.rename", v2TerminalRenamePayloadSchema)

export const v2ClientCommandSchema = z.discriminatedUnion("type", [
  v2FlowSubscribeCommandSchema,
  v2FlowUnsubscribeCommandSchema,
  v2MessageSendCommandSchema,
  v2RoutingClarificationRespondCommandSchema,
  v2FocusUpdateCommandSchema,
  v2TurnCancelCommandSchema,
  v2ApprovalDecideCommandSchema,
  v2FeedbackSubmitCommandSchema,
  v2CredentialInputSubmitCommandSchema,
  v2TerminalStopCommandSchema,
  v2TerminalInputCommandSchema,
  v2TerminalResizeCommandSchema,
  v2TerminalRenameCommandSchema,
])

export const v2ConnectionReadyPayloadSchema = z
  .object({ connectionId: idSchema, serverTime: timestampSchema })
  .strict()
export const v2FlowSnapshotPayloadSchema = z.object({ snapshot: v2FlowSnapshotSchema }).strict()
export const v2TurnStartedPayloadSchema = z
  .object({ turn: v2TurnSchema, userMessage: v2MessageSchema })
  .strict()
export const v2TurnUpdatedPayloadSchema = z.object({ turn: v2TurnSchema }).strict()
export const v2MessageDeltaPayloadSchema = z
  .object({ messageId: idSchema, channel: z.enum(["answer", "reasoning"]), text: z.string(), modelCallId: idSchema.optional() })
  .strict()
export const v2MessageCompletedPayloadSchema = z.object({ message: v2MessageSchema }).strict()
export const v2GoalRoutedPayloadSchema = z
  .object({ routingRun: v2GoalRoutingRunSchema, goal: v2GoalSchema.optional(), transition: v2GoalTransitionSchema.optional() })
  .strict()
export const v2RoutingClarificationRequestedPayloadSchema = z
  .object({ routingRun: v2GoalRoutingRunSchema, message: v2MessageSchema })
  .strict()
export const v2RoutingClarificationResolvedPayloadSchema = z
  .object({ routingRun: v2GoalRoutingRunSchema, answerMessage: v2MessageSchema })
  .strict()
export const v2GoalTransitionedPayloadSchema = z
  .object({ goal: v2GoalSchema, transition: v2GoalTransitionSchema })
  .strict()
export const v2GoalCapsuleUpdatedPayloadSchema = z.object({ capsule: v2GoalCapsuleSchema }).strict()
export const v2ContextDispositionUpdatedPayloadSchema = z
  .object({ contextItem: v2ContextItemSchema, disposition: v2ContextDispositionSchema })
  .strict()
export const v2ToolCallUpdatedPayloadSchema = z.object({ toolCall: v2ToolCallSchema }).strict()
export const v2ApprovalUpdatedPayloadSchema = z.object({ approval: v2ApprovalSchema }).strict()
export const v2FeedbackUpdatedPayloadSchema = z.object({ feedback: v2FeedbackSchema }).strict()
export const v2CredentialInputRequestedPayloadSchema = z
  .object({ request: v2CredentialInputRequestSchema })
  .strict()
export const v2CredentialInputResolvedPayloadSchema = z
  .object({ request: v2CredentialInputRequestSchema })
  .strict()
export const v2TerminalUpdatedPayloadSchema = z.object({ terminal: v2TerminalSchema }).strict()
export const v2TerminalOutputPayloadSchema = z
  .object({
    terminalId: idSchema,
    sequence: z.number().int().nonnegative(),
    stream: z.enum(["stdout", "stderr", "log", "result", "input", "pty"]),
    text: z.string(),
    redacted: z.boolean(),
  })
  .strict()
export const v2ArtifactCreatedPayloadSchema = z.object({ artifact: v2ArtifactSchema }).strict()
export const v2SpeechJobUpdatedPayloadSchema = z.object({ job: v2SpeechJobSchema }).strict()
export const v2ErrorCreatedPayloadSchema = z.object({ error: v2ErrorSchema }).strict()
export const v2AgentHandoverPayloadSchema = z
  .object({
    toolCallId: idSchema,
    stepIndex: z.number().int().nonnegative(),
    fromProviderId: providerIdSchema,
    fromModelId: z.string().min(1),
    toProviderId: providerIdSchema,
    toModelId: z.string().min(1),
    focus: z.string().min(1).max(160).optional(),
  })
  .strict()
export const v2ContextCompactionStartedPayloadSchema = z
  .object({
    snapshotId: idSchema,
    reason: z.enum(["precompute", "threshold", "emergency", "manual"]),
    contextUsedTokensEstimate: z.number().int().nonnegative(),
    targetTokens: z.number().int().positive(),
  })
  .strict()
export const v2ContextCompactionCompletedPayloadSchema = z
  .object({
    snapshotId: idSchema,
    inputTokensEstimate: z.number().int().nonnegative(),
    outputTokensEstimate: z.number().int().nonnegative(),
    contextUsedTokensEstimate: z.number().int().nonnegative(),
    sizeClass: z.enum(["excellent", "preferred", "acceptable"]),
  })
  .strict()
export const v2ContextCompactionFailedPayloadSchema = z
  .object({ snapshotId: idSchema.optional(), error: apiErrorSchema })
  .strict()

export const v2ConnectionReadyEventSchema = v2SocketEnvelopeSchema("v2.connection.ready", v2ConnectionReadyPayloadSchema)
export const v2FlowSnapshotEventSchema = v2SocketEnvelopeSchema("v2.flow.snapshot", v2FlowSnapshotPayloadSchema)
export const v2TurnStartedEventSchema = v2SocketEnvelopeSchema("v2.turn.started", v2TurnStartedPayloadSchema)
export const v2TurnUpdatedEventSchema = v2SocketEnvelopeSchema("v2.turn.updated", v2TurnUpdatedPayloadSchema)
export const v2MessageDeltaEventSchema = v2SocketEnvelopeSchema("v2.message.delta", v2MessageDeltaPayloadSchema)
export const v2MessageCompletedEventSchema = v2SocketEnvelopeSchema("v2.message.completed", v2MessageCompletedPayloadSchema)
export const v2GoalRoutedEventSchema = v2SocketEnvelopeSchema("v2.goal.routed", v2GoalRoutedPayloadSchema)
export const v2RoutingClarificationRequestedEventSchema = v2SocketEnvelopeSchema(
  "v2.routing.clarification.requested",
  v2RoutingClarificationRequestedPayloadSchema,
)
export const v2RoutingClarificationResolvedEventSchema = v2SocketEnvelopeSchema(
  "v2.routing.clarification.resolved",
  v2RoutingClarificationResolvedPayloadSchema,
)
export const v2GoalTransitionedEventSchema = v2SocketEnvelopeSchema("v2.goal.transitioned", v2GoalTransitionedPayloadSchema)
export const v2GoalCapsuleUpdatedEventSchema = v2SocketEnvelopeSchema("v2.goal.capsule.updated", v2GoalCapsuleUpdatedPayloadSchema)
export const v2ContextDispositionUpdatedEventSchema = v2SocketEnvelopeSchema(
  "v2.context.disposition.updated",
  v2ContextDispositionUpdatedPayloadSchema,
)
export const v2ToolCallUpdatedEventSchema = v2SocketEnvelopeSchema("v2.tool.call.updated", v2ToolCallUpdatedPayloadSchema)
export const v2ApprovalUpdatedEventSchema = v2SocketEnvelopeSchema("v2.approval.updated", v2ApprovalUpdatedPayloadSchema)
export const v2FeedbackUpdatedEventSchema = v2SocketEnvelopeSchema("v2.feedback.updated", v2FeedbackUpdatedPayloadSchema)
export const v2CredentialInputRequestedEventSchema = v2SocketEnvelopeSchema(
  "v2.credential.input.requested",
  v2CredentialInputRequestedPayloadSchema,
)
export const v2CredentialInputResolvedEventSchema = v2SocketEnvelopeSchema(
  "v2.credential.input.resolved",
  v2CredentialInputResolvedPayloadSchema,
)
export const v2TerminalUpdatedEventSchema = v2SocketEnvelopeSchema("v2.terminal.updated", v2TerminalUpdatedPayloadSchema)
export const v2TerminalOutputEventSchema = v2SocketEnvelopeSchema("v2.terminal.output", v2TerminalOutputPayloadSchema)
export const v2ArtifactCreatedEventSchema = v2SocketEnvelopeSchema("v2.artifact.created", v2ArtifactCreatedPayloadSchema)
export const v2SpeechJobUpdatedEventSchema = v2SocketEnvelopeSchema("v2.speech.job.updated", v2SpeechJobUpdatedPayloadSchema)
export const v2ErrorCreatedEventSchema = v2SocketEnvelopeSchema("v2.error.created", v2ErrorCreatedPayloadSchema)
export const v2AgentHandoverEventSchema = v2SocketEnvelopeSchema("v2.agent.handover", v2AgentHandoverPayloadSchema)
export const v2ContextCompactionStartedEventSchema = v2SocketEnvelopeSchema(
  "v2.context.compaction.started",
  v2ContextCompactionStartedPayloadSchema,
)
export const v2ContextCompactionCompletedEventSchema = v2SocketEnvelopeSchema(
  "v2.context.compaction.completed",
  v2ContextCompactionCompletedPayloadSchema,
)
export const v2ContextCompactionFailedEventSchema = v2SocketEnvelopeSchema(
  "v2.context.compaction.failed",
  v2ContextCompactionFailedPayloadSchema,
)

export const v2ServerEventSchema = z.discriminatedUnion("type", [
  v2ConnectionReadyEventSchema,
  v2FlowSnapshotEventSchema,
  v2TurnStartedEventSchema,
  v2TurnUpdatedEventSchema,
  v2MessageDeltaEventSchema,
  v2MessageCompletedEventSchema,
  v2GoalRoutedEventSchema,
  v2RoutingClarificationRequestedEventSchema,
  v2RoutingClarificationResolvedEventSchema,
  v2GoalTransitionedEventSchema,
  v2GoalCapsuleUpdatedEventSchema,
  v2ContextDispositionUpdatedEventSchema,
  v2ToolCallUpdatedEventSchema,
  v2ApprovalUpdatedEventSchema,
  v2FeedbackUpdatedEventSchema,
  v2CredentialInputRequestedEventSchema,
  v2CredentialInputResolvedEventSchema,
  v2TerminalUpdatedEventSchema,
  v2TerminalOutputEventSchema,
  v2ArtifactCreatedEventSchema,
  v2SpeechJobUpdatedEventSchema,
  v2ErrorCreatedEventSchema,
  v2AgentHandoverEventSchema,
  v2ContextCompactionStartedEventSchema,
  v2ContextCompactionCompletedEventSchema,
  v2ContextCompactionFailedEventSchema,
])

export const v2SocketMessageSchema = z.union([v2ClientCommandSchema, v2ServerEventSchema])

export type V2Flow = z.infer<typeof v2FlowSchema>
export type V2Goal = z.infer<typeof v2GoalSchema>
export type V2GoalTransition = z.infer<typeof v2GoalTransitionSchema>
export type V2GoalRoutingRun = z.infer<typeof v2GoalRoutingRunSchema>
export type V2GoalCapsule = z.infer<typeof v2GoalCapsuleSchema>
export type V2GoalMessageLink = z.infer<typeof v2GoalMessageLinkSchema>
export type V2Turn = z.infer<typeof v2TurnSchema>
export type V2RuntimeConfig = z.infer<typeof v2RuntimeConfigSchema>
export type V2Message = z.infer<typeof v2MessageSchema>
export type V2MessageAttachment = z.infer<typeof v2MessageAttachmentSchema>
export type V2EvidenceItem = z.infer<typeof v2EvidenceItemSchema>
export type V2ContextItem = z.infer<typeof v2ContextItemSchema>
export type V2ContextItemSource = z.infer<typeof v2ContextItemSourceSchema>
export type V2ContextDisposition = z.infer<typeof v2ContextDispositionSchema>
export type V2ContextPolicy = z.infer<typeof v2ContextPolicySchema>
export type V2RuntimeEvent = z.infer<typeof v2RuntimeEventSchema>
export type V2ModelCall = z.infer<typeof v2ModelCallSchema>
export type V2UsageEvent = z.infer<typeof v2UsageEventSchema>
export type V2ToolCall = z.infer<typeof v2ToolCallSchema>
export type V2Approval = z.infer<typeof v2ApprovalSchema>
export type V2Terminal = z.infer<typeof v2TerminalSchema>
export type V2Error = z.infer<typeof v2ErrorSchema>
export type V2Artifact = z.infer<typeof v2ArtifactSchema>
export type V2AgentTask = z.infer<typeof v2AgentTaskSchema>
export type V2Feedback = z.infer<typeof v2FeedbackSchema>
export type V2CredentialInputRequest = z.infer<typeof v2CredentialInputRequestSchema>
export type V2SpeechJob = z.infer<typeof v2SpeechJobSchema>
export type V2MessageWindow = z.infer<typeof v2MessageWindowSchema>
export type V2FlowSnapshot = z.infer<typeof v2FlowSnapshotSchema>
export type V2CreateSpeechJobRequest = z.infer<typeof v2CreateSpeechJobRequestSchema>
export type V2ClientCommand = z.infer<typeof v2ClientCommandSchema>
export type V2ServerEvent = z.infer<typeof v2ServerEventSchema>
export type V2SocketMessage = z.infer<typeof v2SocketMessageSchema>
