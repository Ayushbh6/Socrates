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
import { conversationContextUsageSchema, conversationTokenUsageSchema, listModelsResponseSchema } from "./models"
import { providerIdSchema } from "./models"
import { terminalStatusSchema, toolNameSchema } from "./tools"

export const getMeResponseSchema = z
  .object({
    user: userSchema.nullable(),
  })
  .strict()

export const listModelsHttpResponseSchema = listModelsResponseSchema

export const providerCredentialSourceSchema = z.enum(["keychain", "local_file", "session", "env", "missing"])
export type ProviderCredentialSource = z.infer<typeof providerCredentialSourceSchema>

export const providerCredentialStatusSchema = z
  .object({
    providerId: providerIdSchema,
    providerLabel: z.string().min(1),
    required: z.boolean(),
    configured: z.boolean(),
    source: providerCredentialSourceSchema,
    message: z.string().min(1).optional(),
  })
  .strict()
export type ProviderCredentialStatus = z.infer<typeof providerCredentialStatusSchema>

export const getProviderCredentialsStatusResponseSchema = z
  .object({
    providers: z.array(providerCredentialStatusSchema),
    openRouterRequired: z.boolean(),
    openAiRequiredForHostedEmbeddings: z.boolean(),
    googleOptional: z.boolean(),
  })
  .strict()
export type GetProviderCredentialsStatusResponse = z.infer<typeof getProviderCredentialsStatusResponseSchema>

export const setProviderCredentialSessionRequestSchema = z
  .object({
    providerId: providerIdSchema,
    apiKey: z.string().min(1),
    source: z.enum(["keychain", "local_file", "manual", "env_import"]).optional(),
  })
  .strict()
export type SetProviderCredentialSessionRequest = z.infer<typeof setProviderCredentialSessionRequestSchema>

export const setProviderCredentialSessionResponseSchema = z
  .object({
    status: providerCredentialStatusSchema,
  })
  .strict()
export type SetProviderCredentialSessionResponse = z.infer<typeof setProviderCredentialSessionResponseSchema>

export const checkProviderCredentialRequestSchema = z
  .object({
    providerId: providerIdSchema,
    apiKey: z.string().min(1).optional(),
  })
  .strict()
export type CheckProviderCredentialRequest = z.infer<typeof checkProviderCredentialRequestSchema>

export const checkProviderCredentialResponseSchema = z
  .object({
    providerId: providerIdSchema,
    ok: z.boolean(),
    configured: z.boolean(),
    source: providerCredentialSourceSchema,
    message: z.string().min(1),
  })
  .strict()
export type CheckProviderCredentialResponse = z.infer<typeof checkProviderCredentialResponseSchema>

export const deleteProviderCredentialResponseSchema = z
  .object({
    status: providerCredentialStatusSchema,
  })
  .strict()
export type DeleteProviderCredentialResponse = z.infer<typeof deleteProviderCredentialResponseSchema>

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
    scaffoldAction: z.enum(["use_existing", "reset"]).optional(),
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
    embeddingStatus: z.lazy(() => projectEmbeddingStatusSchema).optional(),
  })
  .strict()

export const projectEmbeddingProviderSchema = z.enum(["openai", "ollama"])
export type ProjectEmbeddingProvider = z.infer<typeof projectEmbeddingProviderSchema>

export const projectEmbeddingCredentialSourceSchema = z.enum(["server_env", "workspace_env", "none"])
export type ProjectEmbeddingCredentialSource = z.infer<typeof projectEmbeddingCredentialSourceSchema>

export const projectEmbeddingConfigStatusSchema = z.enum(["ready", "failed", "disabled"])
export type ProjectEmbeddingConfigStatus = z.infer<typeof projectEmbeddingConfigStatusSchema>

export const projectEmbeddingJobStatusSchema = z.enum(["queued", "running", "completed", "failed"])
export type ProjectEmbeddingJobStatus = z.infer<typeof projectEmbeddingJobStatusSchema>

export const projectEmbeddingEnvCandidateSchema = z
  .object({
    fileName: z.string().min(1),
    hasOpenAiApiKey: z.boolean(),
  })
  .strict()
export type ProjectEmbeddingEnvCandidate = z.infer<typeof projectEmbeddingEnvCandidateSchema>

export const projectEmbeddingActiveJobSchema = z
  .object({
    id: idSchema,
    status: projectEmbeddingJobStatusSchema,
    createdAt: z.string().min(1),
    startedAt: z.string().min(1).optional(),
    completedAt: z.string().min(1).optional(),
  })
  .strict()
export type ProjectEmbeddingActiveJob = z.infer<typeof projectEmbeddingActiveJobSchema>

export const projectEmbeddingStatusSchema = z
  .object({
    configured: z.boolean(),
    ready: z.boolean(),
    providerId: projectEmbeddingProviderSchema.optional(),
    modelId: z.string().min(1).optional(),
    configId: idSchema.optional(),
    dimensions: z.number().int().positive().optional(),
    credentialSource: projectEmbeddingCredentialSourceSchema.optional(),
    workspaceEnvFile: z.string().min(1).optional(),
    ollamaBaseUrl: z.string().min(1).optional(),
    status: projectEmbeddingConfigStatusSchema.optional(),
    totalDocuments: z.number().int().nonnegative(),
    indexedDocuments: z.number().int().nonnegative(),
    pendingDocuments: z.number().int().nonnegative(),
    failedDocuments: z.number().int().nonnegative(),
    activeJob: projectEmbeddingActiveJobSchema.optional(),
    lastError: z.string().optional(),
    updatedAt: z.string().min(1).optional(),
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type ProjectEmbeddingStatus = z.infer<typeof projectEmbeddingStatusSchema>

export const checkProjectEmbeddingsRequestSchema = z
  .object({
    providerId: projectEmbeddingProviderSchema,
    modelId: z.string().min(1).optional(),
    credentialSource: projectEmbeddingCredentialSourceSchema.optional(),
    workspaceEnvFile: z.string().min(1).optional(),
    ollamaBaseUrl: z.string().min(1).optional(),
  })
  .strict()
export type CheckProjectEmbeddingsRequest = z.infer<typeof checkProjectEmbeddingsRequestSchema>

export const checkProjectEmbeddingsResponseSchema = z
  .object({
    providerId: projectEmbeddingProviderSchema,
    modelId: z.string().min(1),
    ok: z.boolean(),
    dimensions: z.number().int().positive().optional(),
    serverEnvAvailable: z.boolean().optional(),
    workspaceEnvCandidates: z.array(projectEmbeddingEnvCandidateSchema).optional(),
    selectedWorkspaceEnvFile: z.string().min(1).optional(),
    message: z.string().min(1),
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type CheckProjectEmbeddingsResponse = z.infer<typeof checkProjectEmbeddingsResponseSchema>

export const configureProjectEmbeddingsRequestSchema = z
  .object({
    providerId: projectEmbeddingProviderSchema,
    modelId: z.string().min(1).optional(),
    credentialSource: projectEmbeddingCredentialSourceSchema,
    workspaceEnvFile: z.string().min(1).optional(),
    ollamaBaseUrl: z.string().min(1).optional(),
  })
  .strict()
export type ConfigureProjectEmbeddingsRequest = z.infer<typeof configureProjectEmbeddingsRequestSchema>

export const configureProjectEmbeddingsResponseSchema = z
  .object({
    status: projectEmbeddingStatusSchema,
  })
  .strict()
export type ConfigureProjectEmbeddingsResponse = z.infer<typeof configureProjectEmbeddingsResponseSchema>

export const getProjectEmbeddingsStatusResponseSchema = z
  .object({
    status: projectEmbeddingStatusSchema,
  })
  .strict()
export type GetProjectEmbeddingsStatusResponse = z.infer<typeof getProjectEmbeddingsStatusResponseSchema>

export const reindexProjectEmbeddingsResponseSchema = z
  .object({
    status: projectEmbeddingStatusSchema,
  })
  .strict()
export type ReindexProjectEmbeddingsResponse = z.infer<typeof reindexProjectEmbeddingsResponseSchema>

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

export const deleteProjectResourceResponseSchema = z
  .object({
    deletedResourceId: idSchema,
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

export const inspectWorkspaceRequestSchema = z
  .object({
    workspacePath: z.string().min(1),
  })
  .strict()

export const inspectWorkspaceResponseSchema = z
  .object({
    workspacePath: z.string().min(1),
    folderName: z.string().min(1),
    exists: z.boolean(),
    isDirectory: z.boolean(),
    hasSocratesDir: z.boolean(),
    hasResourcesDir: z.boolean(),
  })
  .strict()

export const updateProjectWorkspaceRequestSchema = z
  .object({
    workspacePath: z.string().min(1),
    creationMode: z.literal("existing_folder"),
    scaffoldAction: z.enum(["use_existing", "reset"]).optional(),
  })
  .strict()

export const updateProjectWorkspaceResponseSchema = z
  .object({
    primaryWorkspace: projectWorkspaceSchema,
    resources: z.array(projectResourceSchema),
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

export const conversationToolApprovalSchema = z
  .object({
    approvalId: idSchema,
    status: z.enum(["pending", "approved", "rejected"]),
    actionKind: z.enum(["shell_command", "file_write", "patch_apply", "git_commit", "git_push", "other"]),
    title: z.string().min(1),
    description: z.string().optional(),
    actionPreview: z.string(),
    risk: z.enum(["low", "medium", "high"]).optional(),
    decision: z.enum(["approved", "rejected"]).optional(),
  })
  .strict()

export const conversationToolRunSchema = z
  .object({
    toolCallId: idSchema,
    conversationId: idSchema,
    sessionId: idSchema,
    turnId: idSchema,
    toolName: toolNameSchema,
    status: z.enum(["running", "awaiting_approval", "completed", "failed", "rejected", "cancelled"]),
    requiresApproval: z.boolean(),
    arguments: z.unknown().optional(),
    result: z.unknown().optional(),
    errorId: idSchema.optional(),
    approval: conversationToolApprovalSchema.optional(),
    summary: z.string().optional(),
    resultPreview: z.string().optional(),
    startedAt: z.string().optional(),
    completedAt: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    shell: z
      .object({
        command: z.string(),
        cwd: z.string(),
        status: z.string(),
        operation: z.enum(["run", "start", "status", "output", "stop"]).optional(),
        platform: z.string().optional(),
        shellKind: z.enum(["posix", "powershell", "cmd"]).optional(),
        shellExecutable: z.string().optional(),
        processId: z.string().optional(),
        terminalId: z.string().optional(),
        terminalName: z.string().optional(),
        terminalStatus: terminalStatusSchema.optional(),
        autoDetached: z.boolean().optional(),
        awaitingInput: z.boolean().optional(),
        lastPrompt: z.string().optional(),
        processStatus: z.enum(["running", "exited", "stopped", "missing"]).optional(),
        nextOutputSequence: z.number().int().nonnegative().optional(),
        exitCode: z.number().int().nullable().optional(),
        signal: z.string().nullable().optional(),
        durationMs: z.number().int().nonnegative().optional(),
        stdout: z.string(),
        stderr: z.string(),
        log: z.string().optional(),
      })
      .strict()
      .optional(),
    fileOperations: z
      .array(
        z
          .object({
            path: z.string().min(1),
            operation: z.string().min(1),
            status: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    patch: z
      .object({
        status: z.string().min(1),
        diff: z.string(),
        files: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

export const conversationTerminalOutputSchema = z
  .object({
    stdout: z.string(),
    stderr: z.string(),
    nextOutputSequence: z.number().int().nonnegative(),
  })
  .strict()

export const conversationTerminalSchema = z
  .object({
    terminalId: idSchema,
    projectId: idSchema,
    conversationId: idSchema,
    name: z.string().min(1),
    command: z.string().min(1),
    cwd: z.string().min(1),
    workspacePath: z.string().min(1),
    status: terminalStatusSchema,
    platform: z.string().min(1).optional(),
    shellKind: z.enum(["posix", "powershell", "cmd"]).optional(),
    shellExecutable: z.string().min(1).optional(),
    processId: z.string().min(1).optional(),
    exitCode: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    autoDetached: z.boolean(),
    awaitingInput: z.boolean(),
    lastPrompt: z.string().optional(),
    startedAt: z.string().min(1),
    updatedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),
    output: conversationTerminalOutputSchema,
  })
  .strict()

export const conversationPartialTurnSchema = z
  .object({
    turnId: idSchema,
    status: z.enum(["running", "failed", "cancelled"]),
    answer: z.string().optional(),
    reasoning: z.string().optional(),
  })
  .strict()

export const getConversationResponseSchema = z
  .object({
    conversation: conversationSchema,
    messages: z.array(messageSchema),
    toolRuns: z.array(conversationToolRunSchema),
    terminals: z.array(conversationTerminalSchema).optional(),
    partialTurns: z.array(conversationPartialTurnSchema).optional(),
    tokenUsage: conversationTokenUsageSchema,
    contextUsage: conversationContextUsageSchema.optional(),
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
export type DeleteProjectResourceResponse = z.infer<typeof deleteProjectResourceResponseSchema>
export type UpsertProjectInstructionsRequest = z.infer<typeof upsertProjectInstructionsRequestSchema>
export type UpsertProjectInstructionsResponse = z.infer<typeof upsertProjectInstructionsResponseSchema>
export type PickWorkspaceFolderRequest = z.infer<typeof pickWorkspaceFolderRequestSchema>
export type PickWorkspaceFolderResponse = z.infer<typeof pickWorkspaceFolderResponseSchema>
export type InspectWorkspaceRequest = z.infer<typeof inspectWorkspaceRequestSchema>
export type InspectWorkspaceResponse = z.infer<typeof inspectWorkspaceResponseSchema>
export type UpdateProjectWorkspaceRequest = z.infer<typeof updateProjectWorkspaceRequestSchema>
export type UpdateProjectWorkspaceResponse = z.infer<typeof updateProjectWorkspaceResponseSchema>
export type ListProjectConversationsResponse = z.infer<typeof listProjectConversationsResponseSchema>
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>
export type CreateConversationResponse = z.infer<typeof createConversationResponseSchema>
export type ConversationToolApproval = z.infer<typeof conversationToolApprovalSchema>
export type ConversationToolRun = z.infer<typeof conversationToolRunSchema>
export type ConversationTerminal = z.infer<typeof conversationTerminalSchema>
export type ConversationPartialTurn = z.infer<typeof conversationPartialTurnSchema>
export type GetConversationResponse = z.infer<typeof getConversationResponseSchema>
export type UpdateConversationRequest = z.infer<typeof updateConversationRequestSchema>
export type UpdateConversationResponse = z.infer<typeof updateConversationResponseSchema>
export type DeleteConversationResponse = z.infer<typeof deleteConversationResponseSchema>
export type CreateConversationMessageRequest = z.infer<typeof createConversationMessageRequestSchema>
export type CreateConversationMessageResponse = z.infer<typeof createConversationMessageResponseSchema>
