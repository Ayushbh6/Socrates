import { z } from "zod"

export const MAX_COMPACTION_LINE_CHARS = 1_200
export const MAX_COMPACTION_GOAL_CHARS = 1_500
export const MAX_COMPACTION_SUMMARY_CHARS = 24_000

export const compactionLinesSchema = z.array(z.string().min(1).max(MAX_COMPACTION_LINE_CHARS)).max(80)
export const compactionAnchorSchema = z.string().max(MAX_COMPACTION_LINE_CHARS).regex(/^Turn \d+:/)

const totalChars = (value: Record<string, unknown>): number =>
  Object.values(value).reduce<number>((total, field) => {
    if (typeof field === "string") return total + field.length
    if (Array.isArray(field)) return total + field.reduce<number>((sum, item) => sum + (typeof item === "string" ? item.length : 0), 0)
    return total
  }, 0)

const boundedSummary = <T extends z.ZodTypeAny>(schema: T) =>
  schema.superRefine((value, context) => {
    if (totalChars(value as Record<string, unknown>) > MAX_COMPACTION_SUMMARY_CHARS) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Compaction summary exceeds ${MAX_COMPACTION_SUMMARY_CHARS} characters.` })
    }
  })

const chatCompactionObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    goal: z.string().min(1).max(MAX_COMPACTION_GOAL_CHARS),
    constraints: compactionLinesSchema,
    done: compactionLinesSchema,
    inProgress: compactionLinesSchema,
    blocked: compactionLinesSchema,
    decisions: compactionLinesSchema,
    nextSteps: compactionLinesSchema,
    criticalContext: compactionLinesSchema,
    relevantFiles: compactionLinesSchema,
    toolState: compactionLinesSchema,
    anchors: z.array(compactionAnchorSchema).max(80),
  })
  .strict()

export const chatCompactionSchema = boundedSummary(chatCompactionObjectSchema)

const memoryCompactionObjectSchema = z
  .object({
    schemaVersion: z.literal(1),
    goal: z.string().min(1).max(MAX_COMPACTION_GOAL_CHARS),
    manifestScope: compactionLinesSchema,
    investigated: compactionLinesSchema,
    changed: compactionLinesSchema,
    skipped: compactionLinesSchema,
    blocked: compactionLinesSchema,
    decisions: compactionLinesSchema,
    nextSteps: compactionLinesSchema,
    criticalContext: compactionLinesSchema,
    toolState: compactionLinesSchema,
    anchors: z.array(compactionAnchorSchema).max(80),
  })
  .strict()

export const memoryCompactionSchema = boundedSummary(memoryCompactionObjectSchema)

export const anchorRepairSchema = z
  .object({
    anchors: z.array(compactionAnchorSchema).max(80),
  })
  .strict()

export const chatCompactionDraftSchema = chatCompactionObjectSchema.extend({
  anchors: compactionLinesSchema,
})

export const memoryCompactionDraftSchema = memoryCompactionObjectSchema.extend({
  anchors: compactionLinesSchema,
})

export type ChatCompaction = z.infer<typeof chatCompactionSchema>
export type MemoryCompaction = z.infer<typeof memoryCompactionSchema>
export type AnchorRepairOutput = z.infer<typeof anchorRepairSchema>
