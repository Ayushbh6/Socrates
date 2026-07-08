import { z } from "zod"

export const memoryRouteSaveTargetSchema = z.enum([
  "project_notes",
  "project_memory",
  "repo_docs",
  "global_memory",
  "identity",
  "skill_candidate",
])
export type MemoryRouteSaveTarget = z.infer<typeof memoryRouteSaveTargetSchema>

export const memoryRouteDocHintSchema = z.enum([
  "project_notes/active_context",
  "project_memory/always_apply_rules",
  "project_memory/current_state",
  "project_memory/durable_decisions",
  "project_memory/constraints",
  "project_memory/project_preferences",
  "project_memory/blockers",
  "project_memory/handoff",
  "repo_docs/CORE_IDEA.md",
  "repo_docs/REPO_NAVIGATION.md",
  "repo_docs/REPO_RULES.md",
  "repo_docs/CONTRACTS.md",
  "user_profile/global_always_apply_rules",
  "user_profile/stable_preferences",
  "user_profile/collaboration_style",
  "user_profile/active_context",
  "identity/operating_principles",
  "identity/tool_and_memory_discipline",
  "skills/candidate",
])
export type MemoryRouteDocHint = z.infer<typeof memoryRouteDocHintSchema>

const memoryRouteTextSchema = z.string().min(1).max(1_200)
const memoryRouteReasonSchema = z.string().min(1).max(500)

export const memoryWriteCandidateSchema = z
  .object({
    target: memoryRouteSaveTargetSchema,
    text: memoryRouteTextSchema,
    reason: memoryRouteReasonSchema,
    docHint: memoryRouteDocHintSchema.nullable(),
  })
  .strict()
export type MemoryWriteCandidate = z.infer<typeof memoryWriteCandidateSchema>

export const preTurnMemoryRouteSchema = z
  .object({
    projectNotes: z.boolean(),
    projectMemory: z.boolean(),
    repoDocs: z.boolean(),
    userProfile: z.boolean(),
    identity: z.boolean(),
    docHints: z.array(memoryRouteDocHintSchema).max(8),
    memoryWrites: z.array(memoryWriteCandidateSchema).max(3),
    reason: memoryRouteReasonSchema,
  })
  .strict()
export type PreTurnMemoryRoute = z.infer<typeof preTurnMemoryRouteSchema>

export const postTurnMemoryRouteSchema = z
  .object({
    memoryWrites: z.array(memoryWriteCandidateSchema).max(3),
    reason: memoryRouteReasonSchema,
  })
  .strict()
export type PostTurnMemoryRoute = z.infer<typeof postTurnMemoryRouteSchema>
