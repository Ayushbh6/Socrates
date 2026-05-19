import { z } from "zod"
import {
  conversationSchema,
  idSchema,
  messageSchema,
  projectInstructionsSchema,
  projectResourceKindSchema,
  projectResourceSchema,
  projectResourceSourceSchema,
  projectSchema,
  projectStatusSchema,
  projectWorkspaceSchema,
  userSchema,
} from "./entities"
import { conversationTokenUsageSchema, listModelsResponseSchema } from "./models"

export const getMeResponseSchema = z
  .object({
    user: userSchema.nullable(),
  })
  .strict()

export const listModelsHttpResponseSchema = listModelsResponseSchema

export const completeOnboardingRequestSchema = z
  .object({
    displayName: z.string().min(1),
  })
  .strict()

export const completeOnboardingResponseSchema = z
  .object({
    user: userSchema,
  })
  .strict()

export const listProjectsResponseSchema = z
  .object({
    projects: z.array(
      z
        .object({
          project: projectSchema,
          primaryWorkspace: projectWorkspaceSchema,
          conversationCount: z.number().int().nonnegative(),
          lastActivityAt: z.string().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict()

export const createProjectRequestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    creationMode: z.enum(["start_from_scratch", "existing_folder"]),
    workspacePath: z.string().min(1),
  })
  .strict()

export const createProjectResponseSchema = z
  .object({
    project: projectSchema,
    primaryWorkspace: projectWorkspaceSchema,
  })
  .strict()

export const patchProjectRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    status: projectStatusSchema.optional(),
  })
  .strict()

export const patchProjectResponseSchema = z
  .object({
    project: projectSchema,
  })
  .strict()

export const projectInstructionsSummarySchema = z
  .object({
    id: idSchema,
    projectId: idSchema,
    content: z.string(),
    updatedAt: z.string().min(1),
  })
  .strict()

export const getProjectResponseSchema = z
  .object({
    project: projectSchema,
    primaryWorkspace: projectWorkspaceSchema,
    resources: z.array(projectResourceSchema),
    conversations: z.array(conversationSchema),
    instructions: projectInstructionsSummarySchema.optional(),
  })
  .strict()

export const listProjectResourcesResponseSchema = z
  .object({
    resources: z.array(projectResourceSchema),
  })
  .strict()

export const createProjectResourceRequestSchema = z
  .object({
    name: z.string().min(1),
    kind: projectResourceKindSchema,
    source: projectResourceSourceSchema,
    uri: z.string().min(1).optional(),
  })
  .strict()

export const createProjectResourceResponseSchema = z
  .object({
    resource: projectResourceSchema,
  })
  .strict()

export const uploadProjectResourcesResponseSchema = z
  .object({
    resources: z.array(projectResourceSchema),
  })
  .strict()

export const upsertProjectInstructionsRequestSchema = z
  .object({
    content: z.string().min(1),
  })
  .strict()

export const upsertProjectInstructionsResponseSchema = z
  .object({
    instructions: projectInstructionsSchema,
  })
  .strict()

export const pickWorkspaceFolderRequestSchema = z
  .object({
    mode: z.enum(["start_from_scratch", "existing_folder"]),
  })
  .strict()

export const pickWorkspaceFolderResponseSchema = z
  .object({
    path: z.string().min(1),
    folderName: z.string().min(1),
  })
  .strict()

export const listProjectConversationsResponseSchema = z
  .object({
    conversations: z.array(conversationSchema),
  })
  .strict()

export const createConversationRequestSchema = z
  .object({
    title: z.string().min(1).optional(),
  })
  .strict()

export const createConversationResponseSchema = z
  .object({
    conversation: conversationSchema,
  })
  .strict()

export const getConversationResponseSchema = z
  .object({
    conversation: conversationSchema,
    messages: z.array(messageSchema),
    tokenUsage: conversationTokenUsageSchema,
  })
  .strict()

export const updateConversationRequestSchema = z
  .object({
    title: z.string().min(1),
  })
  .strict()

export const updateConversationResponseSchema = z
  .object({
    conversation: conversationSchema,
  })
  .strict()

export const deleteConversationResponseSchema = z
  .object({
    deletedConversationId: idSchema,
  })
  .strict()

export const createConversationMessageRequestSchema = z
  .object({
    content: z.string().min(1),
  })
  .strict()

export const createConversationMessageResponseSchema = z
  .object({
    conversation: conversationSchema,
    message: messageSchema,
  })
  .strict()

export type GetMeResponse = z.infer<typeof getMeResponseSchema>
export type ListModelsHttpResponse = z.infer<typeof listModelsHttpResponseSchema>
export type CompleteOnboardingRequest = z.infer<typeof completeOnboardingRequestSchema>
export type CompleteOnboardingResponse = z.infer<typeof completeOnboardingResponseSchema>
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>
export type CreateProjectResponse = z.infer<typeof createProjectResponseSchema>
export type PatchProjectRequest = z.infer<typeof patchProjectRequestSchema>
export type PatchProjectResponse = z.infer<typeof patchProjectResponseSchema>
export type GetProjectResponse = z.infer<typeof getProjectResponseSchema>
export type ListProjectResourcesResponse = z.infer<typeof listProjectResourcesResponseSchema>
export type CreateProjectResourceRequest = z.infer<typeof createProjectResourceRequestSchema>
export type CreateProjectResourceResponse = z.infer<typeof createProjectResourceResponseSchema>
export type UploadProjectResourcesResponse = z.infer<typeof uploadProjectResourcesResponseSchema>
export type UpsertProjectInstructionsRequest = z.infer<typeof upsertProjectInstructionsRequestSchema>
export type UpsertProjectInstructionsResponse = z.infer<typeof upsertProjectInstructionsResponseSchema>
export type PickWorkspaceFolderRequest = z.infer<typeof pickWorkspaceFolderRequestSchema>
export type PickWorkspaceFolderResponse = z.infer<typeof pickWorkspaceFolderResponseSchema>
export type ListProjectConversationsResponse = z.infer<typeof listProjectConversationsResponseSchema>
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>
export type CreateConversationResponse = z.infer<typeof createConversationResponseSchema>
export type GetConversationResponse = z.infer<typeof getConversationResponseSchema>
export type UpdateConversationRequest = z.infer<typeof updateConversationRequestSchema>
export type UpdateConversationResponse = z.infer<typeof updateConversationResponseSchema>
export type DeleteConversationResponse = z.infer<typeof deleteConversationResponseSchema>
export type CreateConversationMessageRequest = z.infer<typeof createConversationMessageRequestSchema>
export type CreateConversationMessageResponse = z.infer<typeof createConversationMessageResponseSchema>
