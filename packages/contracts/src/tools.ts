import { z } from "zod"
import { conversationStatusSchema, messageRoleSchema, projectResourceKindSchema, projectResourceSourceSchema, projectResourceStatusSchema } from "./entities"

export const baseToolNameSchema = z.enum([
  "read",
  "search",
  "edit",
  "apply_patch",
  "bash",
  "trace_retrieve",
  "list_project_resources",
  "mcp_registry",
])
export const dynamicMcpToolNameSchema = z.string().regex(/^mcp__[a-z0-9_-]+__[a-zA-Z0-9_-]+$/)
export const toolNameSchema = z.union([baseToolNameSchema, dynamicMcpToolNameSchema])
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
    mtimeMs: z.number().nonnegative().optional(),
    contentHash: z.string().min(1).optional(),
    lineEnding: z.enum(["lf", "crlf", "cr", "mixed", "none"]).optional(),
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
    maxResults: z.number().int().positive().max(50).optional(),
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

export const editToolInputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string().optional(),
    oldString: z.string().min(1).optional(),
    newString: z.string().optional(),
    replaceAll: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasContent = value.content !== undefined
    const hasReplace = value.oldString !== undefined || value.newString !== undefined
    if (hasContent === hasReplace) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either content for a whole-file write or oldString/newString for a targeted replace, but not both.",
      })
      return
    }
    if (!hasContent && !hasReplace) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide content for a whole-file write or oldString/newString for a targeted replace.",
      })
      return
    }
    if (hasReplace) {
      if (value.oldString === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "oldString is required for a targeted replace." })
      }
      if (value.newString === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "newString is required for a targeted replace." })
      }
    }
  })
export type EditToolInput = z.infer<typeof editToolInputSchema>

export const applyPatchToolInputSchema = z
  .object({
    patch: z.string().min(1),
    dryRun: z.boolean().optional(),
  })
  .strict()
export type ApplyPatchToolInput = z.infer<typeof applyPatchToolInputSchema>

export const editToolOutputSchema = z
  .object({
    changedFiles: z.array(
      z
        .object({
          path: z.string().min(1),
          operation: z.enum(["created", "overwritten", "edited", "patched"]),
          verification: z.literal("verified").optional(),
          contentHashBefore: z.string().min(1).optional(),
          contentHashAfter: z.string().min(1).optional(),
          sizeBytesBefore: z.number().int().nonnegative().optional(),
          sizeBytesAfter: z.number().int().nonnegative().optional(),
          lineDelta: z.number().int().optional(),
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

export const applyPatchToolOutputSchema = editToolOutputSchema
export type ApplyPatchToolOutput = EditToolOutput

export const terminalStatusSchema = z.enum(["running", "exited", "stopped", "stale", "awaiting_input", "missing"])
export type TerminalStatus = z.infer<typeof terminalStatusSchema>

export const bashTerminalMetadataSchema = z
  .object({
    terminalId: z.string().min(1),
    name: z.string().min(1),
    status: terminalStatusSchema,
    autoDetached: z.boolean().optional(),
    awaitingInput: z.boolean().optional(),
    lastPrompt: z.string().optional(),
    nextOutputSequence: z.number().int().nonnegative().optional(),
    startedAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strict()
export type BashTerminalMetadata = z.infer<typeof bashTerminalMetadataSchema>

export const bashToolInputSchema = z
  .object({
    operation: z.enum(["run", "start", "status", "output", "stop"]).optional(),
    command: z.string().min(1).optional(),
    processId: z.string().min(1).optional(),
    terminalId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
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
  })
export type BashToolInput = z.infer<typeof bashToolInputSchema>

export const bashToolModelInputSchema = z
  .object({
    operation: z.enum(["run", "start", "status", "output", "stop"]).optional(),
    command: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    target: z.string().min(1).optional(),
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
  })

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
    terminal: bashTerminalMetadataSchema.optional(),
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
    resultNumber: z.number().int().positive().max(20).optional(),
    query: z.string().min(1).optional(),
    conversationHint: z.string().min(1).optional(),
    turnNo: z.number().int().positive().max(10_000).optional(),
    role: traceRetrieveRoleSchema.optional(),
    paths: z.array(z.string().min(1)).max(20).optional(),
    command: z.string().min(1).optional(),
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
  .refine((input) => Boolean(input.resultNumber ?? input.query ?? input.conversationHint ?? input.turnNo ?? input.command ?? input.paths ?? input.handle ?? input.conversationId ?? input.turnId ?? input.messageId ?? input.toolCallId), {
    message: "inspect requires resultNumber, natural filters, handle, conversationId, turnId, messageId, or toolCallId",
  })
export type TraceRetrieveInspectArgs = z.infer<typeof traceRetrieveInspectArgsSchema>

export const traceRetrieveInspectInputSchema = traceRetrieveInspectArgsSchema
export type TraceRetrieveInspectInput = z.infer<typeof traceRetrieveInspectInputSchema>

export const traceRetrieveToolInputSchema = z.union([traceRetrieveSearchInputSchema, traceRetrieveInspectInputSchema])
export type TraceRetrieveToolInput = z.infer<typeof traceRetrieveToolInputSchema>

export const traceRetrieveModelSearchInputSchema = traceRetrieveSearchInputSchema.omit({ includeRaw: true })
export const traceRetrieveModelInspectInputSchema = z
  .object({
    operation: z.literal("inspect"),
    resultNumber: z.number().int().positive().max(20).optional(),
    query: z.string().min(1).optional(),
    conversationHint: z.string().min(1).optional(),
    turnNo: z.number().int().positive().max(10_000).optional(),
    role: traceRetrieveRoleSchema.optional(),
    paths: z.array(z.string().min(1)).max(20).optional(),
    command: z.string().min(1).optional(),
    startTurnNo: z.number().int().positive().max(10_000).optional(),
    turnLimit: z.number().int().positive().max(100).optional(),
    include: z.array(traceRetrieveIncludeSchema).optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
  .refine((input) => Boolean(input.resultNumber ?? input.query ?? input.conversationHint ?? input.turnNo ?? input.command ?? input.paths), {
    message: "inspect requires resultNumber or natural filters",
  })
export const traceRetrieveToolModelInputSchema = z.union([traceRetrieveModelSearchInputSchema, traceRetrieveModelInspectInputSchema])

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
    resultNumber: z.number().int().positive().optional(),
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
    inspectHint: z.string().min(1).optional(),
    conversationTitle: z.string().min(1).optional(),
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
    resultNumber: z.number().int().positive().optional(),
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
    conversationTitle: z.string().min(1).optional(),
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

export const mcpRegistryOperationSchema = z.enum(["list", "describe", "check", "configure"])
export type McpRegistryOperation = z.infer<typeof mcpRegistryOperationSchema>

export const mcpRegistryToolInputSchema = z
  .object({
    operation: mcpRegistryOperationSchema,
    serverId: z.string().min(1).optional(),
    serverName: z.string().min(1).optional(),
    preset: z.enum(["playwright"]).optional(),
  })
  .strict()
export type McpRegistryToolInput = z.infer<typeof mcpRegistryToolInputSchema>

export const mcpRegistryToolModelInputSchema = z
  .object({
    operation: mcpRegistryOperationSchema,
    serverName: z.string().min(1).optional(),
    preset: z.enum(["playwright"]).optional(),
  })
  .strict()

export const mcpRegistryServerSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    configured: z.boolean(),
    enabled: z.boolean(),
    bundled: z.boolean().optional(),
    requiresSecrets: z.boolean(),
    status: z.enum(["available", "missing", "failed", "unknown"]),
    toolCount: z.number().int().nonnegative().optional(),
    configPath: z.string().min(1).optional(),
    envPath: z.string().min(1).optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict()

export const mcpRegistryToolDescriptorSchema = z
  .object({
    name: z.string().min(1),
    dynamicName: dynamicMcpToolNameSchema,
    description: z.string().optional(),
    inputSchema: z.unknown().optional(),
  })
  .strict()

export const mcpRegistryToolOutputSchema = z
  .object({
    operation: mcpRegistryOperationSchema,
    configPath: z.string().min(1),
    envPath: z.string().min(1),
    servers: z.array(mcpRegistryServerSchema).optional(),
    server: mcpRegistryServerSchema.optional(),
    tools: z.array(mcpRegistryToolDescriptorSchema).optional(),
    docs: z.string().optional(),
    configured: z.boolean().optional(),
    summary: z.string(),
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type McpRegistryToolOutput = z.infer<typeof mcpRegistryToolOutputSchema>

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
