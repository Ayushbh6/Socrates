import { z } from "zod"

export const idSchema = z.string().min(1)
export const timestampSchema = z.string().min(1)

export const userSchema = z
  .object({
    id: idSchema,
    displayName: z.string().min(1),
    onboardingCompleted: z.boolean(),
  })
  .strict()

export const projectStatusSchema = z.enum(["active", "archived", "deleted"])

export const projectSchema = z
  .object({
    id: idSchema,
    userId: idSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    status: projectStatusSchema,
    updatedAt: timestampSchema,
  })
  .strict()

export const projectWorkspaceKindSchema = z.enum(["existing_folder", "created_folder", "none"])
export const projectWorkspaceStatusSchema = z.enum(["active", "missing", "detached", "archived"])

export const projectWorkspaceSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    kind: projectWorkspaceKindSchema,
    path: z.string().min(1).optional(),
    gitRepoRoot: z.string().min(1).optional(),
    gitBranch: z.string().min(1).optional(),
    isPrimary: z.boolean(),
    status: projectWorkspaceStatusSchema,
  })
  .strict()

export const projectResourceKindSchema = z.enum([
  "pdf",
  "document",
  "text",
  "image",
  "url",
  "local_file",
  "note",
  "other",
])

export const projectResourceSourceSchema = z.enum([
  "uploaded",
  "linked_file",
  "created_note",
  "url",
  "generated",
])

export const projectResourceStatusSchema = z.enum([
  "active",
  "processing",
  "failed",
  "archived",
  "deleted",
])

export const projectResourceSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    name: z.string().min(1),
    kind: projectResourceKindSchema,
    source: projectResourceSourceSchema,
    status: projectResourceStatusSchema,
  })
  .strict()

export const conversationStatusSchema = z.enum(["active", "archived", "deleted"])

export const conversationSchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    title: z.string().min(1).optional(),
    status: conversationStatusSchema,
    updatedAt: timestampSchema,
  })
  .strict()

export const messageRoleSchema = z.enum(["user", "assistant", "system", "tool", "developer"])
export const messageStatusSchema = z.enum(["streaming", "completed", "failed", "cancelled"])

export const messageSchema = z
  .object({
    id: idSchema,
    conversationId: idSchema,
    sessionId: idSchema,
    turnId: idSchema.optional(),
    role: messageRoleSchema,
    content: z.string(),
    status: messageStatusSchema,
    createdAt: timestampSchema,
  })
  .strict()

export type User = z.infer<typeof userSchema>
export type Project = z.infer<typeof projectSchema>
export type ProjectWorkspace = z.infer<typeof projectWorkspaceSchema>
export type ProjectResource = z.infer<typeof projectResourceSchema>
export type Conversation = z.infer<typeof conversationSchema>
export type Message = z.infer<typeof messageSchema>

