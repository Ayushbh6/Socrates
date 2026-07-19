import { z } from "zod"
import { v2GoalRouterOutputSchema } from "./v2Flow"

export const memoryRetrievalSurfaceSchema = z.enum(["project_notes", "project_memory", "repo_docs", "user_profile", "identity"])
export type MemoryRetrievalSurface = z.infer<typeof memoryRetrievalSurfaceSchema>

export const memoryRetrievalFileSchema = z.enum([
  "PROJECT_NOTES.md",
  "MEMORY.md",
  "CORE_IDEA.md",
  "REPO_NAVIGATION.md",
  "REPO_RULES.md",
  "CONTRACTS.md",
  "user_profile.md",
  "identity.md",
])
export type MemoryRetrievalFile = z.infer<typeof memoryRetrievalFileSchema>

export const memoryRetrievalSectionSchema = z.enum([
  "runtime_context",
  "state_ledger",
  "active_context",
  "active_todos",
  "checked_files",
  "next_commands",
  "scratch_notes",
  "completed_archive",
  "current_state",
  "always_apply_rules",
  "durable_decisions",
  "constraints",
  "project_preferences",
  "blockers",
  "handoff",
  "evidence_anchors",
  "purpose",
  "current_direction",
  "milestones",
  "update_triggers",
  "ownership_map",
  "entry_points",
  "tests",
  "generated_ignored",
  "navigation_rules",
  "hard_rules",
  "workflows",
  "verification",
  "known_pitfalls",
  "tool_contracts",
  "api_contracts",
  "db_event_contracts",
  "frontend_backend",
  "change_log",
  "profile_summary",
  "global_always_apply_rules",
  "stable_preferences",
  "collaboration_style",
  "work_and_projects",
  "personal_interests",
  "boundaries_and_dislikes",
  "evidence_index",
  "core_identity",
  "voice_and_presence",
  "relationship_to_user",
  "operating_principles",
  "safety_boundaries",
  "tool_and_memory_discipline",
])
export type MemoryRetrievalSection = z.infer<typeof memoryRetrievalSectionSchema>

const validSectionsByFile: Record<MemoryRetrievalFile, ReadonlySet<MemoryRetrievalSection>> = {
  "PROJECT_NOTES.md": new Set(["runtime_context", "state_ledger", "active_context", "active_todos", "checked_files", "next_commands", "scratch_notes", "completed_archive"]),
  "MEMORY.md": new Set(["current_state", "always_apply_rules", "durable_decisions", "constraints", "project_preferences", "blockers", "handoff", "evidence_anchors"]),
  "CORE_IDEA.md": new Set(["purpose", "current_direction", "milestones", "update_triggers"]),
  "REPO_NAVIGATION.md": new Set(["ownership_map", "entry_points", "tests", "generated_ignored", "navigation_rules"]),
  "REPO_RULES.md": new Set(["hard_rules", "workflows", "verification", "known_pitfalls", "update_triggers"]),
  "CONTRACTS.md": new Set(["tool_contracts", "api_contracts", "db_event_contracts", "frontend_backend", "change_log"]),
  "user_profile.md": new Set(["profile_summary", "global_always_apply_rules", "stable_preferences", "collaboration_style", "work_and_projects", "personal_interests", "boundaries_and_dislikes", "active_context", "evidence_index"]),
  "identity.md": new Set(["core_identity", "voice_and_presence", "relationship_to_user", "operating_principles", "safety_boundaries", "tool_and_memory_discipline"]),
}

const validFilesBySurface: Record<MemoryRetrievalSurface, ReadonlySet<MemoryRetrievalFile>> = {
  project_notes: new Set(["PROJECT_NOTES.md"]),
  project_memory: new Set(["MEMORY.md"]),
  repo_docs: new Set(["CORE_IDEA.md", "REPO_NAVIGATION.md", "REPO_RULES.md", "CONTRACTS.md"]),
  user_profile: new Set(["user_profile.md"]),
  identity: new Set(["identity.md"]),
}

const memoryDestinationShape = {
  surface: memoryRetrievalSurfaceSchema,
  fileName: memoryRetrievalFileSchema,
  sectionId: memoryRetrievalSectionSchema,
}

const validateMemoryDestination = (
  input: { surface: MemoryRetrievalSurface; fileName: MemoryRetrievalFile; sectionId: MemoryRetrievalSection },
  context: z.RefinementCtx,
) => {
  if (!validFilesBySurface[input.surface].has(input.fileName)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fileName"], message: `${input.fileName} is not owned by ${input.surface}.` })
  }
  if (!validSectionsByFile[input.fileName].has(input.sectionId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sectionId"], message: `${input.sectionId} is not a valid section of ${input.fileName}.` })
  }
}

export const memoryReadTargetSchema = z
  .object({ ...memoryDestinationShape, reason: z.string().min(1).max(500) })
  .strict()
  .superRefine(validateMemoryDestination)
export type MemoryReadTarget = z.infer<typeof memoryReadTargetSchema>

/** @deprecated The router no longer returns writes. Kept only for persisted-history compatibility. */
export const routedMemoryWriteSchema = z.union([
  z
    .object({ kind: z.literal("document"), ...memoryDestinationShape, text: z.string().min(1).max(1_200), reason: z.string().min(1).max(500) })
    .strict()
    .superRefine(validateMemoryDestination),
  z.object({ kind: z.literal("skill_candidate"), text: z.string().min(1).max(1_200), reason: z.string().min(1).max(500) }).strict(),
])
export type RoutedMemoryWrite = z.infer<typeof routedMemoryWriteSchema>

export const memoryRouterPreTurnResultSchema = z
  .object({
    readTargets: z.array(memoryReadTargetSchema).max(8),
    reason: z.string().min(1).max(500),
    goalRoute: v2GoalRouterOutputSchema.nullable(),
  })
  .strict()
export type MemoryRouterPreTurnResult = z.infer<typeof memoryRouterPreTurnResultSchema>

export const memoryReconciliationActionSchema = z
  .object({
    operation: z.enum(["upsert", "replace", "remove", "archive", "condense"]),
    ...memoryDestinationShape,
    surface: z.enum(["project_notes", "project_memory", "repo_docs"]),
    instruction: z.string().min(1).max(1_200),
    reason: z.string().min(1).max(500),
    evidenceReferences: z.array(z.string().regex(/^evd_[A-Za-z0-9_-]+$/)).max(5).default([]),
    capabilityId: z.string().min(3).max(120).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/).optional(),
    verifiedRuntime: z.string().min(1).max(200).optional(),
    verifiedAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    validateMemoryDestination(input, context)
    if (input.surface === "project_notes" && ["runtime_context", "state_ledger"].includes(input.sectionId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["sectionId"], message: `${input.sectionId} is backend-owned and cannot be a reconciliation action.` })
    }
  })
export type MemoryReconciliationAction = z.infer<typeof memoryReconciliationActionSchema>

export const goalFinalizationSchema = z
  .object({
    state: z.enum(["active", "completed", "blocked", "discarded"]),
    note: z.string().min(1).max(600),
  })
  .strict()
export type GoalFinalization = z.infer<typeof goalFinalizationSchema>

export const memoryRouterPostTurnResultSchema = z
  .object({
    actions: z.array(memoryReconciliationActionSchema).max(5),
    reason: z.string().min(1).max(500),
    goalFinalization: goalFinalizationSchema.nullable(),
  })
  .strict()
export type MemoryRouterPostTurnResult = z.infer<typeof memoryRouterPostTurnResultSchema>

export const memorySearchInputSchema = z
  .object({
    query: z.string().min(1).max(1_000),
    mode: z.enum(["lexical", "semantic", "combined"]).default("combined"),
    scope: z.enum(["global", "project", "all"]).default("all"),
    limit: z.number().int().positive().max(8).default(8),
  })
  .strict()
export type MemorySearchInput = z.infer<typeof memorySearchInputSchema>

export const memorySearchResultSchema = z
  .object({
    resultNumber: z.number().int().positive(),
    content: z.string(),
    surface: memoryRetrievalSurfaceSchema,
    fileName: memoryRetrievalFileSchema,
    sectionId: memoryRetrievalSectionSchema,
    sectionHeading: z.string().min(1),
    scope: z.enum(["global", "project"]),
  })
  .strict()
export type MemorySearchResult = z.infer<typeof memorySearchResultSchema>

export const memorySearchOutputSchema = z
  .object({
    results: z.array(memorySearchResultSchema).max(8),
    totalMatches: z.number().int().nonnegative(),
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type MemorySearchOutput = z.infer<typeof memorySearchOutputSchema>
