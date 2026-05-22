import { z } from "zod"
import { projectResourceKindSchema, projectResourceSourceSchema, projectResourceStatusSchema } from "./entities"

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
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(600_000).optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
export type BashToolInput = z.infer<typeof bashToolInputSchema>

export const bashToolOutputSchema = z
  .object({
    command: z.string().min(1),
    cwd: z.string().min(1),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable().optional(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().int().nonnegative(),
    timedOut: z.boolean(),
    truncation: truncationMetadataSchema,
  })
  .strict()
export type BashToolOutput = z.infer<typeof bashToolOutputSchema>

export const traceRetrieveToolInputSchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    turnId: z.string().min(1).optional(),
    toolNames: z.array(toolNameSchema).optional(),
    path: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    query: z.string().min(1).optional(),
    includeRaw: z.boolean().optional(),
    limit: z.number().int().positive().max(50).optional(),
    charLimit: z.number().int().positive().max(80_000).optional(),
  })
  .strict()
export type TraceRetrieveToolInput = z.infer<typeof traceRetrieveToolInputSchema>

export const traceRetrieveToolOutputSchema = z
  .object({
    traces: z.array(
      z
        .object({
          toolCallId: z.string().min(1),
          turnId: z.string().min(1),
          conversationId: z.string().min(1),
          toolName: z.string().min(1),
          status: z.string().min(1),
          summary: z.string(),
          arguments: z.unknown().optional(),
          result: z.unknown().optional(),
          startedAt: z.string().optional(),
          completedAt: z.string().optional(),
        })
        .strict(),
    ),
    totalMatches: z.number().int().nonnegative(),
    truncation: truncationMetadataSchema,
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
