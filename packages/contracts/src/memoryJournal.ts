import { z } from "zod"
import { truncationMetadataSchema } from "./tools"

export const memoryJournalSkillActionSchema = z.enum([
  "inspected",
  "proposed_create",
  "proposed_update",
  "already_represented",
])

export const memoryAgentJournalOutputSchema = z
  .object({
    summary: z.string().min(1).max(1_500),
    patternsObserved: z
      .array(
        z
          .object({
            name: z.string().min(1).max(120),
            finding: z.string().min(1).max(1_000),
            evidenceTurnIds: z.array(z.string().min(1).max(200)).max(5),
          })
          .strict(),
      )
      .max(8),
    skillsAffected: z
      .array(
        z
          .object({
            skillId: z.string().min(1).max(256).optional(),
            action: memoryJournalSkillActionSchema,
            note: z.string().min(1).max(1_000),
          })
          .strict(),
      )
      .max(8),
    decisions: z.array(z.string().min(1).max(1_000)).max(8),
    openInvestigations: z
      .array(
        z
          .object({
            investigationId: z.string().min(1).max(200).optional(),
            title: z.string().min(1).max(200),
            currentUnderstanding: z.string().min(1).max(1_500),
            evidenceTurnIds: z.array(z.string().min(1).max(200)).max(5),
            nextStep: z.string().min(1).max(800),
          })
          .strict(),
      )
      .max(10),
    nextRunFocus: z.array(z.string().min(1).max(500)).max(5),
  })
  .strict()
export type MemoryAgentJournalOutput = z.infer<typeof memoryAgentJournalOutputSchema>

export const readMemoryJournalToolInputSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("list"),
      limit: z.number().int().positive().max(10).optional(),
      offset: z.number().int().nonnegative().optional(),
      charLimit: z.number().int().min(1_000).max(20_000).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("read"),
      runId: z.string().min(1),
      charLimit: z.number().int().min(1_000).max(20_000).optional(),
    })
    .strict(),
])
export type ReadMemoryJournalToolInput = z.infer<typeof readMemoryJournalToolInputSchema>

export const memoryJournalRunPreviewSchema = z
  .object({
    runId: z.string().min(1),
    summary: z.string().min(1).max(400),
    patternCount: z.number().int().nonnegative(),
    skillActionCount: z.number().int().nonnegative(),
    openInvestigationCount: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
  })
  .strict()

export const readMemoryJournalToolOutputSchema = z
  .object({
    operation: z.enum(["list", "read"]),
    runs: z.array(memoryJournalRunPreviewSchema).max(10),
    content: z.string().max(20_000).optional(),
    totalMatches: z.number().int().nonnegative(),
    truncation: truncationMetadataSchema,
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type ReadMemoryJournalToolOutput = z.infer<typeof readMemoryJournalToolOutputSchema>
