import { z } from "zod"

export const memoryDocTypeSchema = z.enum([
  "project_memory",
  "project_notes",
  "repo_core_idea",
  "repo_navigation",
  "repo_rules",
  "repo_contracts",
  "identity",
  "operating_principles",
  "user_profile",
  "tool_doc",
  "skill",
])
export type MemoryDocType = z.infer<typeof memoryDocTypeSchema>

export const memoryDocScopeSchema = z.enum(["workspace", "global"])
export type MemoryDocScope = z.infer<typeof memoryDocScopeSchema>

export const memoryDocOwnerToolSchema = z.enum(["project_docs", "repo_docs", "tool_docs", "soul", "user_profile", "edit_files", "skills"])
export type MemoryDocOwnerTool = z.infer<typeof memoryDocOwnerToolSchema>

export const memoryDocFrontmatterSchema = z
  .object({
    socrates_doc: memoryDocTypeSchema,
    schema_version: z.number().int().positive(),
    owner_tool: memoryDocOwnerToolSchema,
    scope: memoryDocScopeSchema,
    index_tags: z.array(z.string().min(1)).optional(),
    updated_at: z.string().min(1).optional(),
    updated_by: z.string().min(1).optional(),
    last_edited_section: z.string().min(1).optional(),
  })
  .strict()
export type MemoryDocFrontmatter = z.infer<typeof memoryDocFrontmatterSchema>

export const memoryDocSectionSchema = z
  .object({
    sectionId: z.string().min(1),
    kind: z.string().min(1),
    tags: z.array(z.string().min(1)),
    heading: z.string().min(1),
    content: z.string(),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    contentHash: z.string().min(1),
    summary: z.string(),
    tokenEstimate: z.number().int().nonnegative(),
  })
  .strict()
export type MemoryDocSection = z.infer<typeof memoryDocSectionSchema>

export const memoryDocIndexSchema = z
  .object({
    path: z.string().min(1),
    scope: memoryDocScopeSchema,
    projectId: z.string().min(1).optional(),
    docType: memoryDocTypeSchema,
    ownerTool: memoryDocOwnerToolSchema,
    schemaVersion: z.number().int().positive(),
    contentHash: z.string().min(1),
    sections: z.array(memoryDocSectionSchema),
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type MemoryDocIndex = z.infer<typeof memoryDocIndexSchema>

export const memoryDocRequiredSections: Record<MemoryDocType, string[]> = {
  project_memory: ["current_state", "durable_decisions", "constraints", "project_preferences", "blockers", "handoff", "evidence_anchors"],
  project_notes: ["state_ledger", "active_todos", "checked_files", "next_commands", "scratch_notes", "completed_archive"],
  repo_core_idea: ["purpose", "current_direction", "milestones", "update_triggers"],
  repo_navigation: ["ownership_map", "entry_points", "tests", "generated_ignored", "navigation_rules"],
  repo_rules: ["hard_rules", "workflows", "verification", "known_pitfalls", "update_triggers"],
  repo_contracts: ["tool_contracts", "api_contracts", "db_event_contracts", "frontend_backend", "change_log"],
  identity: ["identity", "scope", "non_negotiables", "voice", "change_policy"],
  operating_principles: ["decision_principles", "tool_discipline", "memory_discipline", "safety", "failure_handling"],
  user_profile: ["stable_facts", "stable_preferences", "collaboration_style", "boundaries", "evidence_requirements", "stale_or_rejected_facts"],
  tool_doc: ["purpose", "when_to_use", "inputs", "correct_flow", "failure_handling", "examples", "update_policy"],
  skill: ["purpose", "workflow", "examples", "update_policy"],
}
