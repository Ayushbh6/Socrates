import { z } from "zod"
import {
  conversationSchema,
  messageAttachmentSchema,
  idSchema,
  messageSchema,
  notificationSchema,
  projectInstructionsSchema,
  projectResourceKindSchema,
  projectResourceSchema,
  projectResourceSourceSchema,
  projectSchema,
  projectStatusSchema,
  projectWorkspaceSchema,
  userSchema,
} from "./entities"
import {
  conversationContextUsageSchema,
  conversationCostUsageSchema,
  conversationTokenUsageSchema,
  listModelsResponseSchema,
  modelSettingsResolutionSchema,
  providerAuthModeSchema,
  providerIdSchema,
  thinkingEffortSchema,
  turnUsageReportSchema,
  workerModelRoleSchema,
  workerModelSettingsSchema,
} from "./models"
import { mcpRegistryServerSchema, mcpRegistryToolDescriptorSchema, mcpServerScopeSchema, skillScopeSchema, skillSummarySchema, terminalStatusSchema, toolNameSchema } from "./tools"

const skillNameInputSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "Use lowercase letters, numbers, and hyphens.")
  .refine((name) => !name.includes("--"), "Use single hyphens only.")

export const getMeResponseSchema = z
  .object({
    user: userSchema.nullable(),
  })
  .strict()

export const listModelsHttpResponseSchema = listModelsResponseSchema

export const providerCredentialSourceSchema = z.enum(["keychain", "local_file", "session", "env", "missing"])
export type ProviderCredentialSource = z.infer<typeof providerCredentialSourceSchema>

export const providerAuthCredentialStatusSchema = z
  .object({
    authMode: providerAuthModeSchema,
    label: z.string().min(1),
    configured: z.boolean(),
    source: providerCredentialSourceSchema,
    message: z.string().min(1).optional(),
  })
  .strict()
export type ProviderAuthCredentialStatus = z.infer<typeof providerAuthCredentialStatusSchema>

export const providerCredentialStatusSchema = z
  .object({
    providerId: providerIdSchema,
    providerLabel: z.string().min(1),
    required: z.boolean(),
    configured: z.boolean(),
    source: providerCredentialSourceSchema,
    authModes: z.array(providerAuthCredentialStatusSchema).optional(),
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
    deepSeekOptional: z.boolean().optional(),
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

export const startOpenAiChatGptOAuthResponseSchema = z
  .object({
    authorizationUrl: z.string().url(),
    state: z.string().min(1),
    redirectUri: z.string().url(),
    expiresAt: z.string().min(1),
  })
  .strict()
export type StartOpenAiChatGptOAuthResponse = z.infer<typeof startOpenAiChatGptOAuthResponseSchema>

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

export const memoryAgentGlobalSettingsSchema = z
  .object({
    id: idSchema,
    providerId: providerIdSchema,
    authMode: providerAuthModeSchema.optional(),
    modelId: z.string().min(1),
    thinkingEnabled: z.boolean(),
    thinkingEffort: thinkingEffortSchema.optional(),
    enabled: z.boolean(),
    cadenceMinutes: z.number().int().positive(),
    updatedAt: z.string().min(1),
  })
  .strict()
export type MemoryAgentGlobalSettings = z.infer<typeof memoryAgentGlobalSettingsSchema>

export const updateMemoryAgentGlobalSettingsRequestSchema = z
  .object({
    providerId: providerIdSchema.optional(),
    authMode: providerAuthModeSchema.optional(),
    modelId: z.string().min(1).optional(),
    thinkingEnabled: z.boolean().optional(),
    thinkingEffort: thinkingEffortSchema.optional(),
    enabled: z.boolean().optional(),
    cadenceMinutes: z.number().int().positive().max(24 * 60).optional(),
  })
  .strict()
export type UpdateMemoryAgentGlobalSettingsRequest = z.infer<typeof updateMemoryAgentGlobalSettingsRequestSchema>

export const memoryAgentGlobalStateSchema = z
  .object({
    id: z.literal("global"),
    lastProcessedEventSequence: z.number().int().nonnegative(),
    lastCheckedAt: z.string().min(1).optional(),
    lastRealRunAt: z.string().min(1).optional(),
    status: z.enum(["idle", "running", "skipped", "failed"]),
    activeJobId: idSchema.optional(),
    lastJobId: idSchema.optional(),
    error: z.string().optional(),
    updatedAt: z.string().min(1),
  })
  .strict()
export type MemoryAgentGlobalState = z.infer<typeof memoryAgentGlobalStateSchema>

export const memoryAgentSignalSnapshotSchema = z
  .object({
    sequenceFrom: z.number().int().positive().optional(),
    sequenceTo: z.number().int().nonnegative(),
    turnCount: z.number().int().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    fileChangeEvents: z.number().int().nonnegative(),
    distinctChangedFiles: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    shouldRun: z.boolean(),
    reasons: z.array(z.string()),
    displayReason: z.string().min(1),
  })
  .strict()
export type MemoryAgentSignalSnapshot = z.infer<typeof memoryAgentSignalSnapshotSchema>

export const memoryAgentSummarySectionsSchema = z
  .object({
    investigated: z.string(),
    changed: z.string(),
    skipped: z.string(),
    blocked: z.string(),
  })
  .strict()
export type MemoryAgentSummarySections = z.infer<typeof memoryAgentSummarySectionsSchema>

export const memoryAgentRunActionSchema = z
  .object({
    id: idSchema,
    jobId: idSchema,
    targetKind: z.string().min(1),
    targetPath: z.string().min(1),
    status: z.string().min(1),
    requiresConfirmation: z.boolean(),
    rationale: z.string().optional(),
    error: z.string().optional(),
    createdAt: z.string().min(1),
    appliedAt: z.string().min(1).optional(),
  })
  .strict()
export type MemoryAgentRunAction = z.infer<typeof memoryAgentRunActionSchema>

export const memoryAgentTimelineItemSchema = z
  .object({
    id: idSchema,
    itemType: z.enum(["run", "check"]),
    status: z.enum(["running", "completed", "failed", "skipped"]),
    trigger: z.enum(["scheduled", "manual"]),
    title: z.string().min(1),
    displayReason: z.string().min(1).optional(),
    startedAt: z.string().min(1).optional(),
    checkedAt: z.string().min(1).optional(),
    completedAt: z.string().min(1).optional(),
    sequenceFrom: z.number().int().positive().optional(),
    sequenceTo: z.number().int().nonnegative().optional(),
    evidenceTurnCount: z.number().int().nonnegative(),
    evidenceTokensEstimate: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    providerId: providerIdSchema.optional(),
    modelId: z.string().min(1).optional(),
    runId: idSchema.optional(),
    checkId: idSchema.optional(),
  })
  .strict()
export type MemoryAgentTimelineItem = z.infer<typeof memoryAgentTimelineItemSchema>

export const memoryAgentRunDetailSchema = memoryAgentTimelineItemSchema
  .extend({
    itemType: z.literal("run"),
    providerId: providerIdSchema,
    modelId: z.string().min(1),
    summary: memoryAgentSummarySectionsSchema,
    toolEvents: z.array(z.unknown()),
    actions: z.array(memoryAgentRunActionSchema),
    error: z.string().optional(),
  })
  .strict()
export type MemoryAgentRunDetail = z.infer<typeof memoryAgentRunDetailSchema>

export const memoryAgentFileKindSchema = z.enum(["identity", "user_profile", "tool_doc", "skill", "journal"])
export type MemoryAgentFileKind = z.infer<typeof memoryAgentFileKindSchema>

export const memoryAgentFileSummarySchema = z
  .object({
    id: z.string().min(1),
    kind: memoryAgentFileKindSchema,
    scope: skillScopeSchema.optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    path: z.string().min(1),
    absolutePath: z.string().min(1),
    updatedAt: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    source: z.enum(["builtin", "generated", "imported"]).optional(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    installedAt: z.string().min(1).optional(),
    sourceLabel: z.string().min(1).max(240).optional(),
  })
  .strict()
export type MemoryAgentFileSummary = z.infer<typeof memoryAgentFileSummarySchema>

export const getMemoryAgentResponseSchema = z
  .object({
    settings: memoryAgentGlobalSettingsSchema,
    state: memoryAgentGlobalStateSchema,
    pending: memoryAgentSignalSnapshotSchema,
    recentItems: z.array(memoryAgentTimelineItemSchema),
  })
  .strict()
export type GetMemoryAgentResponse = z.infer<typeof getMemoryAgentResponseSchema>

export const listMemoryAgentRunsResponseSchema = z
  .object({
    items: z.array(memoryAgentTimelineItemSchema),
    totalMatches: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().optional(),
  })
  .strict()
export type ListMemoryAgentRunsResponse = z.infer<typeof listMemoryAgentRunsResponseSchema>

export const getMemoryAgentRunResponseSchema = z
  .object({
    run: memoryAgentRunDetailSchema,
  })
  .strict()
export type GetMemoryAgentRunResponse = z.infer<typeof getMemoryAgentRunResponseSchema>

export const listMemoryAgentFilesResponseSchema = z
  .object({
    files: z.array(memoryAgentFileSummarySchema),
  })
  .strict()
export type ListMemoryAgentFilesResponse = z.infer<typeof listMemoryAgentFilesResponseSchema>

export const memoryAgentFileContentQuerySchema = z
  .object({
    kind: memoryAgentFileKindSchema,
    path: z.string().min(1),
    scope: skillScopeSchema.optional(),
  })
  .strict()
export type MemoryAgentFileContentQuery = z.infer<typeof memoryAgentFileContentQuerySchema>

export const getMemoryAgentFileContentResponseSchema = z
  .object({
    file: memoryAgentFileSummarySchema,
    content: z.string(),
  })
  .strict()
export type GetMemoryAgentFileContentResponse = z.infer<typeof getMemoryAgentFileContentResponseSchema>

export const buildGlobalSkillRequestSchema = z
  .object({
    request: z.string().min(1),
    name: skillNameInputSchema.optional(),
  })
  .strict()
export type BuildGlobalSkillRequest = z.infer<typeof buildGlobalSkillRequestSchema>

export const buildGlobalSkillResponseSchema = z
  .object({
    skill: skillSummarySchema,
  })
  .strict()
export type BuildGlobalSkillResponse = z.infer<typeof buildGlobalSkillResponseSchema>

export const skillImportScopeSchema = z.enum(["global", "project"])
export type SkillImportScope = z.infer<typeof skillImportScopeSchema>

export const skillImportWarningSchema = z
  .object({
    code: z.string().min(1).max(80),
    severity: z.enum(["info", "warning"]),
    message: z.string().min(1).max(500),
    path: z.string().min(1).max(240).optional(),
  })
  .strict()
export type SkillImportWarning = z.infer<typeof skillImportWarningSchema>

export const skillImportPreviewSchema = z
  .object({
    previewId: idSchema,
    scope: skillImportScopeSchema,
    projectId: idSchema.optional(),
    skill: skillSummarySchema,
    package: z
      .object({
        filename: z.string().min(1).max(240),
        fileCount: z.number().int().positive().max(200),
        totalBytes: z.number().int().positive().max(30 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        files: z.array(z.string().min(1).max(240)).max(200),
      })
      .strict(),
    metadata: z
      .object({
        license: z.string().min(1).max(500).optional(),
        compatibility: z.string().min(1).max(500).optional(),
        author: z.string().min(1).max(200).optional(),
        version: z.string().min(1).max(100).optional(),
        allowedTools: z.string().min(1).max(1_000).optional(),
      })
      .strict(),
    conflict: z
      .object({
        exists: z.boolean(),
        existing: skillSummarySchema.optional(),
      })
      .strict(),
    warnings: z.array(skillImportWarningSchema).max(50),
    expiresAt: z.string().datetime(),
  })
  .strict()
export type SkillImportPreview = z.infer<typeof skillImportPreviewSchema>

export const commitSkillImportRequestSchema = z
  .object({
    previewId: idSchema,
    conflictStrategy: z.enum(["reject", "replace"]).default("reject"),
  })
  .strict()
export type CommitSkillImportRequest = z.infer<typeof commitSkillImportRequestSchema>

export const commitSkillImportResponseSchema = z
  .object({
    skill: skillSummarySchema,
    replaced: z.boolean(),
    warnings: z.array(skillImportWarningSchema).max(50),
  })
  .strict()
export type CommitSkillImportResponse = z.infer<typeof commitSkillImportResponseSchema>

export const updateSkillStateRequestSchema = z.object({ enabled: z.boolean() }).strict()
export type UpdateSkillStateRequest = z.infer<typeof updateSkillStateRequestSchema>

export const updateSkillStateResponseSchema = z.object({ skill: skillSummarySchema }).strict()
export type UpdateSkillStateResponse = z.infer<typeof updateSkillStateResponseSchema>

export const approveMemorySkillProposalResponseSchema = z
  .object({
    actionId: idSchema,
    skill: skillSummarySchema,
  })
  .strict()
export type ApproveMemorySkillProposalResponse = z.infer<typeof approveMemorySkillProposalResponseSchema>

export const rejectMemorySkillProposalResponseSchema = z
  .object({
    actionId: idSchema,
    status: z.literal("rejected"),
  })
  .strict()
export type RejectMemorySkillProposalResponse = z.infer<typeof rejectMemorySkillProposalResponseSchema>

export const deleteSkillResponseSchema = z
  .object({
    deletedSkillName: z.string().min(1),
    scope: skillScopeSchema,
  })
  .strict()
export type DeleteSkillResponse = z.infer<typeof deleteSkillResponseSchema>

export const mcpServerConfigInputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/, "Use lowercase letters, numbers, underscores, or hyphens."),
    label: z.string().min(1).max(120).optional(),
    command: z.string().min(1),
    args: z.array(z.string()).max(40).optional(),
    env: z.record(z.string(), z.string()).optional(),
    secretEnv: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    requiresSecrets: z.boolean().optional(),
  })
  .strict()
export type McpServerConfigInput = z.infer<typeof mcpServerConfigInputSchema>

export const getMcpServerConfigResponseSchema = z.object({ server: mcpServerConfigInputSchema }).strict()
export type GetMcpServerConfigResponse = z.infer<typeof getMcpServerConfigResponseSchema>

export const mcpConfigFormatSchema = z.enum(["auto", "json", "toml"])
export type McpConfigFormat = z.infer<typeof mcpConfigFormatSchema>

export const parseMcpConfigRequestSchema = z
  .object({
    content: z.string().min(1).max(50_000),
    format: mcpConfigFormatSchema.default("auto"),
  })
  .strict()
export type ParseMcpConfigRequest = z.infer<typeof parseMcpConfigRequestSchema>

export const parseMcpConfigResponseSchema = z
  .object({
    format: z.enum(["json", "toml"]),
    servers: z.array(mcpServerConfigInputSchema).min(1).max(20),
    warnings: z.array(z.string()),
  })
  .strict()
export type ParseMcpConfigResponse = z.infer<typeof parseMcpConfigResponseSchema>

export const openMcpConfigRequestSchema = z
  .object({
    scope: mcpServerScopeSchema,
    projectId: z.string().min(1).optional(),
    target: z.enum(["config", "secrets"]),
  })
  .strict()
export type OpenMcpConfigRequest = z.infer<typeof openMcpConfigRequestSchema>

export const openMcpConfigResponseSchema = z.object({ path: z.string().min(1) }).strict()
export type OpenMcpConfigResponse = z.infer<typeof openMcpConfigResponseSchema>

export const mcpServerStatusSchema = mcpRegistryServerSchema.extend({
  scope: mcpServerScopeSchema,
})
export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>

export const listMcpServersQuerySchema = z
  .object({
    projectId: z.string().min(1).optional(),
    scope: mcpServerScopeSchema.optional(),
  })
  .strict()
export type ListMcpServersQuery = z.infer<typeof listMcpServersQuerySchema>

export const listMcpServersResponseSchema = z
  .object({
    servers: z.array(mcpServerStatusSchema),
    paths: z
      .object({
        scope: mcpServerScopeSchema,
        configPath: z.string().min(1),
        envPath: z.string().min(1),
      })
      .strict(),
  })
  .strict()
export type ListMcpServersResponse = z.infer<typeof listMcpServersResponseSchema>

export const upsertMcpServerRequestSchema = z
  .object({
    scope: mcpServerScopeSchema,
    projectId: z.string().min(1).optional(),
    server: mcpServerConfigInputSchema,
  })
  .strict()
export type UpsertMcpServerRequest = z.infer<typeof upsertMcpServerRequestSchema>

export const upsertMcpServerResponseSchema = z
  .object({
    server: mcpServerStatusSchema,
  })
  .strict()
export type UpsertMcpServerResponse = z.infer<typeof upsertMcpServerResponseSchema>

export const updateMcpServerRequestSchema = z
  .object({
    scope: mcpServerScopeSchema,
    projectId: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
export type UpdateMcpServerRequest = z.infer<typeof updateMcpServerRequestSchema>

export const updateMcpServerResponseSchema = z
  .object({
    server: mcpServerStatusSchema,
  })
  .strict()
export type UpdateMcpServerResponse = z.infer<typeof updateMcpServerResponseSchema>

export const deleteMcpServerRequestSchema = z
  .object({
    scope: mcpServerScopeSchema,
    projectId: z.string().min(1).optional(),
  })
  .strict()
export type DeleteMcpServerRequest = z.infer<typeof deleteMcpServerRequestSchema>

export const deleteMcpServerResponseSchema = z
  .object({
    deletedServerId: z.string().min(1),
    scope: mcpServerScopeSchema,
  })
  .strict()
export type DeleteMcpServerResponse = z.infer<typeof deleteMcpServerResponseSchema>

export const checkMcpServerRequestSchema = z
  .object({
    scope: mcpServerScopeSchema.optional(),
    projectId: z.string().min(1).optional(),
    enableOnSuccess: z.boolean().optional(),
  })
  .strict()
export type CheckMcpServerRequest = z.infer<typeof checkMcpServerRequestSchema>

export const checkMcpServerResponseSchema = z
  .object({
    server: mcpServerStatusSchema,
    tools: z.array(mcpRegistryToolDescriptorSchema),
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type CheckMcpServerResponse = z.infer<typeof checkMcpServerResponseSchema>

export const updateMemoryAgentGlobalSettingsResponseSchema = z
  .object({
    settings: memoryAgentGlobalSettingsSchema,
  })
  .strict()
export type UpdateMemoryAgentGlobalSettingsResponse = z.infer<typeof updateMemoryAgentGlobalSettingsResponseSchema>

export const listWorkerModelSettingsResponseSchema = z
  .object({
    settings: z.array(workerModelSettingsSchema),
    resolutions: z.array(modelSettingsResolutionSchema).optional(),
  })
  .strict()
export type ListWorkerModelSettingsResponse = z.infer<typeof listWorkerModelSettingsResponseSchema>

export const updateWorkerModelSettingsRequestSchema = z
  .object({
    providerId: providerIdSchema,
    authMode: providerAuthModeSchema.optional(),
    modelId: z.string().min(1),
    thinkingEnabled: z.boolean(),
    thinkingEffort: thinkingEffortSchema.optional(),
  })
  .strict()
export type UpdateWorkerModelSettingsRequest = z.infer<typeof updateWorkerModelSettingsRequestSchema>

export const updateWorkerModelSettingsResponseSchema = z
  .object({
    settings: workerModelSettingsSchema,
  })
  .strict()
export type UpdateWorkerModelSettingsResponse = z.infer<typeof updateWorkerModelSettingsResponseSchema>

export const workerModelSettingsParamsSchema = z
  .object({
    workerId: workerModelRoleSchema,
  })
  .strict()

export const triggerMemoryAgentRunResponseSchema = z
  .object({
    state: memoryAgentGlobalStateSchema,
    pending: memoryAgentSignalSnapshotSchema,
    item: memoryAgentTimelineItemSchema.optional(),
    skippedReason: z.string().optional(),
  })
  .strict()
export type TriggerMemoryAgentRunResponse = z.infer<typeof triggerMemoryAgentRunResponseSchema>

export const getProjectResponseSchema = z
  .object({
    project: projectSchema,
    primaryWorkspace: projectWorkspaceSchema,
    resources: z.array(projectResourceSchema),
    conversations: z.array(conversationSchema),
    instructions: projectInstructionsSummarySchema.optional(),
    skills: z.array(skillSummarySchema),
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

export const projectRetrievalStatusSchema = z
  .object({
    status: z.enum(["pending", "rebuilding", "ready", "failed"]),
    lexicalReady: z.boolean(),
    vectorReady: z.boolean(),
    qaParents: z.number().int().nonnegative(),
    qaChunks: z.number().int().nonnegative(),
    memoryParents: z.number().int().nonnegative(),
    memoryChunks: z.number().int().nonnegative(),
    lastError: z.string().optional(),
    rebuildStartedAt: z.string().min(1).optional(),
    rebuildCompletedAt: z.string().min(1).optional(),
    updatedAt: z.string().min(1).optional(),
  })
  .strict()
export type ProjectRetrievalStatus = z.infer<typeof projectRetrievalStatusSchema>

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
    retrieval: projectRetrievalStatusSchema,
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

export const listOllamaEmbeddingModelsQuerySchema = z
  .object({
    ollamaBaseUrl: z.string().min(1).optional(),
  })
  .strict()
export type ListOllamaEmbeddingModelsQuery = z.infer<typeof listOllamaEmbeddingModelsQuerySchema>

export const ollamaEmbeddingModelStatusSchema = z.enum(["embedding", "not_embedding", "unknown"])
export type OllamaEmbeddingModelStatus = z.infer<typeof ollamaEmbeddingModelStatusSchema>

export const ollamaEmbeddingModelSchema = z
  .object({
    modelId: z.string().min(1),
    name: z.string().min(1),
    installed: z.boolean(),
    status: ollamaEmbeddingModelStatusSchema,
    embeddingCapable: z.boolean(),
    sizeBytes: z.number().int().nonnegative().optional(),
    sizeLabel: z.string().min(1).optional(),
    modifiedAt: z.string().min(1).optional(),
    family: z.string().min(1).optional(),
    families: z.array(z.string().min(1)).optional(),
    parameterSize: z.string().min(1).optional(),
    quantizationLevel: z.string().min(1).optional(),
    contextLength: z.number().int().positive().optional(),
    embeddingLength: z.number().int().positive().optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    description: z.string().min(1).optional(),
    pullCommand: z.string().min(1).optional(),
    recommendationReason: z.string().min(1).optional(),
    recommendedForThisSystem: z.boolean().optional(),
  })
  .strict()
export type OllamaEmbeddingModel = z.infer<typeof ollamaEmbeddingModelSchema>

export const ollamaRuntimeHardwareSchema = z
  .object({
    platform: z.string().min(1),
    arch: z.string().min(1),
    cpuCount: z.number().int().positive(),
    totalMemoryBytes: z.number().int().positive(),
    freeMemoryBytes: z.number().int().nonnegative(),
    memoryTier: z.enum(["compact", "balanced", "large"]),
    recommendationReason: z.string().min(1),
  })
  .strict()
export type OllamaRuntimeHardware = z.infer<typeof ollamaRuntimeHardwareSchema>

export const listOllamaEmbeddingModelsResponseSchema = z
  .object({
    reachable: z.boolean(),
    baseUrl: z.string().min(1),
    installedModels: z.array(ollamaEmbeddingModelSchema),
    embeddingModels: z.array(ollamaEmbeddingModelSchema),
    recommendedModels: z.array(ollamaEmbeddingModelSchema),
    suggestedModelId: z.string().min(1).optional(),
    hardware: ollamaRuntimeHardwareSchema,
    message: z.string().min(1),
    warnings: z.array(z.string()).optional(),
  })
  .strict()
export type ListOllamaEmbeddingModelsResponse = z.infer<typeof listOllamaEmbeddingModelsResponseSchema>

export const pullOllamaEmbeddingModelRequestSchema = z
  .object({
    modelId: z.string().min(1),
    ollamaBaseUrl: z.string().min(1).optional(),
  })
  .strict()
export type PullOllamaEmbeddingModelRequest = z.infer<typeof pullOllamaEmbeddingModelRequestSchema>

export const pullOllamaEmbeddingModelResponseSchema = z
  .object({
    modelId: z.string().min(1),
    ok: z.boolean(),
    message: z.string().min(1),
  })
  .strict()
export type PullOllamaEmbeddingModelResponse = z.infer<typeof pullOllamaEmbeddingModelResponseSchema>

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

export const uploadConversationAttachmentsResponseSchema = z
  .object({
    attachments: z.array(messageAttachmentSchema),
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

export const buildProjectSkillRequestSchema = z
  .object({
    request: z.string().min(1),
    name: skillNameInputSchema.optional(),
  })
  .strict()

export const buildProjectSkillResponseSchema = z
  .object({
    skill: skillSummarySchema,
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
    toolRunId: idSchema.optional(),
    providerToolCallId: z.string().min(1).optional(),
    conversationId: idSchema,
    sessionId: idSchema,
    turnId: idSchema,
    toolName: toolNameSchema,
    modelCallId: idSchema.optional(),
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
        operation: z.enum(["run", "start", "status", "output", "stop", "list"]).optional(),
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
            previousPath: z.string().min(1).optional(),
            status: z.string().min(1),
            contentHashBefore: z.string().min(1).optional(),
            contentHashAfter: z.string().min(1).optional(),
            sizeBytesBefore: z.number().int().nonnegative().optional(),
            sizeBytesAfter: z.number().int().nonnegative().optional(),
            lineDelta: z.number().int().optional(),
            verification: z.string().optional(),
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
    pty: z.string().optional(),
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

export const conversationActivityStepSchema = z
  .object({
    turnId: idSchema,
    modelCallId: idSchema,
    stepIndex: z.number().int().nonnegative(),
    reasoning: z.string().optional(),
    answer: z.string().optional(),
    toolCallIds: z.array(idSchema),
  })
  .strict()

export const getConversationResponseSchema = z
  .object({
    conversation: conversationSchema,
    messages: z.array(messageSchema),
    toolRuns: z.array(conversationToolRunSchema),
    activitySteps: z.array(conversationActivityStepSchema).optional(),
    terminals: z.array(conversationTerminalSchema).optional(),
    partialTurns: z.array(conversationPartialTurnSchema).optional(),
    tokenUsage: conversationTokenUsageSchema,
    costUsage: conversationCostUsageSchema,
    turnUsageReports: z.array(turnUsageReportSchema).optional(),
    contextUsage: conversationContextUsageSchema.optional(),
    lastRuntimeConfig: z
      .object({
        providerId: providerIdSchema,
        authMode: providerAuthModeSchema.optional(),
        modelId: z.string().min(1),
        thinkingEnabled: z.boolean(),
        thinkingEffort: thinkingEffortSchema.optional(),
        approvalMode: z.enum(["manual", "approve_all", "read_only_auto"]),
        sandboxMode: z.enum(["read_only", "workspace_write", "danger_full_access"]),
      })
      .strict()
      .optional(),
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

export const listNotificationsResponseSchema = z
  .object({
    notifications: z.array(notificationSchema),
    unreadCount: z.number().int().nonnegative(),
  })
  .strict()

export const markNotificationReadResponseSchema = z
  .object({
    notification: notificationSchema,
    unreadCount: z.number().int().nonnegative(),
  })
  .strict()

export const markAllNotificationsReadResponseSchema = z
  .object({
    notifications: z.array(notificationSchema),
    unreadCount: z.number().int().nonnegative(),
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
export type UploadConversationAttachmentsResponse = z.infer<typeof uploadConversationAttachmentsResponseSchema>
export type DeleteProjectResourceResponse = z.infer<typeof deleteProjectResourceResponseSchema>
export type UpsertProjectInstructionsRequest = z.infer<typeof upsertProjectInstructionsRequestSchema>
export type UpsertProjectInstructionsResponse = z.infer<typeof upsertProjectInstructionsResponseSchema>
export type BuildProjectSkillRequest = z.infer<typeof buildProjectSkillRequestSchema>
export type BuildProjectSkillResponse = z.infer<typeof buildProjectSkillResponseSchema>
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
export type ConversationActivityStep = z.infer<typeof conversationActivityStepSchema>
export type GetConversationResponse = z.infer<typeof getConversationResponseSchema>
export type UpdateConversationRequest = z.infer<typeof updateConversationRequestSchema>
export type UpdateConversationResponse = z.infer<typeof updateConversationResponseSchema>
export type DeleteConversationResponse = z.infer<typeof deleteConversationResponseSchema>
export type ListNotificationsResponse = z.infer<typeof listNotificationsResponseSchema>
export type MarkNotificationReadResponse = z.infer<typeof markNotificationReadResponseSchema>
export type MarkAllNotificationsReadResponse = z.infer<typeof markAllNotificationsReadResponseSchema>
export type CreateConversationMessageRequest = z.infer<typeof createConversationMessageRequestSchema>
export type CreateConversationMessageResponse = z.infer<typeof createConversationMessageResponseSchema>
