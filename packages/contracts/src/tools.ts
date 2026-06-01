import { z } from "zod"
import { conversationStatusSchema, messageRoleSchema, projectResourceKindSchema, projectResourceSourceSchema, projectResourceStatusSchema } from "./entities"

export const baseToolNameSchema = z.enum([
  "read",
  "search",
  "edit",
  "apply_patch",
  "bash",
  "trace_retrieve",
  "socrates_memory",
  "project_notes",
  "repo_docs",
  "soul",
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

export const soulDocumentSchema = z.enum(["identity", "operating_principles", "both"])
export type SoulDocument = z.infer<typeof soulDocumentSchema>

export const soulToolInputSchema = z
  .object({
    operation: z.literal("read"),
    document: soulDocumentSchema,
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
export type SoulToolInput = z.infer<typeof soulToolInputSchema>

export const soulDocumentOutputSchema = z
  .object({
    document: z.enum(["identity", "operating_principles"]),
    path: z.string().min(1),
    content: z.string(),
    truncation: truncationMetadataSchema,
  })
  .strict()

export const soulToolOutputSchema = z
  .object({
    operation: z.literal("read"),
    documents: z.array(soulDocumentOutputSchema),
    truncation: truncationMetadataSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type SoulToolOutput = z.infer<typeof soulToolOutputSchema>

export const editToolInputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string().optional(),
    oldString: z.string().min(1).optional(),
    newString: z.string().optional(),
    replaceAll: z.boolean().optional(),
    overwrite: z.literal(true).optional(),
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
      if (value.overwrite) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "overwrite is only valid with content whole-file writes." })
      }
      if (value.oldString === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "oldString is required for a targeted replace." })
      }
      if (value.newString === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "newString is required for a targeted replace." })
      }
    }
  })
export type EditToolInput = z.infer<typeof editToolInputSchema>

export const editToolModelInputSchema = z.union([
  z
    .object({
      path: z.string().min(1),
      oldString: z.string().min(1),
      newString: z.string(),
      replaceAll: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      path: z.string().min(1),
      content: z.string(),
      overwrite: z.literal(true).optional(),
      dryRun: z.boolean().optional(),
    })
    .strict(),
])

export const applyPatchToolInputSchema = z
  .object({
    patch: z.string().min(1).optional(),
    patchText: z
      .string()
      .min(1)
      .describe(
        "Patch text to apply. Prefer structured format: *** Begin Patch, then file sections like *** Update File: path with @@ hunks, *** Add File: path, or *** Delete File: path, ending with *** End Patch. In Update hunks, prefix unchanged lines with space, removed lines with -, and added lines with +. Add File content lines should start with +.",
      )
      .optional(),
    dryRun: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.patch === undefined && value.patchText === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide patchText." })
    }
    if (value.patch !== undefined && value.patchText !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide either patchText or patch, not both." })
    }
  })
  .transform((value) => ({
    patch: value.patch ?? value.patchText ?? "",
    ...(value.dryRun === undefined ? {} : { dryRun: value.dryRun }),
  }))
export type ApplyPatchToolInput = z.input<typeof applyPatchToolInputSchema>
export type NormalizedApplyPatchToolInput = z.output<typeof applyPatchToolInputSchema>

export const applyPatchToolModelInputSchema = z
  .object({
    patchText: z
      .string()
      .min(1)
      .describe(
        "Patch text to apply. Prefer structured format: *** Begin Patch, then file sections like *** Update File: path with @@ hunks, *** Add File: path, or *** Delete File: path, ending with *** End Patch. In Update hunks, prefix unchanged lines with space, removed lines with -, and added lines with +. Add File content lines should start with +. Read existing files before patching them.",
      ),
    dryRun: z.boolean().optional(),
  })
  .strict()

export const editToolOutputSchema = z
  .object({
    changedFiles: z.array(
      z
        .object({
          path: z.string().min(1),
          operation: z.enum(["created", "overwritten", "edited", "patched", "deleted", "renamed"]),
          previousPath: z.string().min(1).optional(),
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

export const terminalStatusSchema = z.enum(["running", "exited", "stopped", "detached", "stale", "awaiting_input", "missing"])
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
    message: z.string().optional(),
    reusedTerminal: z.boolean().optional(),
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
        systemPid: z.number().int().positive().optional(),
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

export const traceRetrieveModeSchema = z.enum(["combined", "exact", "semantic", "audit"])
export type TraceRetrieveMode = z.infer<typeof traceRetrieveModeSchema>

export const traceRetrieveIncludeSchema = z.enum(["messages", "summaries", "tool_calls", "shell", "files", "errors", "decisions"])
export type TraceRetrieveInclude = z.infer<typeof traceRetrieveIncludeSchema>

export const traceRetrieveRoleSchema = z.enum(["user", "assistant", "any"])
export type TraceRetrieveRole = z.infer<typeof traceRetrieveRoleSchema>

export const traceRetrieveEntryTypeSchema = z.enum([
  "user_query",
  "assistant_response",
  "qa_pair",
  "continuation_summary",
  "tool_call",
  "shell",
  "file",
  "patch",
  "error",
])
export type TraceRetrieveEntryType = z.infer<typeof traceRetrieveEntryTypeSchema>

const traceRetrieveMessageEntryTypeSchema = z.enum([
  "user_query",
  "assistant_response",
  "continuation_summary",
  "tool_call",
  "shell",
  "file",
  "patch",
  "error",
])

export const traceRetrieveProvenanceKindSchema = z.enum([
  "original_turn",
  "attachment_origin",
  "secondary_mention",
  "continuation_summary",
  "audit_event",
])
export type TraceRetrieveProvenanceKind = z.infer<typeof traceRetrieveProvenanceKindSchema>

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
    mode: traceRetrieveModeSchema.optional(),
    query: z.string().min(1).optional(),
    scope: traceRetrieveScopeSchema.optional(),
    conversationTitle: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    conversationLimit: z.number().int().positive().max(50).optional(),
    conversationOffset: z.number().int().nonnegative().max(10_000).optional(),
    perConversationLimit: z.number().int().positive().max(20).optional(),
    turnNo: z.number().int().positive().max(10_000).optional(),
    role: traceRetrieveRoleSchema.optional(),
    entryType: traceRetrieveEntryTypeSchema.optional(),
    hasAttachment: z.boolean().optional(),
    include: z.array(traceRetrieveIncludeSchema).optional(),
    toolNames: z.array(toolNameSchema).optional(),
    paths: z.array(z.string().min(1)).max(20).optional(),
    command: z.string().min(1).optional(),
    createdAfter: z.string().min(1).optional(),
    createdBefore: z.string().min(1).optional(),
    updatedAfter: z.string().min(1).optional(),
    updatedBefore: z.string().min(1).optional(),
    limit: z.number().int().positive().max(20).optional(),
    includeRaw: z.boolean().optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const hasQuery = input.query !== undefined
    const hasTurnNo = input.turnNo !== undefined
    if (!hasQuery && !hasTurnNo && input.mode !== undefined && input.mode !== "exact") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Queryless browse is exact-only; provide query for semantic, combined, or audit search.",
      })
    }
    if (hasTurnNo && !hasQuery && input.mode !== undefined && input.mode !== "exact") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mode"],
        message: "turnNo ordinal lookup is exact-only; omit mode or use mode=\"exact\".",
      })
    }
  })
export type TraceRetrieveSearchInput = z.infer<typeof traceRetrieveSearchInputSchema>

const traceRetrieveEmptyStringOptionalKeys = new Set([
  "command",
  "createdAfter",
  "createdBefore",
  "updatedAfter",
  "updatedBefore",
  "handle",
  "conversationId",
  "conversationTitle",
  "turnId",
  "messageId",
  "toolId",
  "toolCallId",
])

const traceRetrieveEmptyArrayOptionalKeys = new Set(["include", "paths", "toolNames"])

const traceRetrieveSearchOnlyKeys = new Set([
  "scope",
  "mode",
  "conversationTitle",
  "conversationLimit",
  "conversationOffset",
  "perConversationLimit",
  "toolNames",
  "createdAfter",
  "createdBefore",
  "updatedAfter",
  "updatedBefore",
  "limit",
])

const traceRetrieveInspectOnlyKeys = new Set(["resultNumber", "handle", "turnId", "messageId", "toolId", "toolCallId", "startTurnNo", "turnLimit"])

const traceRetrieveLooksLikeSearch = (value: Record<string, unknown>): boolean =>
  value.operation === "search" ||
  "scope" in value ||
  "mode" in value ||
  "conversationId" in value ||
  "conversationTitle" in value ||
  "conversationLimit" in value ||
  "conversationOffset" in value ||
  "perConversationLimit" in value ||
  "turnNo" in value ||
  "role" in value ||
  "toolNames" in value ||
  "createdAfter" in value ||
  "createdBefore" in value ||
  "updatedAfter" in value ||
  "updatedBefore" in value ||
  "limit" in value ||
  ("query" in value && value.operation !== "inspect")

export const normalizeTraceRetrieveInput = (value: unknown): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value
  }
  const normalized: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  for (const [key, fieldValue] of Object.entries(normalized)) {
    if (traceRetrieveEmptyStringOptionalKeys.has(key) && typeof fieldValue === "string" && fieldValue.trim().length === 0) {
      delete normalized[key]
      continue
    }
    if (traceRetrieveEmptyArrayOptionalKeys.has(key) && Array.isArray(fieldValue) && fieldValue.length === 0) {
      delete normalized[key]
    }
  }
  if (normalized.operation === "inspect") {
    if (typeof normalized.toolId === "string" && normalized.toolCallId === undefined) {
      normalized.toolCallId = normalized.toolId
    }
    delete normalized.toolId
    for (const key of traceRetrieveSearchOnlyKeys) {
      delete normalized[key]
    }
  } else if (typeof normalized.messageId === "string") {
    return {
      operation: "inspect",
      messageId: normalized.messageId,
      ...(typeof normalized.charLimit === "number" ? { charLimit: normalized.charLimit } : {}),
    }
  } else if (typeof normalized.toolId === "string" || typeof normalized.toolCallId === "string") {
    if (normalized.mode === "audit") {
      return {
        operation: "inspect",
        toolCallId: typeof normalized.toolId === "string" ? normalized.toolId : normalized.toolCallId,
        ...(typeof normalized.charLimit === "number" ? { charLimit: normalized.charLimit } : {}),
      }
    }
  } else if (traceRetrieveLooksLikeSearch(normalized)) {
    for (const key of traceRetrieveInspectOnlyKeys) {
      delete normalized[key]
    }
  }
  return normalized
}

export const traceRetrieveInspectArgsSchema = z
  .object({
    operation: z.literal("inspect"),
    resultNumber: z.number().int().positive().max(20).optional(),
    query: z.string().min(1).optional(),
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
  .refine((input) => Boolean(input.resultNumber ?? input.query ?? input.turnNo ?? input.command ?? input.paths ?? input.handle ?? input.conversationId ?? input.turnId ?? input.messageId ?? input.toolCallId), {
    message: "inspect requires resultNumber, natural filters, handle, conversationId, turnId, messageId, or toolCallId",
  })
export type TraceRetrieveInspectArgs = z.infer<typeof traceRetrieveInspectArgsSchema>

export const traceRetrieveInspectInputSchema = traceRetrieveInspectArgsSchema
export type TraceRetrieveInspectInput = z.infer<typeof traceRetrieveInspectInputSchema>

export const traceRetrieveToolInputSchema = z.preprocess(
  normalizeTraceRetrieveInput,
  z.union([traceRetrieveSearchInputSchema, traceRetrieveInspectInputSchema]),
)
export type TraceRetrieveToolInput = z.infer<typeof traceRetrieveToolInputSchema>

const traceRetrieveModelExactSearchInputSchema = z
  .object({
    operation: z.literal("search").optional(),
    mode: z.literal("exact").optional(),
    query: z.string().min(1).optional(),
    scope: traceRetrieveScopeSchema.optional(),
    conversationTitle: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    conversationLimit: z.number().int().positive().max(50).optional(),
    conversationOffset: z.number().int().nonnegative().max(10_000).optional(),
    perConversationLimit: z.number().int().positive().max(20).optional(),
    turnNo: z.number().int().positive().max(10_000).optional(),
    role: traceRetrieveRoleSchema.optional(),
    entryType: traceRetrieveEntryTypeSchema.optional(),
    hasAttachment: z.boolean().optional(),
    createdAfter: z.string().min(1).optional(),
    createdBefore: z.string().min(1).optional(),
    updatedAfter: z.string().min(1).optional(),
    updatedBefore: z.string().min(1).optional(),
    limit: z.number().int().positive().max(20).optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const hasQuery = input.query !== undefined
    const hasTurnNo = input.turnNo !== undefined
    if (!hasQuery && !hasTurnNo && input.mode !== undefined && input.mode !== "exact") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Queryless browse is exact-only.",
      })
    }
  })

const traceRetrieveModelSemanticSearchInputSchema = z
  .object({
    operation: z.literal("search").optional(),
    mode: z.enum(["semantic", "combined"]),
    query: z.string().min(1),
    scope: traceRetrieveScopeSchema.optional(),
    conversationTitle: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    conversationLimit: z.number().int().positive().max(50).optional(),
    conversationOffset: z.number().int().nonnegative().max(10_000).optional(),
    limit: z.number().int().positive().max(20).optional(),
    turnNo: z.number().int().positive().max(10_000).optional(),
    role: traceRetrieveRoleSchema.optional(),
    entryType: traceRetrieveEntryTypeSchema.optional(),
    hasAttachment: z.boolean().optional(),
    createdAfter: z.string().min(1).optional(),
    createdBefore: z.string().min(1).optional(),
    updatedAfter: z.string().min(1).optional(),
    updatedBefore: z.string().min(1).optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()

const traceRetrieveModelAuditSearchInputSchema = z
  .object({
    operation: z.literal("search").optional(),
    mode: z.literal("audit"),
    query: z.string().min(1),
    scope: traceRetrieveScopeSchema.optional(),
    conversationTitle: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    conversationLimit: z.number().int().positive().max(50).optional(),
    turnNo: z.number().int().positive().max(10_000).optional(),
    role: traceRetrieveRoleSchema.optional(),
    entryType: traceRetrieveEntryTypeSchema.optional(),
    hasAttachment: z.boolean().optional(),
    include: z.array(traceRetrieveIncludeSchema).optional(),
    paths: z.array(z.string().min(1)).max(20).optional(),
    command: z.string().min(1).optional(),
    toolId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(20).optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()

export const traceRetrieveModelSearchInputSchema = z.union([
  traceRetrieveModelExactSearchInputSchema,
  traceRetrieveModelSemanticSearchInputSchema,
  traceRetrieveModelAuditSearchInputSchema,
])

export const traceRetrieveModelInspectInputSchema = z
  .object({
    operation: z.literal("inspect"),
    resultNumber: z.number().int().positive().max(20).optional(),
    query: z.string().min(1).optional(),
    turnNo: z.number().int().positive().max(10_000).optional(),
    role: traceRetrieveRoleSchema.optional(),
    handle: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    toolId: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    startTurnNo: z.number().int().positive().max(10_000).optional(),
    turnLimit: z.number().int().positive().max(100).optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
  .refine(
    (input) =>
      Boolean(
        input.resultNumber ??
          input.query ??
          input.turnNo ??
          input.handle ??
          input.conversationId ??
          input.turnId ??
          input.messageId ??
          input.toolId ??
          input.toolCallId,
      ),
    {
      message: "inspect requires resultNumber, natural filters, handle, conversationId, turnId, messageId, or toolCallId",
    },
  )
export const traceRetrieveToolModelInputSchema = z.preprocess(
  normalizeTraceRetrieveInput,
  z.union([traceRetrieveModelSearchInputSchema, traceRetrieveModelInspectInputSchema]),
)

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
    conversationOffset: z.number().int().nonnegative().optional(),
    perConversationLimit: z.number().int().positive().optional(),
    conversationTitle: z.string().min(1).optional(),
    conversationId: z.string().min(1).optional(),
    conversationIds: z.array(z.string().min(1)).optional(),
    turnNo: z.number().int().positive().optional(),
    role: traceRetrieveRoleSchema.optional(),
    entryType: traceRetrieveEntryTypeSchema.optional(),
    hasAttachment: z.boolean().optional(),
    startTurnNo: z.number().int().positive().optional(),
    turnLimit: z.number().int().positive().optional(),
    createdAfter: z.string().optional(),
    createdBefore: z.string().optional(),
    updatedAfter: z.string().optional(),
    updatedBefore: z.string().optional(),
    defaultDateWindowApplied: z.boolean().optional(),
    include: z.array(traceRetrieveIncludeSchema).optional(),
  })
  .strict()

export const traceRetrieveSearchResultSchema = z
  .object({
    resultNumber: z.number().int().positive(),
    text: z.string(),
    entryType: traceRetrieveMessageEntryTypeSchema,
    conversationTitle: z.string().min(1),
    conversationId: z.string().min(1),
    messageId: z.string().min(1).optional(),
    toolId: z.string().min(1).optional(),
    turnNo: z.number().int().positive().optional(),
    messageNo: z.number().int().positive().optional(),
    provenanceKind: traceRetrieveProvenanceKindSchema.optional(),
    pairedUserMessageNo: z.number().int().positive().optional(),
    pairedUserPreview: z.string().optional(),
  })
  .strict()

export const traceRetrieveQaPairResultSchema = z
  .object({
    resultNumber: z.number().int().positive(),
    entryType: z.literal("qa_pair"),
    conversationTitle: z.string().min(1),
    conversationId: z.string().min(1),
    turnNo: z.number().int().positive(),
    turnId: z.string().min(1),
    userMessageId: z.string().min(1).optional(),
    assistantMessageId: z.string().min(1).optional(),
    userText: z.string().optional(),
    assistantText: z.string().optional(),
    startedAt: z.string().min(1),
    completedAt: z.string().nullable().optional(),
    messageId: z.string().min(1).optional(),
    toolId: z.string().min(1).optional(),
    messageNo: z.number().int().positive().optional(),
    provenanceKind: traceRetrieveProvenanceKindSchema.optional(),
    pairedUserMessageNo: z.number().int().positive().optional(),
    pairedUserPreview: z.string().optional(),
  })
  .strict()

export const traceRetrieveExactResultSchema = z
  .object({
    resultNumber: z.number().int().positive().optional(),
    content: z.string(),
    entryType: traceRetrieveMessageEntryTypeSchema,
    conversationId: z.string().min(1).optional(),
    conversationTitle: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    toolId: z.string().min(1).optional(),
    turnNo: z.number().int().positive().optional(),
    messageNo: z.number().int().positive().optional(),
    provenanceKind: traceRetrieveProvenanceKindSchema.optional(),
    pairedUserMessageNo: z.number().int().positive().optional(),
    pairedUserPreview: z.string().optional(),
    truncation: truncationMetadataSchema.optional(),
  })
  .strict()

export const traceRetrieveToolOutputSchema = z
  .object({
    results: z.array(z.union([traceRetrieveSearchResultSchema, traceRetrieveQaPairResultSchema, traceRetrieveExactResultSchema])),
    totalMatches: z.number().int().nonnegative(),
    truncation: truncationMetadataSchema,
    appliedFilters: traceRetrieveAppliedFiltersSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type TraceRetrieveToolOutput = z.infer<typeof traceRetrieveToolOutputSchema>

export const socratesMemoryScopeSchema = z.enum(["primary", "project", "all"])
export type SocratesMemoryScope = z.infer<typeof socratesMemoryScopeSchema>

export const socratesMemoryCategorySchema = z.enum(["learned_patterns", "tool_usage", "project_brief", "project_memory", "diary"])
export type SocratesMemoryCategory = z.infer<typeof socratesMemoryCategorySchema>

export const socratesMemorySearchModeSchema = z.enum(["exact_phrase", "keyword_all", "keyword_any", "whole_word", "regex"])
export type SocratesMemorySearchMode = z.infer<typeof socratesMemorySearchModeSchema>

export const socratesMemoryResultTypeSchema = z.enum(["file", "section", "line_match", "diary_entry"])
export type SocratesMemoryResultType = z.infer<typeof socratesMemoryResultTypeSchema>

export const socratesMemoryToolInputSchema = z
  .object({
    operation: z.enum(["search", "read"]),
    scope: socratesMemoryScopeSchema.optional(),
    category: socratesMemoryCategorySchema.optional(),
    path: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    searchMode: socratesMemorySearchModeSchema.optional(),
    modifiedAfter: z.string().min(1).optional(),
    modifiedBefore: z.string().min(1).optional(),
    diaryDateAfter: z.string().min(1).optional(),
    diaryDateBefore: z.string().min(1).optional(),
    entryAfter: z.string().min(1).optional(),
    entryBefore: z.string().min(1).optional(),
    year: z.number().int().min(1970).max(9999).optional(),
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional(),
    includeSections: z.boolean().optional(),
    memoryLimit: z.number().int().positive().max(50).optional(),
    memoryOffset: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(20).optional(),
    offset: z.number().int().nonnegative().optional(),
    contextLines: z.number().int().nonnegative().max(100).optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.searchMode && !input.query) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["searchMode"], message: "searchMode requires query." })
    }
  })
export type SocratesMemoryToolInput = z.infer<typeof socratesMemoryToolInputSchema>

export const socratesMemoryToolOutputSchema = z
  .object({
    operation: z.enum(["search", "read"]),
    scope: socratesMemoryScopeSchema.optional(),
    category: socratesMemoryCategorySchema.optional(),
    results: z
      .array(
        z
          .object({
            resultNumber: z.number().int().positive(),
            resultType: socratesMemoryResultTypeSchema,
            path: z.string().min(1),
            title: z.string().optional(),
            matchedText: z.string().optional(),
            contextBefore: z.string().optional(),
            contextAfter: z.string().optional(),
            snippet: z.string().optional(),
            modifiedAt: z.string().min(1),
            diaryDate: z.string().optional(),
            entryTimestamp: z.string().optional(),
            lineStart: z.number().int().positive().optional(),
            lineEnd: z.number().int().positive().optional(),
            score: z.number().optional(),
            inspectArgs: z
              .object({
                operation: z.literal("read"),
                path: z.string().min(1),
                category: socratesMemoryCategorySchema.optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      ),
    totalMatches: z.number().int().nonnegative(),
    truncation: truncationMetadataSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type SocratesMemoryToolOutput = z.infer<typeof socratesMemoryToolOutputSchema>

export const projectNotesToolInputSchema = z
  .object({
    operation: z.enum(["read", "search", "patch"]),
    query: z.string().min(1).optional(),
    oldText: z.string().optional(),
    newText: z.string().optional(),
    replaceAll: z.boolean().optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.operation === "search" && !input.query) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["query"], message: "search requires query." })
    }
    if (input.operation === "patch" && (input.oldText === undefined || input.newText === undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "patch requires oldText and newText." })
    }
  })
export type ProjectNotesToolInput = z.infer<typeof projectNotesToolInputSchema>

export const projectNotesToolOutputSchema = z
  .object({
    operation: z.enum(["read", "search", "patch"]),
    path: z.string().min(1),
    content: z.string().optional(),
    matches: z
      .array(
        z
          .object({
            line: z.number().int().positive(),
            text: z.string(),
          })
          .strict(),
      )
      .optional(),
    changed: z.boolean().optional(),
    truncation: truncationMetadataSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type ProjectNotesToolOutput = z.infer<typeof projectNotesToolOutputSchema>

export const repoDocFileSchema = z.enum([
  "REPO_RULES.md",
  "APP_FLOW.md",
  "FRONTEND_BACKEND_CONTRACT.md",
  "DB_STRUCTURE.md",
  "PROVIDER_USAGE.md",
  "REPO_STRCUTURE.md",
])
export type RepoDocFile = z.infer<typeof repoDocFileSchema>

export const repoDocsToolInputSchema = z
  .object({
    operation: z.enum(["read", "search", "patch"]),
    path: repoDocFileSchema.optional(),
    query: z.string().min(1).optional(),
    oldText: z.string().optional(),
    newText: z.string().optional(),
    replaceAll: z.boolean().optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.operation === "search" && !input.query) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["query"], message: "search requires query." })
    }
    if (input.operation === "patch") {
      if (!input.path) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["path"], message: "patch requires path." })
      }
      if (input.oldText === undefined || input.newText === undefined) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "patch requires oldText and newText." })
      }
    }
  })
export type RepoDocsToolInput = z.infer<typeof repoDocsToolInputSchema>

export const repoDocsToolOutputSchema = z
  .object({
    operation: z.enum(["read", "search", "patch"]),
    path: z.string().min(1).optional(),
    paths: z.array(z.string().min(1)).optional(),
    content: z.string().optional(),
    matches: z
      .array(
        z
          .object({
            path: z.string().min(1),
            line: z.number().int().positive(),
            text: z.string(),
          })
          .strict(),
      )
      .optional(),
    changed: z.boolean().optional(),
    truncation: truncationMetadataSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type RepoDocsToolOutput = z.infer<typeof repoDocsToolOutputSchema>

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
    providerToolCallId: z.string().min(1).optional(),
    toolName: toolNameSchema,
    input: z.unknown(),
    providerMetadata: providerMetadataSchema.optional(),
  })
  .strict()
export type NormalizedToolCall = z.infer<typeof normalizedToolCallSchema>

export const toolExecutionResultSchema = z
  .object({
    toolCallId: z.string().min(1),
    providerToolCallId: z.string().min(1).optional(),
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
