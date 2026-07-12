import { describe, expect, it } from "vitest"
import {
  apiResponseSchema,
  approveMemorySkillProposalResponseSchema,
  approvalDecideCommandSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  chatConversationSubscribeCommandSchema,
  chatConversationUnsubscribeCommandSchema,
  chatCompactionSchema,
  chatMessageSendCommandSchema,
  chatTurnCancelCommandSchema,
  checkProjectEmbeddingsRequestSchema,
  checkProjectEmbeddingsResponseSchema,
  checkProviderCredentialRequestSchema,
  checkProviderCredentialResponseSchema,
  clientCommandSchema,
  completeOnboardingRequestSchema,
  completeOnboardingResponseSchema,
  buildGlobalSkillRequestSchema,
  buildGlobalSkillResponseSchema,
  buildProjectSkillRequestSchema,
  buildProjectSkillResponseSchema,
  skillImportPreviewSchema,
  commitSkillImportRequestSchema,
  commitSkillImportResponseSchema,
  updateSkillStateRequestSchema,
  configureProjectEmbeddingsRequestSchema,
  configureProjectEmbeddingsResponseSchema,
  connectionReadyEventSchema,
  contextCompactionCompletedEventSchema,
  contextCompactionFailedEventSchema,
  contextCompactionStartedEventSchema,
  contextUsageSnapshotEventSchema,
  conversationSchema,
  conversationUpdatedEventSchema,
  createConversationRequestSchema,
  createConversationMessageRequestSchema,
  createConversationMessageResponseSchema,
  createConversationResponseSchema,
  createProjectRequestSchema,
  createProjectResponseSchema,
  createProjectResourceRequestSchema,
  createProjectResourceResponseSchema,
  deleteConversationResponseSchema,
  deleteProviderCredentialResponseSchema,
  deleteProjectResourceResponseSchema,
  errorCreatedEventSchema,
  feedbackSubmitCommandSchema,
  getConversationResponseSchema,
  getMemoryAgentFileContentResponseSchema,
  getMeResponseSchema,
  getMemoryAgentRunResponseSchema,
  getProjectEmbeddingsStatusResponseSchema,
  getProviderCredentialsStatusResponseSchema,
  getProjectResponseSchema,
  inspectWorkspaceRequestSchema,
  inspectWorkspaceResponseSchema,
  listOllamaEmbeddingModelsResponseSchema,
  listNotificationsResponseSchema,
  listMemoryAgentFilesResponseSchema,
  listMemoryAgentRunsResponseSchema,
  listProjectConversationsResponseSchema,
  listProjectResourcesResponseSchema,
  listProjectsResponseSchema,
  markAllNotificationsReadResponseSchema,
  markNotificationReadResponseSchema,
  memoryAgentGlobalSettingsSchema,
  memoryAgentGlobalStateSchema,
  getMemoryAgentResponseSchema,
  messageCompletedEventSchema,
  messageSchema,
  memoryAgentCompletedEventSchema,
  memoryCompactionSchema,
  memoryAgentCheckedEventSchema,
  memoryAgentFailedEventSchema,
  memoryAgentStartedEventSchema,
  memoryNoteCompletedEventSchema,
  memoryNoteCreatedEventSchema,
  memoryPrimaryUpdatedEventSchema,
  memorySkillApprovedEventSchema,
  memorySkillProposedEventSchema,
  memorySkillUpdatedEventSchema,
  memorySkillWriterFailedEventSchema,
  memorySkillWriterStartedEventSchema,
  memorySoulConfirmationRequestedEventSchema,
  memorySoulConfirmationResolvedEventSchema,
  memorySoulUpdatedEventSchema,
  anchorRepairSchema,
  notificationCreatedEventSchema,
  notificationReadEventSchema,
  patchProjectRequestSchema,
  patchProjectResponseSchema,
  pickWorkspaceFolderRequestSchema,
  pickWorkspaceFolderResponseSchema,
  pullOllamaEmbeddingModelRequestSchema,
  pullOllamaEmbeddingModelResponseSchema,
  reindexProjectEmbeddingsResponseSchema,
  rejectMemorySkillProposalResponseSchema,
  setProviderCredentialSessionRequestSchema,
  setProviderCredentialSessionResponseSchema,
  projectResourceSchema,
  projectSchema,
  projectWorkspaceSchema,
  serverEventSchema,
  toolCallCompletedEventSchema,
  toolCallFailedEventSchema,
  toolCallOutputEventSchema,
  toolCallStartedEventSchema,
  turnCompletedEventSchema,
  turnCancelledEventSchema,
  turnFailedEventSchema,
  turnStartedEventSchema,
  uploadProjectResourcesResponseSchema,
  updateConversationRequestSchema,
  updateConversationResponseSchema,
  updateMemoryAgentGlobalSettingsRequestSchema,
  updateMemoryAgentGlobalSettingsResponseSchema,
  updateWorkerModelSettingsRequestSchema,
  updateWorkerModelSettingsResponseSchema,
  updateProjectWorkspaceRequestSchema,
  updateProjectWorkspaceResponseSchema,
  upsertProjectInstructionsRequestSchema,
  upsertProjectInstructionsResponseSchema,
  userSchema,
  agentAnswerDeltaEventSchema,
  agentThinkingDeltaEventSchema,
  bashToolInputSchema,
  bashToolModelInputSchema,
  waitToolInputSchema,
  currentTimeToolInputSchema,
  currentTimeToolOutputSchema,
  applyPatchToolInputSchema,
  applyPatchToolModelInputSchema,
  editToolInputSchema,
  editToolModelInputSchema,
  editFilesToolInputSchema,
  editFilesToolOutputSchema,
  listProjectResourcesToolInputSchema,
  listProjectResourcesToolOutputSchema,
  memoryNoteToolInputSchema,
  memoryNoteToolOutputSchema,
  memoryNotesToolInputSchema,
  memoryNotesToolOutputSchema,
  memoryRouterPreTurnResultSchema,
  memoryRouterPostTurnResultSchema,
  memorySearchOutputSchema,
  turnEvidenceToolInputSchema,
  mcpRegistryToolInputSchema,
  mcpRegistryToolModelInputSchema,
  mcpRegistryToolOutputSchema,
  normalizedToolCallSchema,
  skillsToolModelInputSchema,
  skillsToolInputSchema,
  skillsToolOutputSchema,
  skillWriteToolInputSchema,
  skillWriteToolOutputSchema,
  toolDocsToolInputSchema,
  toolDocsToolOutputSchema,
  projectDocsToolInputSchema,
  projectDocsToolModelInputSchema,
  projectDocsToolOutputSchema,
  projectsToolInputSchema,
  projectsToolOutputSchema,
  repoDocsToolInputSchema,
  repoDocsToolModelInputSchema,
  repoDocsToolOutputSchema,
  readToolInputSchema,
  readToolOutputSchema,
  searchToolInputSchema,
  urlFetchToolInputSchema,
  urlFetchToolOutputSchema,
  soulToolInputSchema,
  soulToolOutputSchema,
  userProfileToolInputSchema,
  userProfileToolOutputSchema,
  toolExecutionResultSchema,
  traceRetrieveToolInputSchema,
  traceRetrieveToolModelInputSchema,
  traceRetrieveToolOutputSchema,
  traceRetrieveGlobalToolInputSchema,
  traceRetrieveGlobalToolOutputSchema,
  traceRetrieveMainToolInputSchema,
  traceRetrieveMainToolOutputSchema,
  triggerMemoryAgentRunResponseSchema,
  listWorkerModelSettingsResponseSchema,
  workerModelSettingsParamsSchema,
  conversationToolRunSchema,
  editToolOutputSchema,
} from "./index"

const timestamp = "2026-05-13T21:30:00.000Z"

const user = {
  id: "user_1",
  displayName: "Ayush",
  onboardingCompleted: true,
}

const project = {
  id: "proj_1",
  userId: "user_1",
  name: "Socrates",
  status: "active",
  updatedAt: timestamp,
}

const workspace = {
  id: "pws_1",
  projectId: "proj_1",
  kind: "existing_folder",
  path: "/tmp/socrates",
  isPrimary: true,
  status: "active",
}

const resource = {
  id: "pres_1",
  projectId: "proj_1",
  name: "README.md",
  kind: "document",
  source: "uploaded",
  uri: "/tmp/socrates/.socrates/resources/README.md",
  sizeBytes: 2048,
  mimeType: "text/markdown",
  status: "active",
}

const instructions = {
  id: "pins_1",
  projectId: "proj_1",
  content: "Be direct.",
  updatedAt: timestamp,
}

const skill = {
  name: "memory-review",
  description: "Use when reviewing Socrates memory changes.",
  scope: "project" as const,
  path: "memory-review/SKILL.md",
  updatedAt: timestamp,
}

const conversation = {
  id: "conv_1",
  projectId: "proj_1",
  title: "Build contracts",
  status: "active",
  updatedAt: timestamp,
}

const embeddingStatus = {
  configured: true,
  ready: true,
  providerId: "ollama",
  modelId: "embeddinggemma",
  configId: "embcfg_1",
  dimensions: 768,
  credentialSource: "none",
  ollamaBaseUrl: "http://127.0.0.1:11434",
  status: "ready",
  totalDocuments: 10,
  indexedDocuments: 8,
  pendingDocuments: 2,
  failedDocuments: 0,
  activeJob: {
    id: "tjob_1",
    status: "running",
    createdAt: timestamp,
    startedAt: timestamp,
  },
  retrieval: {
    status: "rebuilding",
    lexicalReady: true,
    vectorReady: false,
    qaParents: 6,
    qaChunks: 8,
    memoryParents: 2,
    memoryChunks: 2,
    rebuildStartedAt: timestamp,
    updatedAt: timestamp,
  },
  updatedAt: timestamp,
}

const userMessage = {
  id: "msg_user_1",
  conversationId: "conv_1",
  sessionId: "sess_1",
  turnId: "turn_1",
  role: "user",
  content: "Start the sprint",
  status: "completed",
  createdAt: timestamp,
}

const assistantMessage = {
  id: "msg_assistant_1",
  conversationId: "conv_1",
  sessionId: "sess_1",
  turnId: "turn_1",
  role: "assistant",
  content: "Done.",
  reasoning: "Checked the project context.",
  status: "completed",
  createdAt: timestamp,
}

const cancelledPartialAssistantMessage = {
  ...assistantMessage,
  id: "msg_assistant_cancelled_1",
  content: "Partial answer.",
  reasoning: undefined,
  partial: true,
  cancelled: true,
  cancellationReason: "User clicked stop",
  status: "cancelled",
}

function envelope<TType extends string, TPayload>(type: TType, payload: TPayload) {
  return {
    id: `evt_${type}`,
    type,
    schemaVersion: 1,
    timestamp,
    projectId: "proj_1",
    conversationId: "conv_1",
    sessionId: "sess_1",
    turnId: "turn_1",
    actor: {
      type: "main_agent",
      id: "agent_main",
      label: "Socrates",
    },
    payload,
  }
}

describe("api contracts", () => {
  it("parses successful and failed API responses", () => {
    const schema = apiResponseSchema(getMeResponseSchema)

    expect(schema.safeParse({ ok: true, data: { user } }).success).toBe(true)
    expect(
      schema.safeParse({
        ok: false,
        error: {
          code: "not_found",
          message: "Not found",
        },
      }).success,
    ).toBe(true)
  })

  it("rejects malformed API errors", () => {
    const schema = apiResponseSchema(getMeResponseSchema)

    expect(schema.safeParse({ ok: false, error: { code: "", message: "" } }).success).toBe(false)
  })
})

describe("entity contracts", () => {
  it("parses core entities", () => {
    expect(userSchema.safeParse(user).success).toBe(true)
    expect(projectSchema.safeParse(project).success).toBe(true)
    expect(projectWorkspaceSchema.safeParse(workspace).success).toBe(true)
    expect(projectResourceSchema.safeParse(resource).success).toBe(true)
    expect(conversationSchema.safeParse(conversation).success).toBe(true)
    expect(messageSchema.safeParse(userMessage).success).toBe(true)
    expect(messageSchema.safeParse(cancelledPartialAssistantMessage).success).toBe(true)
  })

  it("rejects missing required fields and invalid enums", () => {
    expect(projectSchema.safeParse({ ...project, name: undefined }).success).toBe(false)
    expect(projectWorkspaceSchema.safeParse({ ...workspace, status: "unknown" }).success).toBe(false)
    expect(messageSchema.safeParse({ ...userMessage, role: "robot" }).success).toBe(false)
  })
})

describe("http contracts", () => {
  it("parses onboarding contracts", () => {
    expect(completeOnboardingRequestSchema.safeParse({ displayName: "Ayush" }).success).toBe(true)
    expect(completeOnboardingResponseSchema.safeParse({ user }).success).toBe(true)
  })

  it("parses provider credential contracts without exposing secret values", () => {
    const status = {
      providerId: "openrouter",
      providerLabel: "OpenRouter",
      required: true,
      configured: true,
      source: "local_file",
      message: "Required for chat and context compression.",
    }

    expect(
      getProviderCredentialsStatusResponseSchema.safeParse({
        providers: [status],
        openRouterRequired: true,
        openAiRequiredForHostedEmbeddings: true,
        googleOptional: true,
        deepSeekOptional: true,
      }).success,
    ).toBe(true)
    expect(setProviderCredentialSessionRequestSchema.safeParse({ providerId: "openrouter", apiKey: "sk-test", source: "local_file" }).success).toBe(true)
    expect(setProviderCredentialSessionRequestSchema.safeParse({ providerId: "deepseek", apiKey: "sk-test", source: "local_file" }).success).toBe(true)
    expect(setProviderCredentialSessionResponseSchema.safeParse({ status }).success).toBe(true)
    expect(checkProviderCredentialRequestSchema.safeParse({ providerId: "openrouter" }).success).toBe(true)
    expect(
      checkProviderCredentialResponseSchema.safeParse({
        providerId: "openrouter",
        ok: true,
        configured: true,
        source: "session",
        message: "OpenRouter credential is configured.",
      }).success,
    ).toBe(true)
    expect(deleteProviderCredentialResponseSchema.safeParse({ status: { ...status, configured: false, source: "missing" } }).success).toBe(true)
    expect(
      getProviderCredentialsStatusResponseSchema.safeParse({
        providers: [{ ...status, apiKey: "must-not-parse" }],
        openRouterRequired: true,
        openAiRequiredForHostedEmbeddings: true,
        googleOptional: true,
        deepSeekOptional: true,
      }).success,
    ).toBe(false)
  })

  it("parses project list, creation, and dashboard contracts", () => {
    expect(
      listProjectsResponseSchema.safeParse({
        projects: [{ project, primaryWorkspace: workspace, conversationCount: 1, lastActivityAt: timestamp }],
      }).success,
    ).toBe(true)
    expect(
      listProjectsResponseSchema.safeParse({
        projects: [{ project, conversationCount: 1 }],
      }).success,
    ).toBe(false)

    expect(
      createProjectRequestSchema.safeParse({
        name: "Socrates",
        creationMode: "existing_folder",
        workspacePath: "/tmp/socrates",
        scaffoldAction: "use_existing",
      }).success,
    ).toBe(true)

    expect(createProjectResponseSchema.safeParse({ project, primaryWorkspace: workspace }).success).toBe(true)
    expect(createProjectResponseSchema.safeParse({ project }).success).toBe(false)
    expect(
      getProjectResponseSchema.safeParse({
        project,
        primaryWorkspace: workspace,
        resources: [resource],
        conversations: [conversation],
        instructions,
        skills: [skill],
      }).success,
    ).toBe(true)
    expect(
      getProjectResponseSchema.safeParse({
        project,
        resources: [],
        conversations: [],
      }).success,
    ).toBe(false)
  })

  it("parses project patch and resource contracts", () => {
    expect(patchProjectRequestSchema.safeParse({ name: "Socrates v2", status: "active" }).success).toBe(true)
    expect(patchProjectResponseSchema.safeParse({ project }).success).toBe(true)
    expect(listProjectResourcesResponseSchema.safeParse({ resources: [resource] }).success).toBe(true)
    expect(
      createProjectResourceRequestSchema.safeParse({
        name: "Docs",
        kind: "document",
        source: "uploaded",
        uri: "/tmp/docs.md",
      }).success,
    ).toBe(true)
    expect(createProjectResourceResponseSchema.safeParse({ resource }).success).toBe(true)
    expect(uploadProjectResourcesResponseSchema.safeParse({ resources: [resource] }).success).toBe(true)
    expect(deleteProjectResourceResponseSchema.safeParse({ deletedResourceId: resource.id }).success).toBe(true)
    expect(projectResourceSchema.safeParse(resource).success).toBe(true)
    expect(pickWorkspaceFolderRequestSchema.safeParse({ mode: "start_from_scratch" }).success).toBe(true)
    expect(
      pickWorkspaceFolderResponseSchema.safeParse({ path: "/tmp/socrates", folderName: "socrates" }).success,
    ).toBe(true)
    expect(inspectWorkspaceRequestSchema.safeParse({ workspacePath: "/tmp/socrates" }).success).toBe(true)
    expect(
      inspectWorkspaceResponseSchema.safeParse({
        workspacePath: "/tmp/socrates",
        folderName: "socrates",
        exists: true,
        isDirectory: true,
        hasSocratesDir: true,
        hasResourcesDir: false,
      }).success,
    ).toBe(true)
    expect(
      updateProjectWorkspaceRequestSchema.safeParse({
        workspacePath: "/tmp/socrates-v2",
        creationMode: "existing_folder",
        scaffoldAction: "reset",
      }).success,
    ).toBe(true)
    expect(updateProjectWorkspaceResponseSchema.safeParse({ primaryWorkspace: workspace, resources: [resource] }).success).toBe(true)
    expect(
      getProjectResponseSchema.safeParse({
        project,
        primaryWorkspace: workspace,
        resources: [resource],
        conversations: [conversation],
        instructions,
        skills: [skill],
        embeddingStatus,
      }).success,
    ).toBe(true)
  })

  it("parses global memory agent HTTP contracts", () => {
    const settings = {
      id: "memcfg_global",
      providerId: "openrouter",
      modelId: "xiaomi/mimo-v2.5-pro",
      thinkingEnabled: false,
      enabled: true,
      cadenceMinutes: 10,
      updatedAt: timestamp,
    }
    const state = {
      id: "global",
      lastProcessedEventSequence: 42,
      lastCheckedAt: timestamp,
      lastRealRunAt: timestamp,
      status: "idle",
      lastJobId: "memjob_1",
      updatedAt: timestamp,
    }
    const pending = {
      sequenceFrom: 43,
      sequenceTo: 46,
      turnCount: 4,
      toolCalls: 1,
      fileChangeEvents: 0,
      distinctChangedFiles: 0,
      totalTokens: 1200,
      shouldRun: true,
      reasons: ["4 completed turns"],
      displayReason: "Memory threshold reached: 4 completed turns.",
    }
    const item = {
      id: "memjob_1",
      itemType: "run",
      runId: "memjob_1",
      status: "completed",
      trigger: "manual",
      title: "Memory run",
      displayReason: "Memory threshold reached: 4 completed turns.",
      providerId: "openrouter",
      modelId: "xiaomi/mimo-v2.5-pro",
      evidenceTurnCount: 2,
      evidenceTokensEstimate: 320,
      startedAt: timestamp,
      completedAt: timestamp,
      sequenceFrom: 41,
      sequenceTo: 42,
      totalTokens: 400,
      costUsd: 0.002,
    }
    const runDetail = {
      ...item,
      itemType: "run",
      providerId: "openrouter",
      modelId: "xiaomi/mimo-v2.5-pro",
      summary: {
        investigated: "Checked trace evidence.",
        changed: "Updated one tool doc.",
        skipped: "No skills.",
        blocked: "None.",
      },
      toolEvents: [],
      actions: [
        {
          id: "memact_1",
          jobId: "memjob_1",
          targetKind: "tool_usage",
          targetPath: "/tmp/.Socrates/tool_usage/read_search.md",
          status: "applied",
          requiresConfirmation: false,
          createdAt: timestamp,
          appliedAt: timestamp,
        },
      ],
    }
    expect(memoryAgentGlobalSettingsSchema.safeParse(settings).success).toBe(true)
    expect(updateMemoryAgentGlobalSettingsRequestSchema.safeParse({ enabled: false, cadenceMinutes: 30 }).success).toBe(true)
    expect(updateMemoryAgentGlobalSettingsRequestSchema.safeParse({ cadenceMinutes: 0 }).success).toBe(false)
    expect(updateMemoryAgentGlobalSettingsResponseSchema.safeParse({ settings }).success).toBe(true)
    expect(memoryAgentGlobalStateSchema.safeParse(state).success).toBe(true)
    expect(getMemoryAgentResponseSchema.safeParse({ settings, state, pending, recentItems: [item] }).success).toBe(true)
    expect(listMemoryAgentRunsResponseSchema.safeParse({ items: [item], totalMatches: 1 }).success).toBe(true)
    expect(getMemoryAgentRunResponseSchema.safeParse({ run: runDetail }).success).toBe(true)
    expect(
      listMemoryAgentFilesResponseSchema.safeParse({
        files: [
          {
            id: "identity:identity.md",
            kind: "identity",
            name: "Identity",
            path: "identity.md",
            absolutePath: "/tmp/.Socrates/identity.md",
            updatedAt: timestamp,
          },
          {
            id: "user_profile:user_profile.md",
            kind: "user_profile",
            name: "User Profile",
            path: "user_profile.md",
            absolutePath: "/tmp/.Socrates/user_profile.md",
            updatedAt: timestamp,
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      getMemoryAgentFileContentResponseSchema.safeParse({
        file: {
          id: "identity:identity.md",
          kind: "identity",
          name: "Identity",
          path: "identity.md",
          absolutePath: "/tmp/.Socrates/identity.md",
        },
        content: "# Identity",
      }).success,
    ).toBe(true)
    expect(buildGlobalSkillRequestSchema.safeParse({ name: "global-review", request: "Build a global review skill" }).success).toBe(true)
    expect(buildGlobalSkillRequestSchema.safeParse({ name: "global--review", request: "Build a global review skill" }).success).toBe(false)
    expect(buildGlobalSkillResponseSchema.safeParse({ skill }).success).toBe(true)
    const importPreview = {
      previewId: "skillimp_1",
      scope: "global",
      skill: { ...skill, scope: "global", source: "imported", enabled: true, contentHash: "a".repeat(64), installedAt: "2026-07-11T00:00:00.000Z" },
      package: { filename: "review.zip", fileCount: 2, totalBytes: 500, sha256: "a".repeat(64), files: ["review/SKILL.md", "review/references/checklist.md"] },
      metadata: { license: "Apache-2.0" },
      conflict: { exists: false },
      warnings: [],
      expiresAt: "2026-07-12T00:00:00.000Z",
    }
    expect(skillImportPreviewSchema.safeParse(importPreview).success).toBe(true)
    expect(commitSkillImportRequestSchema.parse({ previewId: "skillimp_1" })).toMatchObject({ conflictStrategy: "reject" })
    expect(commitSkillImportResponseSchema.safeParse({ skill: importPreview.skill, replaced: false, warnings: [] }).success).toBe(true)
    expect(updateSkillStateRequestSchema.safeParse({ enabled: false }).success).toBe(true)
    expect(approveMemorySkillProposalResponseSchema.safeParse({ actionId: "memact_1", skill }).success).toBe(true)
    expect(rejectMemorySkillProposalResponseSchema.safeParse({ actionId: "memact_1", status: "rejected" }).success).toBe(true)
    expect(triggerMemoryAgentRunResponseSchema.safeParse({ state, pending, item }).success).toBe(true)
  })

  it("parses project embedding HTTP contracts", () => {
    expect(checkProjectEmbeddingsRequestSchema.safeParse({ providerId: "openai", modelId: "text-embedding-3-small" }).success).toBe(true)
    expect(
      checkProjectEmbeddingsRequestSchema.safeParse({
        providerId: "ollama",
        credentialSource: "none",
        ollamaBaseUrl: "http://127.0.0.1:11434",
      }).success,
    ).toBe(true)
    expect(checkProjectEmbeddingsRequestSchema.safeParse({ providerId: "huggingface" }).success).toBe(false)
    expect(
      checkProjectEmbeddingsResponseSchema.safeParse({
        providerId: "openai",
        modelId: "text-embedding-3-small",
        ok: true,
        dimensions: 1536,
        serverEnvAvailable: false,
        workspaceEnvCandidates: [{ fileName: ".env.local", hasOpenAiApiKey: true }],
        message: "Checked.",
      }).success,
    ).toBe(true)
    expect(
      listOllamaEmbeddingModelsResponseSchema.safeParse({
        reachable: true,
        baseUrl: "http://127.0.0.1:11434",
        installedModels: [
          {
            modelId: "embeddinggemma:latest",
            name: "embeddinggemma:latest",
            installed: true,
            status: "embedding",
            embeddingCapable: true,
            capabilities: ["embedding"],
          },
        ],
        embeddingModels: [
          {
            modelId: "embeddinggemma:latest",
            name: "embeddinggemma:latest",
            installed: true,
            status: "embedding",
            embeddingCapable: true,
          },
        ],
        recommendedModels: [
          {
            modelId: "embeddinggemma:latest",
            name: "EmbeddingGemma",
            installed: true,
            status: "embedding",
            embeddingCapable: true,
            pullCommand: "ollama pull embeddinggemma:latest",
            recommendedForThisSystem: true,
          },
        ],
        suggestedModelId: "embeddinggemma:latest",
        hardware: {
          platform: "darwin",
          arch: "arm64",
          cpuCount: 8,
          totalMemoryBytes: 16_000_000_000,
          freeMemoryBytes: 4_000_000_000,
          memoryTier: "balanced",
          recommendationReason: "Laptop default.",
        },
        message: "Ollama is running.",
      }).success,
    ).toBe(true)
    expect(
      pullOllamaEmbeddingModelRequestSchema.safeParse({
        modelId: "embeddinggemma:latest",
        ollamaBaseUrl: "http://127.0.0.1:11434",
      }).success,
    ).toBe(true)
    expect(
      pullOllamaEmbeddingModelResponseSchema.safeParse({
        modelId: "embeddinggemma:latest",
        ok: true,
        message: "Pulled exactly embeddinggemma:latest.",
      }).success,
    ).toBe(true)
    expect(
      configureProjectEmbeddingsRequestSchema.safeParse({
        providerId: "openai",
        modelId: "text-embedding-3-small",
        credentialSource: "workspace_env",
        workspaceEnvFile: ".env.local",
      }).success,
    ).toBe(true)
    expect(configureProjectEmbeddingsResponseSchema.safeParse({ status: embeddingStatus }).success).toBe(true)
    expect(getProjectEmbeddingsStatusResponseSchema.safeParse({ status: embeddingStatus }).success).toBe(true)
    expect(reindexProjectEmbeddingsResponseSchema.safeParse({ status: embeddingStatus }).success).toBe(true)
  })

  it("parses project instructions contracts", () => {
    expect(upsertProjectInstructionsRequestSchema.safeParse({ content: "Use the repo docs first." }).success).toBe(true)
    expect(upsertProjectInstructionsRequestSchema.safeParse({ content: "" }).success).toBe(false)
    expect(upsertProjectInstructionsResponseSchema.safeParse({ instructions }).success).toBe(true)
    expect(buildProjectSkillRequestSchema.safeParse({ name: "memory-review", request: "Build a memory review skill." }).success).toBe(true)
    expect(buildProjectSkillRequestSchema.safeParse({ name: "memory--review", request: "Build a memory review skill." }).success).toBe(false)
    expect(buildProjectSkillResponseSchema.safeParse({ skill }).success).toBe(true)
  })

  it("parses conversation creation contracts", () => {
    expect(listProjectConversationsResponseSchema.safeParse({ conversations: [conversation] }).success).toBe(true)
    expect(createConversationRequestSchema.safeParse({ title: "Build contracts" }).success).toBe(true)
    expect(createConversationRequestSchema.safeParse({}).success).toBe(true)
    expect(createConversationResponseSchema.safeParse({ conversation }).success).toBe(true)
    expect(
      getConversationResponseSchema.safeParse({
        conversation,
        messages: [userMessage, assistantMessage],
        toolRuns: [],
        partialTurns: [
          {
            turnId: "turn_interrupted",
            status: "running",
            answer: "Partial answer recovered from stream chunks.",
            reasoning: "Recovered reasoning.",
          },
          {
            turnId: "turn_waiting",
            status: "suspended",
          },
        ],
        tokenUsage: {
          totalTokens: 12,
          inputTokens: 6,
          outputTokens: 4,
          reasoningTokens: 2,
        },
        costUsage: {
          totalCostUsd: 0.0012,
          totalTokens: 12,
          cachedInputTokens: 2,
          cacheWriteTokens: 1,
          turnCount: 1,
          costSource: "provider_reported",
          hasComputedCost: false,
          hasUnknownCost: false,
        },
        turnUsageReports: [
          {
            turnId: "turn_1",
            totalCostUsd: 0.0012,
            totalTokens: 12,
            inputTokens: 6,
            outputTokens: 4,
            reasoningTokens: 2,
            cachedInputTokens: 2,
            cacheWriteTokens: 1,
            uncachedInputTokens: 4,
            costSource: "provider_reported",
            providerBreakdown: [],
            modelBreakdown: [],
            callBreakdown: [],
            compactionBreakdown: [],
            qualityFlags: [],
          },
        ],
        contextUsage: {
          providerId: "openrouter",
          modelId: "deepseek/deepseek-v4-pro",
          contextWindowTokens: 180000,
          contextUsedTokens: 42000,
          contextLeftTokens: 138000,
          contextUsedPercent: 23.3,
        },
        lastRuntimeConfig: {
          providerId: "google",
          modelId: "gemini-3.5-flash",
          thinkingEnabled: true,
          thinkingEffort: "medium",
          approvalMode: "manual",
          sandboxMode: "workspace_write",
        },
      }).success,
    ).toBe(true)
    expect(
      conversationToolRunSchema.safeParse({
        toolCallId: "tcall_1",
        conversationId: conversation.id,
        sessionId: "sess_1",
        turnId: "turn_1",
        toolName: "bash",
        status: "cancelled",
        requiresApproval: true,
        arguments: { command: "pwd" },
        summary: "Command exited with code 0.",
        durationMs: 12,
        approval: {
          approvalId: "appr_1",
          status: "approved",
          actionKind: "shell_command",
          title: "Approve shell command",
          actionPreview: "pwd",
          risk: "low",
          decision: "approved",
        },
        shell: {
          command: "pwd",
          cwd: "/tmp/socrates",
          status: "completed",
          operation: "run",
          platform: "darwin",
          shellKind: "posix",
          shellExecutable: "/bin/zsh",
          exitCode: 0,
          durationMs: 12,
          stdout: "/tmp/socrates\n",
          stderr: "",
        },
      }).success,
    ).toBe(true)
    expect(updateConversationRequestSchema.safeParse({ title: "Renamed chat" }).success).toBe(true)
    expect(updateConversationRequestSchema.safeParse({ title: "" }).success).toBe(false)
    expect(updateConversationResponseSchema.safeParse({ conversation }).success).toBe(true)
    expect(deleteConversationResponseSchema.safeParse({ deletedConversationId: conversation.id }).success).toBe(true)
    const notification = {
      id: "note_1",
      projectId: project.id,
      type: "memory.soul.updated",
      title: "Socrates soul updated",
      body: "identity was updated",
      severity: "info",
      payload: { diff: "--- old\n+++ new" },
      createdAt: timestamp,
    }
    expect(listNotificationsResponseSchema.safeParse({ notifications: [notification], unreadCount: 1 }).success).toBe(true)
    expect(markNotificationReadResponseSchema.safeParse({ notification: { ...notification, readAt: timestamp }, unreadCount: 0 }).success).toBe(true)
    expect(markAllNotificationsReadResponseSchema.safeParse({ notifications: [{ ...notification, readAt: timestamp }], unreadCount: 0 }).success).toBe(true)
    expect(createConversationMessageRequestSchema.safeParse({ content: "Hello" }).success).toBe(true)
    expect(createConversationMessageRequestSchema.safeParse({ content: "" }).success).toBe(false)
    expect(createConversationMessageResponseSchema.safeParse({ conversation, message: userMessage }).success).toBe(true)
  })

  it("rejects invalid HTTP payloads", () => {
    expect(completeOnboardingRequestSchema.safeParse({ displayName: "" }).success).toBe(false)
    expect(createProjectRequestSchema.safeParse({ name: "Socrates", creationMode: "clone" }).success).toBe(false)
    expect(createProjectRequestSchema.safeParse({ name: "Socrates", creationMode: "existing_folder" }).success).toBe(
      false,
    )
  })
})

describe("websocket client command contracts", () => {
  const runtimeConfig = {
    providerId: "openai",
    modelId: "gpt-5.4",
    thinkingEnabled: true,
    thinkingEffort: "medium",
    approvalMode: "manual",
    sandboxMode: "workspace_write",
  }

  const commands = [
    chatMessageSendCommandSchema.safeParse(
      envelope("chat.message.send", {
        clientMessageId: "client_msg_1",
        content: "Hello",
        runtimeConfig,
      }),
    ),
    chatTurnCancelCommandSchema.safeParse(envelope("chat.turn.cancel", { turnId: "turn_1", reason: "User stopped" })),
    chatConversationSubscribeCommandSchema.safeParse(
      envelope("chat.conversation.subscribe", { replayActiveTurn: true }),
    ),
    chatConversationUnsubscribeCommandSchema.safeParse(envelope("chat.conversation.unsubscribe", {})),
    approvalDecideCommandSchema.safeParse(
      envelope("approval.decide", { approvalId: "appr_1", decision: "approved" }),
    ),
    feedbackSubmitCommandSchema.safeParse(
      envelope("feedback.submit", {
        messageId: "msg_assistant_1",
        turnId: "turn_1",
        rating: "thumbs_up",
      }),
    ),
    clientCommandSchema.safeParse(envelope("terminal.stop", { terminalId: "term_1", reason: "Done" })),
    clientCommandSchema.safeParse(envelope("terminal.input", { terminalId: "term_1", data: "\u0003" })),
    clientCommandSchema.safeParse(envelope("terminal.input", { terminalId: "term_1", text: "yes", submit: true })),
    clientCommandSchema.safeParse(envelope("terminal.input", { terminalId: "term_1", key: "ArrowDown" })),
    clientCommandSchema.safeParse(envelope("terminal.resize", { terminalId: "term_1", cols: 120, rows: 32 })),
    clientCommandSchema.safeParse(envelope("terminal.rename", { terminalId: "term_1", name: "frontend" })),
  ]

  it("parses every V1 client command", () => {
    expect(commands.every((result) => result.success)).toBe(true)
  })

  it("rejects unknown command types and malformed payloads", () => {
    expect(clientCommandSchema.safeParse(envelope("chat.unknown", {})).success).toBe(false)
    expect(clientCommandSchema.safeParse(envelope("terminal.input", { terminalId: "term_1" })).success).toBe(false)
    expect(
      clientCommandSchema.safeParse(
        envelope("chat.message.send", {
          clientMessageId: "client_msg_1",
          content: "",
          runtimeConfig,
        }),
      ).success,
    ).toBe(false)
    expect(
      clientCommandSchema.safeParse(
        envelope("chat.message.send", {
          clientMessageId: "client_msg_long",
          content: "x".repeat(10_001),
          runtimeConfig,
        }),
      ).success,
    ).toBe(false)
    expect(
      clientCommandSchema.safeParse(
        envelope("chat.message.send", {
          clientMessageId: "client_msg_attachments",
          content: "source files",
          attachmentIds: Array.from({ length: 15 }, (_, index) => `att_${index}`),
          runtimeConfig,
        }),
      ).success,
    ).toBe(true)
    expect(
      clientCommandSchema.safeParse(
        envelope("chat.message.send", {
          clientMessageId: "client_msg_too_many_attachments",
          content: "source files",
          attachmentIds: Array.from({ length: 16 }, (_, index) => `att_${index}`),
          runtimeConfig,
        }),
      ).success,
    ).toBe(false)
  })
})

describe("websocket server event contracts", () => {
  const serverEvents = [
    connectionReadyEventSchema.safeParse(
      envelope("connection.ready", {
        connectionId: "conn_1",
        serverTime: timestamp,
      }),
    ),
    turnStartedEventSchema.safeParse(envelope("turn.started", { turnId: "turn_1", userMessage })),
    conversationUpdatedEventSchema.safeParse(envelope("conversation.updated", { conversation })),
    agentThinkingDeltaEventSchema.safeParse(envelope("agent.thinking.delta", { text: "Considering files." })),
    agentAnswerDeltaEventSchema.safeParse(envelope("agent.answer.delta", { messageId: "msg_assistant_1", text: "Hi" })),
    toolCallStartedEventSchema.safeParse(
      envelope("tool.call.started", {
        toolCallId: "tcall_1",
        toolName: "read",
        category: "file",
        displayName: "Reading README.md",
        requiresApproval: false,
      }),
    ),
    toolCallOutputEventSchema.safeParse(
      envelope("tool.call.output", {
        toolCallId: "tcall_1",
        stream: "stdout",
        text: "ok",
      }),
    ),
    toolCallCompletedEventSchema.safeParse(
      envelope("tool.call.completed", {
        toolCallId: "tcall_1",
        summary: "Explored 1 file",
        metrics: {
          filesRead: 1,
        },
      }),
    ),
    toolCallFailedEventSchema.safeParse(
      envelope("tool.call.failed", {
        toolCallId: "tcall_1",
        error: {
          code: "tool_failed",
          message: "Tool failed",
        },
      }),
    ),
    approvalRequestedEventSchema.safeParse(
      envelope("approval.requested", {
        approvalId: "appr_1",
        toolCallId: "tcall_1",
        actionKind: "shell_command",
        title: "Run command",
        actionPreview: "pnpm test",
        risk: "medium",
      }),
    ),
    approvalResolvedEventSchema.safeParse(
      envelope("approval.resolved", {
        approvalId: "appr_1",
        decision: "approved",
      }),
    ),
    contextUsageSnapshotEventSchema.safeParse(
      envelope("context.usage.snapshot", {
        providerId: "openai",
        modelId: "gpt-5.4",
        contextWindowTokens: 1050000,
        contextUsedTokens: 55000,
        contextLeftTokens: 995000,
        contextUsedPercent: 5.2,
      }),
    ),
    contextCompactionStartedEventSchema.safeParse(
      envelope("context.compaction.started", {
        snapshotId: "ctxcmp_1",
        reason: "threshold",
        contextUsedTokensEstimate: 161000,
        targetTokens: 170000,
      }),
    ),
    contextCompactionCompletedEventSchema.safeParse(
      envelope("context.compaction.completed", {
        snapshotId: "ctxcmp_1",
        inputTokensEstimate: 161000,
        outputTokensEstimate: 1800,
        contextUsedTokensEstimate: 116000,
        sizeClass: "acceptable",
      }),
    ),
    contextCompactionFailedEventSchema.safeParse(
      envelope("context.compaction.failed", {
        snapshotId: "ctxcmp_1",
        error: {
          code: "context_compaction_failed",
          message: "Compressor failed",
        },
      }),
    ),
    memoryAgentStartedEventSchema.safeParse(
      envelope("memory.agent.started", {
        jobId: "memjob_1",
        trigger: "scheduled",
        sequenceFrom: 41,
        sequenceTo: 42,
        evidenceTokensEstimate: 1200,
      }),
    ),
    memoryAgentCompletedEventSchema.safeParse(
      envelope("memory.agent.completed", {
        jobId: "memjob_1",
        status: "completed",
        providerId: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        sequenceFrom: 41,
        sequenceTo: 42,
      }),
    ),
    memoryAgentFailedEventSchema.safeParse(
      envelope("memory.agent.failed", {
        jobId: "memjob_1",
        error: {
          code: "memory_agent_failed",
          message: "failed",
        },
      }),
    ),
    memoryAgentCheckedEventSchema.safeParse(
      envelope("memory.agent.checked", {
        checkId: "memchk_1",
        trigger: "scheduled",
        status: "skipped",
        reason: "Checked 2 new turns; below memory threshold.",
        pending: {
          sequenceFrom: 41,
          sequenceTo: 42,
          turnCount: 2,
          toolCalls: 1,
          fileChangeEvents: 0,
          distinctChangedFiles: 0,
          totalTokens: 1200,
          shouldRun: false,
          reasons: [],
          displayReason: "Checked 2 new turns; below memory threshold.",
        },
        checkedAt: timestamp,
      }),
    ),
    memoryPrimaryUpdatedEventSchema.safeParse(
      envelope("memory.primary.updated", {
        jobId: "memjob_1",
        actionId: "memact_1",
        path: "/tmp/user_profile.md",
        targetKind: "user_profile",
      }),
    ),
    memoryNoteCreatedEventSchema.safeParse(
      envelope("memory.note.created", {
        noteNumber: 1,
        importance: "normal",
        defaultSkillScope: "project",
      }),
    ),
    memoryNoteCompletedEventSchema.safeParse(
      envelope("memory.note.completed", {
        noteNumber: 1,
      }),
    ),
    memorySkillProposedEventSchema.safeParse(
      envelope("memory.skill.proposed", {
        jobId: "memjob_1",
        actionId: "memact_1",
        notificationId: "note_1",
        scope: "global",
        operation: "create",
        skillName: "memory-review",
        path: "skills/memory-review/SKILL.md",
      }),
    ),
    memorySkillApprovedEventSchema.safeParse(
      envelope("memory.skill.approved", {
        actionId: "memact_1",
        scope: "global",
        operation: "create",
        skillName: "memory-review",
        path: "skills/memory-review/SKILL.md",
      }),
    ),
    memorySkillUpdatedEventSchema.safeParse(
      envelope("memory.skill.updated", {
        jobId: "skjob_1",
        scope: "global",
        operation: "create",
        skillName: "memory-review",
        path: "skills/memory-review/SKILL.md",
        sourceKind: "memory_agent_action",
        sourceId: "memact_1",
      }),
    ),
    memorySkillWriterStartedEventSchema.safeParse(
      envelope("memory.skill_writer.started", {
        jobId: "skjob_1",
        scope: "global",
        operation: "create",
        skillName: "memory-review",
        sourceKind: "memory_agent_action",
        sourceId: "memact_1",
      }),
    ),
    memorySkillWriterFailedEventSchema.safeParse(
      envelope("memory.skill_writer.failed", {
        jobId: "skjob_1",
        scope: "global",
        operation: "create",
        skillName: "memory-review",
        error: {
          code: "skill_writer_failed",
          message: "failed",
        },
      }),
    ),
    memorySoulConfirmationRequestedEventSchema.safeParse(
      envelope("memory.soul.confirmation.requested", {
        jobId: "memjob_1",
        actionId: "memact_1",
        confirmationId: "memconf_1",
        document: "identity",
        prompt: "You are about to make changes to the soul. Are you sure?",
      }),
    ),
    memorySoulConfirmationResolvedEventSchema.safeParse(
      envelope("memory.soul.confirmation.resolved", {
        jobId: "memjob_1",
        actionId: "memact_1",
        confirmationId: "memconf_1",
        document: "identity",
        decision: "yes",
      }),
    ),
    memorySoulUpdatedEventSchema.safeParse(
      envelope("memory.soul.updated", {
        jobId: "memjob_1",
        actionId: "memact_1",
        confirmationId: "memconf_1",
        document: "identity",
        path: "/tmp/identity.md",
        notificationId: "note_1",
      }),
    ),
    notificationCreatedEventSchema.safeParse(
      envelope("notification.created", {
        notification: {
          id: "note_1",
          projectId: project.id,
          type: "memory.soul.updated",
          title: "Socrates soul updated",
          severity: "info",
          createdAt: timestamp,
        },
      }),
    ),
    notificationReadEventSchema.safeParse(envelope("notification.read", { notificationId: "note_1", unreadCount: 0 })),
    messageCompletedEventSchema.safeParse(
      envelope("message.completed", {
        message: assistantMessage,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 10,
          totalTokens: 130,
        },
      }),
    ),
    turnCompletedEventSchema.safeParse(
      envelope("turn.completed", {
        turnId: "turn_1",
        assistantMessageId: "msg_assistant_1",
        summary: "Answered the user",
      }),
    ),
    turnFailedEventSchema.safeParse(
      envelope("turn.failed", {
        turnId: "turn_1",
        error: {
          code: "turn_failed",
          message: "Turn failed",
        },
      }),
    ),
    turnCancelledEventSchema.safeParse(
      envelope("turn.cancelled", {
        turnId: "turn_1",
        reason: "User stopped the run",
      }),
    ),
    serverEventSchema.safeParse(
      envelope("terminal.started", {
        terminalId: "term_1",
        name: "frontend",
        command: "pnpm dev",
        cwd: "/tmp/socrates",
        workspacePath: "/tmp/socrates",
        status: "running",
        platform: "darwin",
        shellKind: "posix",
        shellExecutable: "/bin/zsh",
        processId: "proc_1",
        autoDetached: false,
        awaitingInput: false,
        nextOutputSequence: 0,
        startedAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
    serverEventSchema.safeParse(
      envelope("terminal.data", {
        terminalId: "term_1",
        name: "frontend",
        command: "pnpm dev",
        cwd: "/tmp/socrates",
        workspacePath: "/tmp/socrates",
        status: "running",
        stream: "pty",
        text: "ready\n",
        sequence: 0,
        autoDetached: false,
        awaitingInput: false,
        nextOutputSequence: 1,
        startedAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
    serverEventSchema.safeParse(
      envelope("terminal.input.requested", {
        terminalId: "term_1",
        name: "scaffold",
        command: "npx create-example",
        cwd: "/tmp/socrates",
        workspacePath: "/tmp/socrates",
        status: "awaiting_input",
        prompt: "Continue?",
        secret: false,
        autoDetached: false,
        awaitingInput: true,
        lastPrompt: "Continue?",
        nextOutputSequence: 2,
        startedAt: timestamp,
        updatedAt: timestamp,
      }),
    ),
    errorCreatedEventSchema.safeParse(
      envelope("error.created", {
        error: {
          code: "provider_error",
          message: "Provider failed",
        },
        recoverable: true,
      }),
    ),
  ]

  it("parses every V1 server event", () => {
    expect(serverEvents.every((result) => result.success)).toBe(true)
  })

  it("rejects unknown event types and malformed payloads", () => {
    expect(serverEventSchema.safeParse(envelope("planner.future", {})).success).toBe(false)
    expect(serverEventSchema.safeParse(envelope("tool.call.started", { toolCallId: "tcall_1" })).success).toBe(false)
  })
})

describe("context compaction contracts", () => {
  it("validates strict section schemas and turn-numbered anchors", () => {
    const chat = {
      schemaVersion: 1,
      goal: "Continue implementation.",
      constraints: ["Follow repo rules."],
      done: ["Added schemas."],
      inProgress: [],
      blocked: [],
      decisions: ["Use structured output."],
      nextSteps: ["Run tests."],
      criticalContext: [],
      relevantFiles: ["packages/core/src/context/contextCompression.ts"],
      toolState: [],
      anchors: ["Turn 12: inspect the compressor decision."],
    }
    const memory = {
      schemaVersion: 1,
      goal: "Update global memory.",
      manifestScope: ["Included turns 10-12."],
      investigated: ["Checked manifest entries."],
      changed: [],
      skipped: [],
      blocked: [],
      decisions: [],
      nextSteps: [],
      criticalContext: [],
      toolState: [],
      anchors: ["Turn 10: inspect memory evidence."],
    }

    expect(chatCompactionSchema.safeParse(chat).success).toBe(true)
    expect(memoryCompactionSchema.safeParse(memory).success).toBe(true)
    expect(anchorRepairSchema.safeParse({ anchors: ["Turn 3: inspect exact source."] }).success).toBe(true)
    expect(chatCompactionSchema.safeParse({ ...chat, anchors: ["inspect without turn number"] }).success).toBe(false)
    expect(anchorRepairSchema.safeParse({ anchors: ["turn 3: wrong prefix"] }).success).toBe(false)
    expect(
      chatCompactionSchema.safeParse({
        ...chat,
        decisions: [{ decision: "old shape", handles: [] }],
      }).success,
    ).toBe(false)
  })
})

describe("tool contracts", () => {
  it("parses the V1 model-visible tool inputs", () => {
    expect(readToolInputSchema.safeParse({ path: "README.md", charLimit: 20_000, tokenLimit: 6_000 }).success).toBe(true)
    expect(readToolInputSchema.safeParse({ path: "README.md", tokenLimit: 6_001 }).success).toBe(false)
    expect(searchToolInputSchema.safeParse({ mode: "text", query: "Socrates", path: "src" }).success).toBe(true)
    expect(searchToolInputSchema.safeParse({ mode: "text", query: "Socrates", maxResults: 50 }).success).toBe(true)
    expect(searchToolInputSchema.safeParse({ mode: "text", query: "Socrates", maxResults: 51 }).success).toBe(false)
    expect(soulToolInputSchema.safeParse({ operation: "read", charLimit: 20_000 }).success).toBe(true)
    expect(soulToolInputSchema.safeParse({ operation: "read_index", charLimit: 20_000 }).success).toBe(true)
    expect(soulToolInputSchema.safeParse({ operation: "read_section", sectionId: "operating_principles", charLimit: 20_000 }).success).toBe(true)
    expect(soulToolInputSchema.safeParse({ operation: "read", document: "both", charLimit: 20_000 }).success).toBe(false)
    expect(soulToolInputSchema.safeParse({ operation: "read_section" }).success).toBe(false)
    expect(soulToolInputSchema.safeParse({ operation: "patch", sectionId: "core_identity" }).success).toBe(false)
    expect(userProfileToolInputSchema.safeParse({ operation: "read", charLimit: 20_000 }).success).toBe(true)
    expect(userProfileToolInputSchema.safeParse({ operation: "read_index", charLimit: 20_000 }).success).toBe(true)
    expect(userProfileToolInputSchema.safeParse({ operation: "read_section", sectionId: "stable_preferences", charLimit: 20_000 }).success).toBe(true)
    expect(userProfileToolInputSchema.safeParse({ operation: "read_section" }).success).toBe(false)
    expect(userProfileToolInputSchema.safeParse({ operation: "edit" }).success).toBe(false)
    expect(
      userProfileToolOutputSchema.safeParse({
        operation: "read",
        path: "user_profile.md",
        content: "# User Profile",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 14 },
      }).success,
    ).toBe(true)
    expect(
      soulToolOutputSchema.safeParse({
        operation: "read",
        path: "identity.md",
        content: "# Identity",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 10 },
      }).success,
    ).toBe(true)
    expect(editToolInputSchema.safeParse({ path: "README.md", oldString: "old", newString: "new" }).success).toBe(true)
    expect(editToolInputSchema.safeParse({ path: "README.md", content: "new" }).success).toBe(true)
    expect(editToolInputSchema.safeParse({ path: "README.md", content: "new", overwrite: true }).success).toBe(true)
    expect(editToolInputSchema.safeParse({ path: "README.md", oldString: "old", newString: "new", overwrite: true }).success).toBe(false)
    expect(editToolInputSchema.safeParse({ path: "README.md", oldString: "old", newString: "new", replaceAll: true }).success).toBe(true)
    expect(editToolInputSchema.safeParse({ path: "README.md" }).success).toBe(false)
    expect(editToolModelInputSchema.safeParse({ path: "README.md", oldString: "old", newString: "new" }).success).toBe(true)
    expect(editToolModelInputSchema.safeParse({ path: "README.md", content: "new" }).success).toBe(true)
    expect(editToolModelInputSchema.safeParse({ path: "README.md", content: "new", overwrite: true }).success).toBe(true)
    expect(editToolModelInputSchema.safeParse({ path: "README.md", oldString: "old", newString: "new", overwrite: true }).success).toBe(false)
    expect(editToolModelInputSchema.safeParse({ path: "README.md", content: "new", oldString: "old", newString: "new" }).success).toBe(false)
    expect(applyPatchToolInputSchema.safeParse({ patch: "--- a/README.md\n+++ b/README.md\n" }).success).toBe(true)
    expect(applyPatchToolInputSchema.safeParse({ patchText: "*** Begin Patch\n*** End Patch" }).success).toBe(true)
    expect(applyPatchToolInputSchema.safeParse({ patch: "one", patchText: "two" }).success).toBe(false)
    expect(applyPatchToolModelInputSchema.safeParse({ patchText: "*** Begin Patch\n*** End Patch" }).success).toBe(true)
    expect(applyPatchToolModelInputSchema.safeParse({ patch: "--- a/README.md\n+++ b/README.md\n" }).success).toBe(false)
    expect(
      readToolOutputSchema.safeParse({
        path: "README.md",
        kind: "file",
        content: "hello",
        sizeBytes: 5,
        mtimeMs: 10,
        contentHash: "hash_after",
        lineEnding: "lf",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 5 },
      }).success,
    ).toBe(true)
    expect(
      editToolOutputSchema.safeParse({
        changedFiles: [
          {
            path: "README.md",
            operation: "edited",
            verification: "verified",
            contentHashBefore: "hash_before",
            contentHashAfter: "hash_after",
            sizeBytesBefore: 3,
            sizeBytesAfter: 5,
            lineDelta: 1,
          },
          {
            path: "renamed.md",
            previousPath: "old.md",
            operation: "renamed",
            verification: "verified",
          },
          {
            path: "deleted.md",
            operation: "deleted",
            verification: "verified",
          },
        ],
        diff: "--- a/README.md\n+++ b/README.md\n",
        dryRun: false,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
      }).success,
    ).toBe(true)
    expect(bashToolInputSchema.safeParse({ command: "pnpm test", timeoutMs: 120_000 }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ argv: ["git", "status", "--short"] }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ command: "pwd", argv: ["pwd"] }).success).toBe(false)
    expect(bashToolInputSchema.safeParse({ operation: "start", argv: ["git", "status"] }).success).toBe(false)
    expect(bashToolInputSchema.safeParse({ operation: "start", command: "pnpm dev" }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "start", command: "node -e 'process.stdin.resume()'", inputMode: "user" }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "status", inputMode: "user" }).success).toBe(false)
    expect(bashToolInputSchema.safeParse({ operation: "output", processId: "proc_1", outputSequence: 0 }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "status", terminalId: "term_1" }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "output" }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "stop" }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "list", limit: 12, charLimit: 12_000 }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "list", limit: 13 }).success).toBe(false)
    expect(bashToolInputSchema.safeParse({ operation: "list", charLimit: 16_001 }).success).toBe(false)
    expect(bashToolInputSchema.safeParse({ operation: "status", name: "dev-server" }).success).toBe(true)
    expect(bashToolInputSchema.safeParse({ operation: "output", target: "frontend" }).success).toBe(true)
    expect(bashToolModelInputSchema.safeParse({ operation: "stop" }).success).toBe(true)
    expect(bashToolModelInputSchema.safeParse({ argv: ["pwd"] }).success).toBe(true)
    expect(bashToolModelInputSchema.safeParse({ operation: "start", argv: ["pwd"] }).success).toBe(false)
    expect(bashToolModelInputSchema.safeParse({ operation: "stop", name: "dev-server" }).success).toBe(true)
    expect(bashToolModelInputSchema.safeParse({ operation: "stop", terminalId: "term_1" }).success).toBe(false)
    expect(bashToolModelInputSchema.safeParse({ operation: "output", processId: "proc_1" }).success).toBe(false)
    expect(bashToolModelInputSchema.safeParse({ operation: "output", outputSequence: 0 }).success).toBe(false)
    expect(waitToolInputSchema.safeParse({ terminalNames: ["tests"], wakeOn: ["completed", "failed"], reason: "Waiting for integration test results" }).success).toBe(true)
    expect(waitToolInputSchema.safeParse({ terminalNames: ["tests"], wakeOn: ["completed"], reason: "one two three four five six seven eight" }).success).toBe(false)
    expect(waitToolInputSchema.safeParse({ terminalNames: ["tests"], wakeOn: ["completed"], reason: "x".repeat(65) }).success).toBe(false)
    expect(urlFetchToolInputSchema.safeParse({ url: "https://example.com/docs", charLimit: 10_000, timeoutMs: 10_000 }).success).toBe(true)
    expect(urlFetchToolInputSchema.safeParse({ url: "ftp://example.com/file.txt" }).success).toBe(false)
    expect(
      urlFetchToolOutputSchema.safeParse({
        url: "https://example.com/docs",
        finalUrl: "https://example.com/docs",
        status: 200,
        ok: true,
        redirected: false,
        contentType: "text/html",
        sizeBytes: 120,
        text: "<title>Example</title>",
        title: "Example",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 22 },
      }).success,
    ).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", toolNames: ["read"], turnNo: 2, role: "user" }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ turnNo: 2, role: "user", scope: "project" }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ scope: "all_projects", projectTitle: ["Socrates", "AI DPA"], conversationTitle: ["Memory agent", "Trace retrieval"], query: "selector precedence" }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ scope: "recent_conversations", conversationLimit: 3, perConversationLimit: 5 }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ mode: "semantic", scope: "project" }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ mode: "combined", conversationLimit: 3 }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", role: "user" }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", entryType: "assistant_response", hasAttachment: false }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ operation: "inspect", resultNumber: 1 }).success).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ operation: "inspect", query: "README", role: "assistant" }).success).toBe(true)
    expect(
      traceRetrieveToolInputSchema.safeParse({ operation: "inspect", handle: "tdoc_1", startTurnNo: 2, turnLimit: 5 }).success,
    ).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", resultNumber: 1 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", query: "README", role: "assistant" }).success).toBe(true)
    expect(
      traceRetrieveToolModelInputSchema.safeParse({ query: "previous screenshots", command: "", paths: [], include: [], createdAfter: "" }).success,
    ).toBe(true)
    expect(
      traceRetrieveToolModelInputSchema.safeParse({ query: "previous screenshots", messageId: "msg_1", conversationId: "conv_1", mode: "exact" })
        .success,
    ).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ messageId: "msg_1" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ mode: "audit", toolId: "tcall_1" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ toolId: "tcall_1" }).success).toBe(false)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "exact", conversationTitle: "apply patch fix", conversationLimit: 10 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "exact", scope: "all_projects", projectTitle: ["Socrates"], conversationId: ["conv_1", "conv_2"] }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "exact", conversationId: "conv_1" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ mode: "exact", conversationLimit: 3, conversationOffset: 1, perConversationLimit: 5, updatedAfter: timestamp, updatedBefore: timestamp }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "exact", turnNo: 2 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ turnNo: 2, role: "assistant", conversationTitle: "apply patch fix" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "exact", role: "assistant", entryType: "assistant_response", hasAttachment: true, createdAfter: timestamp, createdBefore: timestamp }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "semantic" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "semantic", scope: "project", conversationTitle: "Trace source", conversationId: "conv_1", role: "user", entryType: "user_query", hasAttachment: false, createdAfter: timestamp, createdBefore: timestamp, limit: 10 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "semantic", conversationLimit: 50 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "semantic", turnNo: 2 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "semantic", charLimit: 1000 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "combined" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "combined", scope: "project", limit: 10 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "combined", conversationLimit: 50 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "exact", include: ["messages"] }).success).toBe(false)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "combined", paths: ["README.md"] }).success).toBe(false)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "semantic", command: "npm test" }).success).toBe(false)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "audit", include: ["tool_calls"] }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ query: "README", mode: "audit", paths: ["README.md"], command: "npm test" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", handle: "tdoc_1" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", messageId: "msg_1" }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", messageId: "msg_1", command: "npm test" }).success).toBe(false)
    expect(
      traceRetrieveToolModelInputSchema.safeParse({
        operation: "inspect",
        messageId: "msg_1",
        scope: "project",
        mode: "exact",
        conversationLimit: 10,
      }).success,
    ).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", conversationId: "conv_1", startTurnNo: 2 }).success).toBe(true)
    expect(traceRetrieveToolModelInputSchema.safeParse({ operation: "inspect", startTurnNo: 2 }).success).toBe(false)
    expect(traceRetrieveGlobalToolInputSchema.safeParse({ query: "slow mode", mode: "lexical", scope: "all_projects" }).success).toBe(true)
    expect(traceRetrieveGlobalToolInputSchema.safeParse({ query: "how does slow mode work", mode: "semantic", projectTitle: ["Socrates", "AI DPA"] }).success).toBe(true)
    expect(traceRetrieveGlobalToolInputSchema.safeParse({ query: "slow mode", mode: "combined", projectId: "project_1", conversationId: "conv_1" }).success).toBe(true)
    expect(traceRetrieveGlobalToolInputSchema.safeParse({ query: "npm test", mode: "audit", include: ["shell", "errors"] }).success).toBe(true)
    expect(traceRetrieveGlobalToolInputSchema.safeParse({ operation: "inspect", resultNumber: 1 }).success).toBe(true)
    expect(traceRetrieveGlobalToolInputSchema.safeParse({ operation: "inspect", projectTitle: "Socrates", conversationTitle: "Memory", turnNo: 2 }).success).toBe(true)
    expect(traceRetrieveGlobalToolInputSchema.safeParse({ query: "x".repeat(129), mode: "lexical" }).success).toBe(false)
    expect(traceRetrieveGlobalToolInputSchema.safeParse({ query: "slow mode", mode: "exact" }).success).toBe(false)
    expect(traceRetrieveGlobalToolInputSchema.safeParse({ query: "slow mode", handle: "tdoc_1" }).success).toBe(false)
    expect(traceRetrieveGlobalToolOutputSchema.safeParse({
      results: [{
        resultNumber: 1,
        content: "User:\nUse slow mode.",
        turnId: "turn_1",
        projectTitle: "Socrates",
        conversationTitle: "Memory",
        turnNumber: 2,
        matchedRole: "user",
        status: "complete",
        occurredAt: timestamp,
      }],
      totalMatches: 1,
    }).success).toBe(true)
    expect(mcpRegistryToolModelInputSchema.safeParse({ operation: "list", n: 15 }).success).toBe(true)
    expect(mcpRegistryToolModelInputSchema.safeParse({ operation: "list", id: "playwright" }).success).toBe(false)
    expect(mcpRegistryToolInputSchema.safeParse({ operation: "list", id: "playwright" }).success).toBe(true)
    expect(mcpRegistryToolModelInputSchema.safeParse({ operation: "describe", id: "playwright" }).success).toBe(true)
    expect(mcpRegistryToolModelInputSchema.safeParse({ operation: "check", serverName: "playwright" }).success).toBe(false)
    expect(mcpRegistryToolModelInputSchema.safeParse({ operation: "check", id: "playwright" }).success).toBe(true)
    expect(mcpRegistryToolModelInputSchema.safeParse({ operation: "configure", scope: "project", server: { id: "time", command: "uvx", args: ["mcp-server-time"] } }).success).toBe(true)
    expect(mcpRegistryToolModelInputSchema.safeParse({ operation: "configure", server: { id: "time" } }).success).toBe(false)
    expect(mcpRegistryToolModelInputSchema.safeParse({ operation: "delete", scope: "global", id: "time" }).success).toBe(true)
    expect(mcpRegistryToolModelInputSchema.safeParse({ operation: "describe" }).success).toBe(false)
    expect(
      mcpRegistryToolOutputSchema.safeParse({
        operation: "list",
        configPath: "/tmp/mcp.json",
        envPath: "/tmp/.env",
        servers: [
          {
            id: "playwright",
            name: "Playwright MCP",
            label: "Playwright MCP",
            configured: true,
            enabled: true,
            requiresSecrets: false,
            status: "unknown",
          },
        ],
        summary: "Found 1 configured MCP server.",
        usageHint: "Prefer describe by exact-listed-id.",
      }).success,
    ).toBe(true)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", turnNo: 0 }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ query: "README", role: "system" }).success).toBe(false)
    expect(traceRetrieveToolInputSchema.safeParse({ turnId: "turn_1" }).success).toBe(false)
    expect(
      traceRetrieveToolOutputSchema.safeParse({
        results: [
          {
            resultNumber: 1,
            text: "README context",
            entryType: "user_query",
            conversationTitle: "Trace source",
            conversationId: conversation.id,
            messageId: "msg_1",
            messageNo: 2,
            provenanceKind: "original_turn",
            pairedUserMessageNo: 2,
            pairedUserPreview: "Question",
          },
          {
            resultNumber: 2,
            entryType: "qa_pair",
            conversationTitle: "Trace source",
            conversationId: conversation.id,
            turnNo: 2,
            turnId: "turn_1",
            userMessageId: "msg_user_1",
            assistantMessageId: "msg_assistant_1",
            userText: "Question",
            assistantText: "Answer",
            startedAt: timestamp,
          },
          {
            resultNumber: 3,
            entryType: "user_query",
            content: "Exact source",
            conversationTitle: "Trace source",
            conversationId: conversation.id,
            messageId: "msg_1",
            messageNo: 2,
            provenanceKind: "original_turn",
          },
        ],
        totalMatches: 3,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 200 },
        appliedFilters: { operation: "search", scope: "current_conversation", mode: "combined", turnNo: 2, role: "user" },
        warnings: ["Semantic trace retrieval is not configured for this project. Use the project dashboard to enable semantic search."],
      }).success,
    ).toBe(true)
    expect(toolDocsToolInputSchema.safeParse({ operation: "search", area: "tool_usage", query: "trace", searchMode: "keyword_all" }).success).toBe(true)
    expect(toolDocsToolInputSchema.safeParse({ operation: "read", area: "tool_usage", path: "trace_retrieve.md", charLimit: 1000 }).success).toBe(true)
    expect(toolDocsToolInputSchema.safeParse({ operation: "search", area: "useful_patterns", query: "terminal", searchMode: "keyword_any", includeSections: true }).success).toBe(false)
    expect(toolDocsToolInputSchema.safeParse({ operation: "search", searchMode: "regex" }).success).toBe(false)
    expect(
      toolDocsToolOutputSchema.safeParse({
        operation: "search",
        area: "tool_usage",
        results: [
          {
            resultNumber: 1,
            resultType: "line_match",
            path: "tool_usage/trace_retrieve.md",
            matchedText: "trace",
            modifiedAt: timestamp,
            lineStart: 1,
            lineEnd: 1,
          },
        ],
        totalMatches: 1,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 100 },
      }).success,
    ).toBe(true)
    expect(skillsToolInputSchema.safeParse({ operation: "list", scope: "project" }).success).toBe(true)
    expect(skillsToolInputSchema.safeParse({ operation: "list", id: "memory-review" }).success).toBe(true)
    expect(skillsToolInputSchema.safeParse({ operation: "search", query: "memory" }).success).toBe(true)
    expect(skillsToolInputSchema.safeParse({ operation: "read", name: "memory-review", path: "SKILL.md" }).success).toBe(true)
    expect(skillsToolInputSchema.safeParse({ operation: "read" }).success).toBe(false)
    expect(skillsToolModelInputSchema.safeParse({ operation: "list", n: 15 }).success).toBe(true)
    expect(skillsToolModelInputSchema.safeParse({ operation: "list", id: "memory-review" }).success).toBe(false)
    expect(skillsToolModelInputSchema.safeParse({ operation: "describe", id: "memory-review" }).success).toBe(true)
    expect(skillsToolModelInputSchema.safeParse({ operation: "read", id: "global:memory-review", path: "references/checklist.md" }).success).toBe(true)
    expect(skillsToolModelInputSchema.safeParse({ operation: "read", id: "global:memory-review" }).success).toBe(false)
    expect(skillsToolModelInputSchema.safeParse({ operation: "preview_import", url: "https://example.com/memory-review.zip" }).success).toBe(true)
    expect(skillsToolModelInputSchema.safeParse({ operation: "preview_import", attachmentPath: ".socrates/attachments/memory-review.zip" }).success).toBe(true)
    expect(skillsToolModelInputSchema.safeParse({ operation: "preview_import", url: "https://example.com/memory-review.zip", attachmentPath: ".socrates/attachments/memory-review.zip" }).success).toBe(false)
    expect(skillsToolModelInputSchema.safeParse({ operation: "preview_import", url: "http://example.com/memory-review.zip" }).success).toBe(false)
    expect(skillsToolModelInputSchema.safeParse({ operation: "preview_import", scope: "builtin", url: "https://example.com/memory-review.zip" }).success).toBe(false)
    expect(skillsToolModelInputSchema.safeParse({ operation: "commit_import", scope: "global", previewId: `skillimp_${"a".repeat(32)}` }).success).toBe(true)
    expect(skillsToolModelInputSchema.safeParse({ operation: "commit_import", previewId: "skillimp_short" }).success).toBe(false)
    expect(skillsToolModelInputSchema.safeParse({ operation: "search", query: "memory" }).success).toBe(false)
    expect(skillsToolModelInputSchema.safeParse({ operation: "describe" }).success).toBe(false)
    expect(skillsToolOutputSchema.safeParse({ operation: "list", skills: [skill], totalMatches: 1, truncation: { truncated: false, charLimit: 20_000, returnedLength: 200 } }).success).toBe(true)
    expect(
      skillsToolOutputSchema.safeParse({
        operation: "preview_import",
        skills: [{ ...skill, scope: "project", source: "imported" }],
        importPreview: {
          previewId: `skillimp_${"a".repeat(32)}`,
          scope: "project",
          skill: { ...skill, scope: "project", source: "imported" },
          package: { filename: "memory-review.zip", fileCount: 1, totalBytes: 500, sha256: "b".repeat(64), files: ["memory-review/SKILL.md"], filesTruncated: false },
          metadata: {},
          conflict: { exists: false },
          warnings: [],
          warningsTruncated: false,
          expiresAt: timestamp,
        },
        totalMatches: 1,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 500 },
      }).success,
    ).toBe(true)
    expect(memoryNoteToolInputSchema.safeParse({ note: "User gave a strong testing preference in this turn.", importance: "high" }).success).toBe(true)
    expect(memoryNoteToolInputSchema.safeParse({ note: "User gave a strong testing preference in this turn.", intent: "profile_preference", priority: "high" }).success).toBe(false)
    expect(memoryNoteToolOutputSchema.safeParse({ noteNumber: 1, status: "open", attachedSource: "current_user_message", result: "created" }).success).toBe(true)
    expect(memoryNoteToolOutputSchema.safeParse({ noteNumber: 1, status: "done", attachedSource: "current_user_message", result: "already_recorded" }).success).toBe(true)
    expect(memoryNotesToolInputSchema.safeParse({ operation: "list", limit: 10 }).success).toBe(true)
    expect(memoryNotesToolInputSchema.safeParse({ operation: "list", limit: 11 }).success).toBe(false)
    expect(memoryNotesToolInputSchema.safeParse({ operation: "read", noteNumber: 1 }).success).toBe(true)
    expect(memoryNotesToolInputSchema.safeParse({ operation: "mark_done" }).success).toBe(false)
    expect(memoryNotesToolInputSchema.safeParse({ operation: "mark_done", noteNumber: 1 }).success).toBe(false)
    expect(memoryNotesToolInputSchema.safeParse({ operation: "mark_done", noteNumber: 1, outcome: "applied" }).success).toBe(false)
    expect(memoryNotesToolInputSchema.safeParse({ operation: "mark_done", noteNumber: 1, outcome: "applied", resolution: "classified to user_profile.active_context" }).success).toBe(true)
    expect(memoryNotesToolInputSchema.safeParse({ operation: "list", outcome: "skipped" }).success).toBe(false)
    expect(
      memoryNotesToolOutputSchema.safeParse({
        operation: "read",
        notes: [
          {
            noteNumber: 1,
            status: "processing",
            importance: "normal",
            note: "This turn has a reusable workflow.",
            projectId: project.id,
            projectName: "Memory Project",
            defaultSkillScope: "project",
            workspacePath: "/tmp/memory-project",
            conversationId: conversation.id,
            turnId: "turn_1",
            messageId: "msg_1",
            outcome: "applied",
            resolution: "classified to user_profile.active_context",
            createdAt: timestamp,
          },
        ],
        totalMatches: 1,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 200 },
      }).success,
    ).toBe(true)
    expect(workerModelSettingsParamsSchema.safeParse({ workerId: "skill_writer" }).success).toBe(true)
    expect(workerModelSettingsParamsSchema.safeParse({ workerId: "memory_router" }).success).toBe(true)
    expect(workerModelSettingsParamsSchema.safeParse({ workerId: "unknown" }).success).toBe(false)
    expect(
      updateWorkerModelSettingsRequestSchema.safeParse({
        providerId: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        thinkingEnabled: false,
      }).success,
    ).toBe(true)
    const workerSetting = {
      workerId: "skill_writer",
      providerId: "openrouter",
      modelId: "xiaomi/mimo-v2.5-pro",
      thinkingEnabled: false,
      updatedAt: timestamp,
    }
    expect(listWorkerModelSettingsResponseSchema.safeParse({ settings: [workerSetting] }).success).toBe(true)
    expect(updateWorkerModelSettingsResponseSchema.safeParse({ settings: workerSetting }).success).toBe(true)
    expect(
      skillWriteToolInputSchema.safeParse({
        scope: "global",
        operation: "create",
        name: "memory-review",
        content: "---\nname: memory-review\ndescription: Use when reviewing memory.\n---\n\n# Memory Review\n",
        changeSummary: "Create the approved memory review workflow.",
      }).success,
    ).toBe(true)
    expect(skillWriteToolInputSchema.safeParse({ scope: "builtin", operation: "create", name: "memory-review", content: "# bad" }).success).toBe(false)
    expect(
      skillWriteToolOutputSchema.safeParse({
        scope: "global",
        operation: "create",
        name: "memory-review",
        path: "skills/memory-review/SKILL.md",
        changed: true,
        changedFiles: ["skills/memory-review/SKILL.md"],
        summary: skill,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 200 },
      }).success,
    ).toBe(true)
    expect(projectDocsToolInputSchema.safeParse({ operation: "read", area: "memory" }).success).toBe(true)
    expect(projectDocsToolInputSchema.safeParse({ operation: "search", area: "notes", query: "decision" }).success).toBe(true)
    expect(projectDocsToolInputSchema.safeParse({ operation: "edit", area: "notes", editMode: "append", text: "- note" }).success).toBe(true)
    expect(projectDocsToolInputSchema.safeParse({ operation: "edit", area: "memory", editMode: "replace", oldText: "old", newText: "new" }).success).toBe(true)
    expect(projectDocsToolInputSchema.safeParse({ operation: "edit", area: "notes", editMode: "replace", oldText: "old" }).success).toBe(false)
    expect(projectDocsToolInputSchema.safeParse({ operation: "read_index", area: "memory" }).success).toBe(true)
    expect(projectDocsToolInputSchema.safeParse({ operation: "read_section", area: "memory", sectionId: "handoff" }).success).toBe(true)
    expect(projectDocsToolInputSchema.safeParse({ operation: "patch_section", area: "memory", sectionId: "handoff", oldText: "old", newText: "new" }).success).toBe(true)
    expect(projectDocsToolInputSchema.safeParse({ operation: "patch_section", area: "memory", oldText: "old", newText: "new" }).success).toBe(false)
    expect(projectDocsToolModelInputSchema.safeParse({ operation: "read_index", area: "notes" }).success).toBe(true)
    expect(projectDocsToolModelInputSchema.safeParse({ operation: "edit", area: "notes", editMode: "append", text: "- note" }).success).toBe(true)
    expect(projectDocsToolModelInputSchema.safeParse({ operation: "edit", area: "memory", editMode: "replace", oldText: "old", newText: "new" }).success).toBe(true)
    expect(projectDocsToolModelInputSchema.safeParse({ operation: "patch_section", area: "memory", sectionId: "handoff", oldText: "old", newText: "new" }).success).toBe(true)
    expect(projectDocsToolModelInputSchema.safeParse({ operation: "patch_section", area: "memory", sectionId: "handoff", text: "new" }).success).toBe(false)
    expect(projectDocsToolModelInputSchema.safeParse({ operation: "edit", area: "notes", editMode: "append", oldText: "old", newText: "new" }).success).toBe(false)
    expect(currentTimeToolInputSchema.safeParse({}).success).toBe(true)
    expect(currentTimeToolOutputSchema.safeParse({ currentDate: "2026-06-19", currentDateTime: timestamp, timeZone: "Europe/Vienna", source: "system" }).success).toBe(true)
    expect(editFilesToolInputSchema.safeParse({ target: "user_profile", editMode: "replace", oldText: "old", newText: "new" }).success).toBe(true)
    expect(editFilesToolInputSchema.safeParse({ target: "user_profile", editMode: "replace", sectionId: "stable_preferences", oldText: "old", newText: "new" }).success).toBe(true)
    expect(
      editFilesToolInputSchema.safeParse({
        target: "user_profile",
        editMode: "move",
        sourceSectionId: "collaboration_style",
        destinationSectionId: "global_always_apply_rules",
        sourceText: "- Hard rule in the wrong section.",
        destinationText: "- Hard rule in its canonical section.",
        rationale: "Explicit cross-project evidence makes the classification clear.",
      }).success,
    ).toBe(true)
    expect(
      editFilesToolInputSchema.safeParse({
        target: "user_profile",
        editMode: "move",
        sourceSectionId: "collaboration_style",
        destinationSectionId: "collaboration_style",
        sourceText: "- Same section.",
        destinationText: "- Same section.",
        rationale: "Invalid same-section move.",
      }).success,
    ).toBe(false)
    expect(editFilesToolInputSchema.safeParse({ target: "operating_principles", editMode: "replace", oldText: "old", newText: "new" }).success).toBe(false)
    expect(repoDocsToolInputSchema.safeParse({ operation: "read" }).success).toBe(true)
    expect(repoDocsToolInputSchema.safeParse({ operation: "read", path: "REPO_RULES.md" }).success).toBe(true)
    expect(repoDocsToolInputSchema.safeParse({ operation: "search", query: "contract", path: "CONTRACTS.md" }).success).toBe(true)
    expect(repoDocsToolInputSchema.safeParse({ operation: "edit", path: "CORE_IDEA.md", oldText: "old", newText: "new" }).success).toBe(true)
    expect(repoDocsToolInputSchema.safeParse({ operation: "read_index" }).success).toBe(true)
    expect(repoDocsToolInputSchema.safeParse({ operation: "read_section", path: "REPO_RULES.md", sectionId: "hard_rules" }).success).toBe(true)
    expect(repoDocsToolInputSchema.safeParse({ operation: "patch_section", path: "REPO_RULES.md", sectionId: "hard_rules", oldText: "old", newText: "new" }).success).toBe(true)
    expect(repoDocsToolInputSchema.safeParse({ operation: "patch_section", sectionId: "hard_rules", oldText: "old", newText: "new" }).success).toBe(false)
    expect(repoDocsToolInputSchema.safeParse({ operation: "edit", oldText: "old", newText: "new" }).success).toBe(false)
    expect(repoDocsToolInputSchema.safeParse({ operation: "read", path: "../README.md" }).success).toBe(false)
    expect(repoDocsToolModelInputSchema.safeParse({ operation: "read_index", path: "REPO_RULES.md" }).success).toBe(true)
    expect(repoDocsToolModelInputSchema.safeParse({ operation: "edit", path: "CORE_IDEA.md", oldText: "old", newText: "new" }).success).toBe(true)
    expect(repoDocsToolModelInputSchema.safeParse({ operation: "patch_section", path: "REPO_RULES.md", sectionId: "hard_rules", oldText: "old", newText: "new" }).success).toBe(true)
    expect(repoDocsToolModelInputSchema.safeParse({ operation: "patch_section", path: "REPO_RULES.md", sectionId: "hard_rules", text: "new" }).success).toBe(false)
    expect(repoDocsToolModelInputSchema.safeParse({ operation: "read_section", sectionId: "hard_rules" }).success).toBe(false)
    expect(
      repoDocsToolOutputSchema.safeParse({
        operation: "search",
        paths: [".socrates/repo_docs/REPO_RULES.md"],
        matches: [{ path: ".socrates/repo_docs/REPO_RULES.md", line: 1, text: "# Repo Rules" }],
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 30 },
      }).success,
    ).toBe(true)
    expect(
      projectDocsToolOutputSchema.safeParse({
        operation: "edit",
        area: "notes",
        path: ".socrates/PROJECT_NOTES.md",
        changed: true,
        content: "# PROJECT_NOTES",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 15 },
      }).success,
    ).toBe(true)
    expect(projectsToolInputSchema.safeParse({ operation: "list_projects", limit: 10 }).success).toBe(true)
    expect(projectsToolInputSchema.safeParse({ operation: "list_conversations", projectId: project.id }).success).toBe(true)
    expect(projectsToolInputSchema.safeParse({ operation: "list_conversations" }).success).toBe(false)
    expect(
      projectsToolOutputSchema.safeParse({
        operation: "list_projects",
        projects: [
          {
            id: project.id,
            name: project.name,
            status: project.status,
            updatedAt: timestamp,
            conversationCount: 2,
            resourceCount: 1,
          },
        ],
        totalMatches: 1,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 100 },
      }).success,
    ).toBe(true)
    expect(
      projectsToolOutputSchema.safeParse({
        operation: "list_conversations",
        conversations: [
          {
            id: conversation.id,
            projectId: project.id,
            title: conversation.title,
            status: conversation.status,
            updatedAt: timestamp,
            turnCount: 3,
          },
        ],
        totalMatches: 1,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 100 },
      }).success,
    ).toBe(true)
    expect(editFilesToolInputSchema.safeParse({ target: "tool_doc", name: "read_search", editMode: "replace", oldText: "old", newText: "new" }).success).toBe(false)
    expect(
      editFilesToolInputSchema.safeParse({
        target: "skill",
        name: "general",
        editMode: "create",
        newText: "---\nname: general\ndescription: Useful global Socrates patterns.\n---\n# General\n",
        rationale: "Repeated workflow across two inspected turns.",
        sourceTurnIds: ["turn-1"],
      }).success,
    ).toBe(true)
    expect(editFilesToolInputSchema.safeParse({ target: "skill", editMode: "create", newText: "# Missing name\n" }).success).toBe(false)
    expect(editFilesToolInputSchema.safeParse({ target: "skill", name: "general", editMode: "replace", sectionId: "workflow", oldText: "old", newText: "new" }).success).toBe(false)
    expect(
      editFilesToolOutputSchema.safeParse({
        target: "skill",
        name: "general",
        path: "skills/general/SKILL.md",
        changed: false,
        status: "proposed",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 20 },
      }).success,
    ).toBe(true)
    expect(listProjectResourcesToolInputSchema.safeParse({ kind: "pdf", limit: 10 }).success).toBe(true)
    expect(listProjectResourcesToolInputSchema.safeParse({ source: "uploaded" }).success).toBe(false)
    expect(
      listProjectResourcesToolOutputSchema.safeParse({
        resources: [
          {
            id: resource.id,
            name: resource.name,
            kind: resource.kind,
            source: resource.source,
            uri: resource.uri,
            mimeType: resource.mimeType,
            sizeBytes: resource.sizeBytes,
            status: resource.status,
          },
        ],
        summary: "Listed 1 project resources.",
        totalResources: 1,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 100 },
      }).success,
    ).toBe(true)
  })

  it("rejects tools outside the V1 surface", () => {
    expect(normalizedToolCallSchema.safeParse({ toolCallId: "tcall_1", toolName: "glob", input: {} }).success).toBe(false)
    expect(
      normalizedToolCallSchema.safeParse({
        toolCallId: "tcall_1",
        toolName: "read",
        input: { path: "README.md" },
        providerMetadata: { google: { thoughtSignature: "sig_1" } },
      }).success,
    ).toBe(true)
    expect(normalizedToolCallSchema.safeParse({ toolCallId: "tcall_2", toolName: "current_time", input: {} }).success).toBe(true)
    expect(
      toolExecutionResultSchema.safeParse({
        toolCallId: "tcall_1",
        toolName: "read",
        ok: false,
        error: { code: "tool_failed", message: "Tool failed" },
      }).success,
    ).toBe(true)
  })

  it("validates the clean project trace and exact memory-routing contracts", () => {
    expect(traceRetrieveMainToolInputSchema.safeParse({ mode: "lexical", query: "slow mode" }).success).toBe(true)
    expect(traceRetrieveMainToolInputSchema.safeParse({ mode: "lexical", query: "x".repeat(129) }).success).toBe(false)
    expect(traceRetrieveMainToolInputSchema.safeParse({ mode: "semantic", query: "what we know about slow mode" }).success).toBe(true)
    expect(traceRetrieveMainToolInputSchema.safeParse({ mode: "semantic", query: "x".repeat(1_001) }).success).toBe(false)
    expect(traceRetrieveMainToolInputSchema.safeParse({ mode: "lexical", query: "slow mode", projectId: "proj_1" }).success).toBe(false)
    expect(
      traceRetrieveMainToolOutputSchema.safeParse({
        results: [{ resultNumber: 1, content: "Use slow mode.", turnId: "turn_1", conversationTitle: "Planning", turnNumber: 2, matchedRole: "user", status: "complete", occurredAt: timestamp }],
        totalMatches: 1,
      }).success,
    ).toBe(true)
    expect(
      memoryRouterPreTurnResultSchema.safeParse({
        readTargets: [{ surface: "user_profile", fileName: "user_profile.md", sectionId: "collaboration_style", reason: "Slow mode is a collaboration preference." }],
        reason: "Read the precise preference and preserve the contract.",
      }).success,
    ).toBe(true)
    expect(
      memoryRouterPreTurnResultSchema.safeParse({
        readTargets: [{ surface: "identity", fileName: "user_profile.md", sectionId: "collaboration_style", reason: "wrong owner" }],
        reason: "invalid",
      }).success,
    ).toBe(false)
    expect(memoryRouterPreTurnResultSchema.safeParse({ readTargets: [], memoryWrites: [], reason: "writes are forbidden" }).success).toBe(false)
    expect(
      memoryRouterPostTurnResultSchema.safeParse({
        actions: [{ operation: "replace", surface: "repo_docs", fileName: "CONTRACTS.md", sectionId: "tool_contracts", instruction: "Replace the stale contract.", reason: "Verified runtime evidence supersedes it.", evidenceReferences: ["evd_abc123"], capabilityId: "terminal.interactive_input", verifiedRuntime: "bash start accepts user PTY input", verifiedAt: "2026-07-12T10:00:00.000Z" }],
        reason: "One stale capability claim requires reconciliation.",
      }).success,
    ).toBe(true)
    expect(
      memoryRouterPostTurnResultSchema.safeParse({
        actions: [{ operation: "replace", surface: "project_notes", fileName: "PROJECT_NOTES.md", sectionId: "state_ledger", instruction: "Rewrite backend state.", reason: "stale", evidenceReferences: [] }],
        reason: "invalid backend-owned target",
      }).success,
    ).toBe(false)
    expect(turnEvidenceToolInputSchema.safeParse({ operation: "inspect", limit: 21, charLimit: 8_000 }).success).toBe(false)
    expect(turnEvidenceToolInputSchema.safeParse({ operation: "inspect", reference: "evd_abc123", limit: 10, charLimit: 8_000 }).success).toBe(true)
    expect(
      memorySearchOutputSchema.safeParse({
        results: [{ resultNumber: 1, content: "Slow Mode", surface: "user_profile", fileName: "user_profile.md", sectionId: "collaboration_style", sectionHeading: "Collaboration Style", scope: "global" }],
        totalMatches: 1,
      }).success,
    ).toBe(true)
  })
})
