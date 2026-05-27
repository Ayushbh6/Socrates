import { z } from "zod"
import { conversationStatusSchema, messageRoleSchema, projectResourceKindSchema, projectResourceSourceSchema, projectResourceStatusSchema } from "./entities"

export const toolNameSchema = z.enum(["read", "search", "edit", "bash", "trace_retrieve", "list_project_resources"])
export type ToolName = z.infer<typeof toolNameSchema>

export const providerMetadataSchema = z.record(z.string(), z.record(z.string(), z.unknown()))
export type ProviderMetadata = z.infer<typeof providerMetadataSchema>

export const toolPermissionSchema = z.enum(["read", "mutate", "execute"])
export type ToolPermission = z.infer<typeof toolPermissionSchema>

export const toolApprovalPolicySchema = z.enum(["auto", "approval_required", "denied"])
export type ToolApprovalPolicy = z.infer<typeof toolApprovalPolicySchema>

export const truncationMetadataSchema = z
  .object({
    truncated: z.boolean(),
    charLimit: z.number().int().positive(),
    originalLength: z.number().int().nonnegative().optional(),
    returnedLength: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().optional(),
  })
  .strict()
export type TruncationMetadata = z.infer<typeof truncationMetadataSchema>

export const readToolInputSchema = z
  .object({
    path: z.string().min(1),
    offset: z.number().int().nonnegative().optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
export type ReadToolInput = z.infer<typeof readToolInputSchema>

export const readToolOutputSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(["file", "directory", "pdf", "document", "presentation", "spreadsheet", "image", "binary", "missing"]),
    content: z.string().optional(),
    entries: z
      .array(
        z
          .object({
            name: z.string().min(1),
            path: z.string().min(1),
            kind: z.enum(["file", "directory"]),
            sizeBytes: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .optional(),
    mimeType: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    image: z
      .object({
        mediaType: z.string().min(1).optional(),
        nativeVisionSupported: z.boolean(),
        description: z.string().optional(),
      })
      .strict()
      .optional(),
    truncation: truncationMetadataSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type ReadToolOutput = z.infer<typeof readToolOutputSchema>

export const searchToolInputSchema = z
  .object({
    mode: z.enum(["files", "text"]),
    query: z.string().min(1),
    path: z.string().min(1).optional(),
    regex: z.boolean().optional(),
    caseSensitive: z.boolean().optional(),
    includeHidden: z.boolean().optional(),
    maxResults: z.number().int().positive().max(500).optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
export type SearchToolInput = z.infer<typeof searchToolInputSchema>

export const searchMatchSchema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    text: z.string().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  })
  .strict()

export const searchToolOutputSchema = z
  .object({
    mode: z.enum(["files", "text"]),
    query: z.string().min(1),
    matches: z.array(searchMatchSchema),
    totalMatches: z.number().int().nonnegative(),
    truncation: truncationMetadataSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type SearchToolOutput = z.infer<typeof searchToolOutputSchema>

export const editOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("create"),
      path: z.string().min(1),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("overwrite"),
      path: z.string().min(1),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("replace"),
      path: z.string().min(1),
      oldText: z.string().min(1),
      newText: z.string(),
      expectedOccurrences: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("patch"),
      patch: z.string().min(1),
    })
    .strict(),
])
export type EditOperation = z.infer<typeof editOperationSchema>

export const editToolInputSchema = z
  .object({
    operations: z.array(editOperationSchema).min(1).max(20),
    dryRun: z.boolean().optional(),
  })
  .strict()
export type EditToolInput = z.infer<typeof editToolInputSchema>

export const editToolOutputSchema = z
  .object({
    changedFiles: z.array(
      z
        .object({
          path: z.string().min(1),
          operation: z.enum(["created", "overwritten", "edited", "patched"]),
        })
        .strict(),
    ),
    diff: z.string(),
    dryRun: z.boolean(),
    truncation: truncationMetadataSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type EditToolOutput = z.infer<typeof editToolOutputSchema>

export const bashToolInputSchema = z
  .object({
    operation: z.enum(["run", "start", "status", "output", "stop"]).optional(),
    command: z.string().min(1).optional(),
    processId: z.string().min(1).optional(),
    outputSequence: z.number().int().nonnegative().optional(),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const operation = input.operation ?? "run"
    if ((operation === "run" || operation === "start") && !input.command) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "command is required for run and start operations",
      })
    }
    if ((operation === "status" || operation === "output" || operation === "stop") && !input.processId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processId"],
        message: "processId is required for status, output, and stop operations",
      })
    }
  })
export type BashToolInput = z.infer<typeof bashToolInputSchema>

export const bashToolOutputSchema = z
  .object({
    operation: z.enum(["run", "start", "status", "output", "stop"]).optional(),
    command: z.string().min(1).optional(),
    cwd: z.string().min(1),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable().optional(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().int().nonnegative(),
    timedOut: z.boolean(),
    truncation: truncationMetadataSchema,
    shell: z
      .object({
        platform: z.string().min(1),
        kind: z.enum(["posix", "powershell", "cmd"]),
        executable: z.string().min(1),
      })
      .strict(),
    process: z
      .object({
        processId: z.string().min(1),
        status: z.enum(["running", "exited", "stopped", "missing"]),
        exitCode: z.number().int().nullable().optional(),
        signal: z.string().nullable().optional(),
        startedAt: z.string().optional(),
        exitedAt: z.string().optional(),
        nextOutputSequence: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
export type BashToolOutput = z.infer<typeof bashToolOutputSchema>

export const traceRetrieveScopeSchema = z.enum(["current_conversation", "recent_conversations", "project"])
export type TraceRetrieveScope = z.infer<typeof traceRetrieveScopeSchema>

export const traceRetrieveModeSchema = z.enum(["combined", "exact", "semantic"])
export type TraceRetrieveMode = z.infer<typeof traceRetrieveModeSchema>

export const traceRetrieveIncludeSchema = z.enum(["messages", "summaries", "tool_calls", "shell", "files", "errors", "decisions"])
export type TraceRetrieveInclude = z.infer<typeof traceRetrieveIncludeSchema>

export const traceRetrieveRoleSchema = z.enum(["user", "assistant", "any"])
export type TraceRetrieveRole = z.infer<typeof traceRetrieveRoleSchema>

export const traceRetrieveSourceKindSchema = z.enum([
  "message",
  "tool_call",
  "shell",
  "file",
  "patch",
  "error",
  "turn_summary",
  "conversation_summary",
  "verbatim_anchor",
])
export type TraceRetrieveSourceKind = z.infer<typeof traceRetrieveSourceKindSchema>

export const traceRetrieveSearchInputSchema = z
  .object({
    operation: z.literal("search").optional(),
    query: z.string().min(1),
    scope: traceRetrieveScopeSchema.optional(),
    conversationHint: z.string().min(1).optional(),
    conversationLimit: z.number().int().positive().max(50).optional(),
    turnNo: z.number().int().positive().max(10_000).optional(),
    role: traceRetrieveRoleSchema.optional(),
    mode: traceRetrieveModeSchema.optional(),
    include: z.array(traceRetrieveIncludeSchema).optional(),
    toolNames: z.array(toolNameSchema).optional(),
    paths: z.array(z.string().min(1)).max(20).optional(),
    command: z.string().min(1).optional(),
    createdAfter: z.string().min(1).optional(),
    createdBefore: z.string().min(1).optional(),
    limit: z.number().int().positive().max(20).optional(),
    includeRaw: z.boolean().optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
export type TraceRetrieveSearchInput = z.infer<typeof traceRetrieveSearchInputSchema>

export const traceRetrieveInspectArgsSchema = z
  .object({
    operation: z.literal("inspect"),
    handle: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    startTurnNo: z.number().int().positive().max(10_000).optional(),
    turnLimit: z.number().int().positive().max(100).optional(),
    include: z.array(traceRetrieveIncludeSchema).optional(),
    includeRaw: z.boolean().optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
  .refine((input) => Boolean(input.handle ?? input.conversationId ?? input.turnId ?? input.messageId ?? input.toolCallId), {
    message: "inspect requires handle, conversationId, turnId, messageId, or toolCallId",
  })
export type TraceRetrieveInspectArgs = z.infer<typeof traceRetrieveInspectArgsSchema>

export const traceRetrieveInspectInputSchema = traceRetrieveInspectArgsSchema
export type TraceRetrieveInspectInput = z.infer<typeof traceRetrieveInspectInputSchema>

export const traceRetrieveToolInputSchema = z.union([traceRetrieveSearchInputSchema, traceRetrieveInspectInputSchema])
export type TraceRetrieveToolInput = z.infer<typeof traceRetrieveToolInputSchema>

export const traceRetrieveSourceSchema = z
  .object({
    table: z.string().min(1),
    id: z.string().min(1),
  })
  .strict()

export const traceRetrieveConversationProvenanceSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).optional(),
    status: conversationStatusSchema.optional(),
    updatedAt: z.string().min(1).optional(),
    isCurrentConversation: z.boolean(),
  })
  .strict()

export const traceRetrieveAppliedFiltersSchema = z
  .object({
    operation: z.enum(["search", "inspect"]),
    scope: traceRetrieveScopeSchema.optional(),
    mode: traceRetrieveModeSchema.optional(),
    conversationLimit: z.number().int().positive().optional(),
    conversationIds: z.array(z.string().min(1)).optional(),
    turnNo: z.number().int().positive().optional(),
    role: traceRetrieveRoleSchema.optional(),
    startTurnNo: z.number().int().positive().optional(),
    turnLimit: z.number().int().positive().optional(),
    createdAfter: z.string().optional(),
    createdBefore: z.string().optional(),
    defaultDateWindowApplied: z.boolean().optional(),
    include: z.array(traceRetrieveIncludeSchema).optional(),
  })
  .strict()

export const traceRetrieveSearchResultSchema = z
  .object({
    handle: z.string().min(1),
    kind: traceRetrieveSourceKindSchema,
    projectId: z.string().min(1),
    conversationId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    sourceId: z.string().min(1),
    source: traceRetrieveSourceSchema,
    conversation: traceRetrieveConversationProvenanceSchema.optional(),
    inspectArgs: traceRetrieveInspectArgsSchema,
    title: z.string().min(1),
    snippet: z.string().optional(),
    summary: z.string().optional(),
    score: z.number().optional(),
    preserveVerbatim: z.boolean().optional(),
    turnNo: z.number().int().positive().optional(),
    messageRole: messageRoleSchema.optional(),
    createdAt: z.string().optional(),
    metadata: z.unknown().optional(),
  })
  .strict()

export const traceRetrieveExactResultSchema = z
  .object({
    handle: z.string().min(1),
    kind: z.literal("exact_source"),
    projectId: z.string().min(1),
    conversationId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    sourceId: z.string().min(1),
    title: z.string().min(1),
    content: z.string(),
    source: traceRetrieveSourceSchema,
    conversation: traceRetrieveConversationProvenanceSchema.optional(),
    turnNo: z.number().int().positive().optional(),
    messageRole: messageRoleSchema.optional(),
    truncation: truncationMetadataSchema,
    metadata: z.unknown().optional(),
  })
  .strict()

export const traceRetrieveToolOutputSchema = z
  .object({
    results: z.array(z.union([traceRetrieveSearchResultSchema, traceRetrieveExactResultSchema])),
    totalMatches: z.number().int().nonnegative(),
    truncation: truncationMetadataSchema,
    appliedFilters: traceRetrieveAppliedFiltersSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type TraceRetrieveToolOutput = z.infer<typeof traceRetrieveToolOutputSchema>

export const listProjectResourcesToolInputSchema = z
  .object({
    kind: projectResourceKindSchema.optional(),
    limit: z.number().int().positive().max(100).optional(),
  })
  .strict()
export type ListProjectResourcesToolInput = z.infer<typeof listProjectResourcesToolInputSchema>

export const listProjectResourcesToolOutputSchema = z
  .object({
    resources: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          kind: projectResourceKindSchema,
          source: projectResourceSourceSchema,
          uri: z.string().min(1).optional(),
          mimeType: z.string().min(1).optional(),
          sizeBytes: z.number().int().nonnegative().optional(),
          status: projectResourceStatusSchema,
        })
        .strict(),
    ),
    summary: z.string(),
    totalResources: z.number().int().nonnegative(),
    truncation: truncationMetadataSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type ListProjectResourcesToolOutput = z.infer<typeof listProjectResourcesToolOutputSchema>

export const normalizedToolCallSchema = z
  .object({
    toolCallId: z.string().min(1),
    toolName: toolNameSchema,
    input: z.unknown(),
    providerMetadata: providerMetadataSchema.optional(),
  })
  .strict()
export type NormalizedToolCall = z.infer<typeof normalizedToolCallSchema>

export const toolExecutionResultSchema = z
  .object({
    toolCallId: z.string().min(1),
    toolName: toolNameSchema,
    ok: z.boolean(),
    output: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        details: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
export type ToolExecutionResult = z.infer<typeof toolExecutionResultSchema>

export type ModelToolDefinition = {
  name: ToolName
  description: string
  inputSchema: z.ZodTypeAny
  resultSchema?: z.ZodTypeAny
}
