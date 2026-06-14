import { z } from "zod"

export const compactionLinesSchema = z.array(z.string().min(1)).max(80)
export const compactionAnchorSchema = z.string().regex(/^Turn \d+:/)

export const chatCompactionSchema = z
  .object({
    schemaVersion: z.literal(1),
    goal: z.string().min(1),
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

export const memoryCompactionSchema = z
  .object({
    schemaVersion: z.literal(1),
    goal: z.string().min(1),
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

export const anchorRepairSchema = z
  .object({
    anchors: z.array(compactionAnchorSchema).max(80),
  })
  .strict()

export const chatCompactionDraftSchema = chatCompactionSchema.extend({
  anchors: compactionLinesSchema,
})

export const memoryCompactionDraftSchema = memoryCompactionSchema.extend({
  anchors: compactionLinesSchema,
})

export type ChatCompaction = z.infer<typeof chatCompactionSchema>
export type MemoryCompaction = z.infer<typeof memoryCompactionSchema>
export type AnchorRepairOutput = z.infer<typeof anchorRepairSchema>
