import type {
  CompleteCompactionSnapshotInput,
  ContextCompactionSummary,
  FailCompactionSnapshotInput,
  StartCompactionSnapshotInput,
} from "@socrates/core"
import { normalizeScores, rankDistinctParents } from "@socrates/core"
import type {
  ChatMessageSendPayload,
  CompleteOnboardingRequest,
  Conversation,
  ConversationActivityStep,
  ConversationContextUsage,
  ConversationCostUsage,
  ConversationPartialTurn,
  ConversationTerminal,
  ConversationTokenUsage,
  ConversationToolRun,
  CreateConversationMessageRequest,
  CreateConversationRequest,
  CreateProjectRequest,
  CreateProjectResourceRequest,
  CheckProjectEmbeddingsRequest,
  ConfigureProjectEmbeddingsRequest,
  FeedbackSubmitPayload,
  ListOllamaEmbeddingModelsQuery,
  ListNotificationsResponse,
  MarkAllNotificationsReadResponse,
  MarkNotificationReadResponse,
  Message,
  MessageAttachment,
  PatchProjectRequest,
  InspectWorkspaceRequest,
  InspectWorkspaceResponse,
  PickWorkspaceFolderRequest,
  PickWorkspaceFolderResponse,
  ProjectDocsToolInput,
  ProjectDocsToolOutput,
  RepoDocsToolInput,
  RepoDocsToolOutput,
  RuntimeConfig,
  Project,
  ProjectInstructions,
  GetMemoryAgentResponse,
  GetMemoryAgentRunResponse,
  GetMemoryAgentFileContentResponse,
  TriggerMemoryAgentRunResponse,
  ListMemoryAgentFilesResponse,
  ListMemoryAgentRunsResponse,
  ListModelsResponse,
  UpdateMemoryAgentGlobalSettingsRequest,
  UpdateMemoryAgentGlobalSettingsResponse,
  UpdateWorkerModelSettingsRequest,
  UpdateWorkerModelSettingsResponse,
  MemoryAgentFileContentQuery,
  MemoryNoteToolInput,
  MemoryNoteToolOutput,
  MemoryDocIndex,
  MemorySearchInput,
  MemoryNotesToolInput,
  MemoryNotesToolOutput,
  ApproveMemorySkillProposalResponse,
  RejectMemorySkillProposalResponse,
  ProjectResource,
  ProjectWorkspace,
  BuildProjectSkillRequest,
  BuildProjectSkillResponse,
  BuildGlobalSkillRequest,
  BuildGlobalSkillResponse,
  DeleteSkillResponse,
  SkillImportPreview,
  CommitSkillImportResponse,
  SkillsToolInput,
  SkillsToolOutput,
  SoulToolInput,
  SoulToolOutput,
  ToolDocsToolInput,
  ToolDocsToolOutput,
  TraceRetrieveGlobalResult,
  TraceRetrieveGlobalSearchInput,
  TraceRetrieveGlobalToolInput,
  TraceRetrieveGlobalToolOutput,
  TraceRetrieveToolInput,
  TraceRetrieveToolOutput,
  TraceRetrieveMainToolInput,
  UserProfileToolInput,
  UserProfileToolOutput,
  UpdateProjectWorkspaceRequest,
  UpdateProjectWorkspaceResponse,
  UpdateConversationRequest,
  UpsertProjectInstructionsRequest,
  User,
  ServerEvent,
  ModelOption,
  ModelSettingsResolution,
  ModelSettingsSelection,
  WorkerModelRole,
  WorkerModelSettings,
} from "@socrates/contracts"
import { traceRetrieveMainToolInputSchema } from "@socrates/contracts"
import {
  createDefaultEmbeddingProvider,
  createDefaultModelProvider,
  listAvailableModels as listStaticAvailableModels,
  listOllamaChatModels,
  type EmbeddingProvider,
  type ModelProvider,
  type ProviderCredentialResolver,
} from "@socrates/providers"
import { SocratesError } from "@socrates/shared"
import os from "node:os"
import path from "node:path"
import type { DatabaseHandle } from "../db/client"
import { ApprovalStore } from "./store/approvalStore"
import { AttachmentStore } from "./store/attachmentStore"
import { AgentTaskStore, type ContinuedTerminalTask, type ReadyTerminalTask } from "./store/agentTaskStore"
import { ContextCompactionStore } from "./store/contextCompactionStore"
import { ConversationStore } from "./store/conversationStore"
import { ErrorStore, type RecordErrorInput } from "./store/errorStore"
import { EventStore, type FailedToolEventForLedger } from "./store/eventStore"
import { EmbeddingStore } from "./store/embeddingStore"
import { FeedbackStore } from "./store/feedbackStore"
import { InstructionStore } from "./store/instructionStore"
import { ModelTelemetryStore } from "./store/modelTelemetryStore"
import { MemoryStore } from "./store/memoryStore"
import { MemoryAgentGlobalSettingsStore } from "./store/memoryAgentGlobalSettingsStore"
import { resolveModelSettingsForAvailableModels } from "./store/modelSettingsResolver"
import { NotificationStore } from "./store/notificationStore"
import { ProjectStore } from "./store/projectStore"
import { ResourceStore } from "./store/resourceStore"
import { WorkerModelSettingsStore } from "./store/workerModelSettingsStore"
import type { StoreContext } from "./store/shared"
import { TraceStore } from "./store/traceStore"
import { TerminalStore } from "./store/terminalStore"
import { ToolStore } from "./store/toolStore"
import { TurnStore } from "./store/turnStore"
import type {
  AgentContext,
  ConversationModelMessage,
  ConversationUsageReportBundle,
  CreatedTurn,
  ProjectDashboard,
  ProjectListItem,
  StoreEventInput,
  StoredModelUsage,
  UploadedAttachmentInput,
  UploadedResourceInput,
} from "./store/types"
import { UserStore } from "./store/userStore"
import { RetrievalStore } from "./retrieval/retrievalStore"

export type {
  AgentContext,
  ConversationModelMessage,
  ConversationUsageReportBundle,
  CreatedTurn,
  ProjectDashboard,
  ProjectListItem,
  StoreEventInput,
  StoredModelUsage,
  UploadedAttachmentInput,
  UploadedResourceInput,
} from "./store/types"

export class SocratesStore {
  private readonly events: EventStore
  private readonly users: UserStore
  private readonly instructions: InstructionStore
  private readonly projects: ProjectStore
  private readonly resources: ResourceStore
  private readonly modelTelemetry: ModelTelemetryStore
  private readonly conversations: ConversationStore
  private readonly errors: ErrorStore
  private readonly turns: TurnStore
  private readonly approvals: ApprovalStore
  private readonly attachments: AttachmentStore
  private readonly feedback: FeedbackStore
  private readonly tools: ToolStore
  private readonly terminals: TerminalStore
  private readonly agentTasks: AgentTaskStore
  private readonly traces: TraceStore
  private readonly memory: MemoryStore
  private readonly memoryAgentSettings: MemoryAgentGlobalSettingsStore
  private readonly workerModelSettings: WorkerModelSettingsStore
  private readonly notifications: NotificationStore
  private readonly embeddings: EmbeddingStore
  private readonly retrieval: RetrievalStore
  private readonly contextCompactions: ContextCompactionStore
  private ollamaChatModels: ModelOption[] = []
  private ollamaChatModelsCheckedAt = 0
  private memoryAgentScheduler: ReturnType<typeof setInterval> | undefined
  private globalTraceRefs: Array<{ projectId: string; turnId: string }> = []

  constructor(
    private readonly handle: DatabaseHandle,
    embeddingProvider?: EmbeddingProvider,
    private readonly credentials?: ProviderCredentialResolver,
    options: { socratesHome?: string; memoryProvider?: ModelProvider } = {},
  ) {
    this.events = new EventStore(handle)
    const context: StoreContext = {
      handle,
      appendEvent: (input) => this.events.appendEvent(input),
    }

    this.users = new UserStore(context)
    this.instructions = new InstructionStore(context)
    this.projects = new ProjectStore(context, this.instructions)
    this.resources = new ResourceStore(context)
    this.modelTelemetry = new ModelTelemetryStore(context)
    this.conversations = new ConversationStore(context, this.modelTelemetry)
    this.errors = new ErrorStore(context)
    this.approvals = new ApprovalStore(context)
    this.attachments = new AttachmentStore(context)
    this.turns = new TurnStore(context, this.errors, this.attachments)
    this.feedback = new FeedbackStore(context)
    this.tools = new ToolStore(context)
    this.terminals = new TerminalStore(context)
    this.agentTasks = new AgentTaskStore(context)
    this.embeddings = new EmbeddingStore(context, embeddingProvider ?? createDefaultEmbeddingProvider(credentials), credentials)
    const socratesHome = options.socratesHome ?? path.join(os.homedir(), ".Socrates")
    this.retrieval = new RetrievalStore(context, this.embeddings, socratesHome)
    this.traces = new TraceStore(context)
    this.notifications = new NotificationStore(context)
    this.memoryAgentSettings = new MemoryAgentGlobalSettingsStore(context)
    this.workerModelSettings = new WorkerModelSettingsStore(context)
    const memoryOptions = {
      ...(options.socratesHome ? { socratesHome: options.socratesHome } : {}),
      ...(options.memoryProvider ? { provider: options.memoryProvider } : credentials ? { provider: createDefaultModelProvider(credentials) } : {}),
      ...(credentials ? { credentials } : {}),
      traceRetrieveGlobal: (input: TraceRetrieveGlobalToolInput) => this.retrieveGlobalToolTraces(input),
      getMemoryAgentGlobalSettings: () => this.memoryAgentSettings.ensureSettings(),
      getWorkerModelSettings: (workerId: WorkerModelRole) => this.getWorkerModelSetting(workerId),
      onMemoryDocIndexed: (index: MemoryDocIndex, changedSectionIds: string[], removedSectionIds: string[]) =>
        this.retrieval.onMemoryDocIndexed(index, changedSectionIds, removedSectionIds),
      createNotification: (input: Parameters<NotificationStore["createNotification"]>[0]) => this.notifications.createNotification(input),
    }
    this.memory = new MemoryStore(context, memoryOptions)
    this.contextCompactions = new ContextCompactionStore(context, this.errors)
  }

  async close(): Promise<void> {
    if (this.memoryAgentScheduler) {
      clearInterval(this.memoryAgentScheduler)
      this.memoryAgentScheduler = undefined
    }
    await this.retrieval.dispose()
    await this.embeddings.dispose()
    this.handle.close()
  }

  async initializeRetrieval(): Promise<void> {
    const projects = this.handle.sqlite
      .prepare(
        `SELECT p.id,
                (SELECT pw.path FROM project_workspaces pw WHERE pw.project_id = p.id AND pw.is_primary = 1 AND pw.status IN ('active','missing') ORDER BY pw.updated_at DESC LIMIT 1) AS workspacePath
         FROM projects p
         WHERE p.status <> 'deleted'`,
      )
      .all() as Array<{ id: string; workspacePath: string | null }>
    for (const project of projects) {
      this.memory.ensureProjectMemory(project.id, project.workspacePath ?? undefined)
    }
    await this.retrieval.initialize()
  }

  cancelStaleActiveTurns(reason = "Socrates stopped before this response completed."): number {
    const rows = this.handle.sqlite
      .prepare("SELECT id FROM turns WHERE status IN ('queued', 'running', 'awaiting_approval') ORDER BY started_at")
      .all() as Array<{ id: string }>
    for (const row of rows) {
      try {
        this.cancelTurn(row.id, reason)
      } catch {
        // Startup reconciliation should not block the app if one stale row is already inconsistent.
      }
    }
    return rows.length
  }

  getCurrentUser(): User | null {
    return this.users.getCurrentUser()
  }

  completeOnboarding(input: CompleteOnboardingRequest): User {
    return this.users.completeOnboarding(input)
  }

  pickWorkspaceFolder(input: PickWorkspaceFolderRequest): Promise<PickWorkspaceFolderResponse> {
    return this.projects.pickWorkspaceFolder(input)
  }

  inspectWorkspace(input: InspectWorkspaceRequest): InspectWorkspaceResponse {
    return this.projects.inspectWorkspace(input)
  }

  listProjects(): ProjectListItem[] {
    return this.projects.listProjects()
  }

  createProject(input: CreateProjectRequest): { project: Project; primaryWorkspace: ProjectWorkspace } {
    const created = this.projects.createProject(input)
    this.ensureProjectMemory(created.project.id)
    return created
  }

  getProjectDashboard(projectId: string): ProjectDashboard {
    return {
      ...this.projects.getProjectDashboard(projectId),
      resources: this.resources.listResources(projectId),
      skills: this.memory.listProjectSkills(projectId, this.primaryWorkspacePathOrUndefined(projectId)),
      embeddingStatus: this.getProjectEmbeddingStatus(projectId),
    }
  }

  getAgentContext(projectId: string): AgentContext {
    const context = this.projects.getAgentContext(projectId)
    this.ensureProjectMemory(projectId)
    return context
  }

  getPrimaryWorkspacePath(projectId: string): string {
    return this.projects.getPrimaryWorkspacePath(projectId)
  }

  ensureProjectMemory(projectId: string): void {
    this.memory.ensureProjectMemory(projectId, this.primaryWorkspacePathOrUndefined(projectId))
  }

  recordProjectStateLedgerTurn(
    projectId: string,
    conversationId: string,
    turnId: string,
    status: "completed" | "cancelled" | "failed",
    _assistantPreview?: string,
  ): void {
    try {
      const workspacePath = this.primaryWorkspacePathOrUndefined(projectId)
      const conversation = this.conversations.getConversation(projectId, conversationId).conversation
      const toolRuns = this.tools.getConversationToolRuns(conversationId).filter((run) => run.turnId === turnId)
      const failedToolEvents: FailedToolEventForLedger[] = this.events.listFailedToolEvents(conversationId, turnId)
      const userMessage = this.handle.sqlite
        .prepare(
          `SELECT m.content AS content
           FROM turns t
           LEFT JOIN messages m ON m.id = t.user_message_id
           WHERE t.id = ?`,
        )
        .get(turnId) as { content?: string } | undefined
      this.memory.recordProjectStateLedger(projectId, workspacePath, {
        ...(conversation.title ? { conversationTitle: conversation.title } : {}),
        turnId,
        status,
        ...(userMessage?.content ? { userRequest: userMessage.content } : {}),
        toolRuns,
        failedToolEvents,
      })
    } catch {
      // State-ledger updates are startup-map hints; they must not break chat turns.
    }
  }

  runToolDocsTool(projectId: string, input: ToolDocsToolInput): ToolDocsToolOutput {
    return this.memory.runToolDocsTool(projectId, this.primaryWorkspacePathOrUndefined(projectId), input)
  }

  runSkillsTool(projectId: string, input: SkillsToolInput): SkillsToolOutput {
    return this.memory.runSkillsTool(projectId, this.primaryWorkspacePathOrUndefined(projectId), input)
  }

  runSkillsImportTool(
    projectId: string,
    input: SkillsToolInput,
    source: { conversationId: string; turnId: string; signal?: AbortSignal },
  ): Promise<SkillsToolOutput> {
    const attachedArchive = input.operation === "preview_import" && input.attachmentPath
      ? this.attachments.readCurrentTurnSkillZip({
          projectId,
          conversationId: source.conversationId,
          turnId: source.turnId,
          attachmentPath: input.attachmentPath,
        })
      : undefined
    return this.memory.runSkillsImportTool(
      projectId,
      this.primaryWorkspacePathOrUndefined(projectId),
      input,
      source.signal,
      attachedArchive,
    )
  }

  createMemoryNote(projectId: string, input: MemoryNoteToolInput, source: { conversationId: string; sessionId: string; turnId: string }): MemoryNoteToolOutput {
    return this.memory.createMemoryNote(input, { projectId, ...source })
  }

  runMemoryNotesTool(input: MemoryNotesToolInput): MemoryNotesToolOutput {
    return this.memory.runMemoryNotesTool(input)
  }

  async buildProjectSkill(projectId: string, input: BuildProjectSkillRequest): Promise<BuildProjectSkillResponse> {
    return { skill: await this.memory.buildProjectSkill(projectId, this.getPrimaryWorkspacePath(projectId), input.request, input.name) }
  }

  deleteProjectSkill(projectId: string, skillName: string): DeleteSkillResponse {
    const deleted = this.memory.deleteProjectSkill(projectId, this.getPrimaryWorkspacePath(projectId), skillName)
    return { deletedSkillName: deleted.name, scope: deleted.scope }
  }

  previewProjectSkillImport(projectId: string, filename: string, data: Buffer): Promise<SkillImportPreview> {
    return this.memory.previewProjectSkillImport(projectId, this.getPrimaryWorkspacePath(projectId), filename, data)
  }

  commitProjectSkillImport(projectId: string, previewId: string, conflictStrategy: "reject" | "replace"): CommitSkillImportResponse {
    return this.memory.commitProjectSkillImport(projectId, this.getPrimaryWorkspacePath(projectId), previewId, conflictStrategy)
  }

  setProjectSkillEnabled(projectId: string, skillName: string, enabled: boolean) {
    return this.memory.setProjectSkillEnabled(projectId, this.getPrimaryWorkspacePath(projectId), skillName, enabled)
  }

  async buildGlobalSkill(input: BuildGlobalSkillRequest): Promise<BuildGlobalSkillResponse> {
    return { skill: await this.memory.buildGlobalSkill(input.request, input.name) }
  }

  previewGlobalSkillImport(filename: string, data: Buffer): Promise<SkillImportPreview> {
    return this.memory.previewGlobalSkillImport(filename, data)
  }

  commitGlobalSkillImport(previewId: string, conflictStrategy: "reject" | "replace"): CommitSkillImportResponse {
    return this.memory.commitGlobalSkillImport(previewId, conflictStrategy)
  }

  setGlobalSkillEnabled(skillName: string, enabled: boolean) {
    return this.memory.setGlobalSkillEnabled(skillName, enabled)
  }

  async approveMemorySkillProposal(actionId: string): Promise<ApproveMemorySkillProposalResponse> {
    const response = await this.memory.approveMemorySkillProposal(actionId)
    this.notifications.markSkillProposalNotificationsRead(actionId)
    return response
  }

  rejectMemorySkillProposal(actionId: string): RejectMemorySkillProposalResponse {
    const response = this.memory.rejectMemorySkillProposal(actionId)
    this.notifications.markSkillProposalNotificationsRead(actionId)
    return response
  }

  deleteGlobalSkill(skillName: string): DeleteSkillResponse {
    const deleted = this.memory.deleteGlobalSkill(skillName)
    return { deletedSkillName: deleted.name, scope: deleted.scope }
  }

  getMemoryAgent(): GetMemoryAgentResponse {
    const settings = this.memoryAgentSettings.ensureSettings()
    const resolution = this.resolveModelSettings(settings, "memory_agent")
    const effectiveSettings = resolution.effective ? { ...settings, ...resolution.effective } : settings
    const state = this.memoryAgentSettings.ensureState()
    return {
      settings: effectiveSettings,
      state,
      pending: this.memory.getMemoryAgentPending(state),
      recentItems: this.memory.listMemoryAgentTimeline(25, 0).items,
    }
  }

  listMemoryAgentRuns(input: { limit?: number; offset?: number } = {}): ListMemoryAgentRunsResponse {
    return this.memory.listMemoryAgentTimeline(input.limit ?? 25, input.offset ?? 0)
  }

  getMemoryAgentRun(runId: string): GetMemoryAgentRunResponse {
    return { run: this.memory.getMemoryAgentRunDetail(runId) }
  }

  listMemoryAgentFiles(): ListMemoryAgentFilesResponse {
    return { files: this.memory.listMemoryAgentFiles() }
  }

  getMemoryAgentFileContent(input: MemoryAgentFileContentQuery): GetMemoryAgentFileContentResponse {
    return this.memory.readMemoryAgentFileContent(input)
  }

  updateMemoryAgentSettings(input: UpdateMemoryAgentGlobalSettingsRequest): UpdateMemoryAgentGlobalSettingsResponse {
    const settings = this.memoryAgentSettings.updateSettings(input)
    const resolution = this.resolveModelSettings(settings, "memory_agent")
    return { settings: resolution.effective ? { ...settings, ...resolution.effective } : settings }
  }

  async refreshAvailableModels(options: { force?: boolean } = {}): Promise<ListModelsResponse> {
    if (process.env.NODE_ENV === "test" && process.env.SOCRATES_ENABLE_OLLAMA_CHAT_DISCOVERY !== "true") {
      return this.listAvailableModels()
    }
    const now = Date.now()
    if (options.force || now - this.ollamaChatModelsCheckedAt > 5_000) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 1_500)
      try {
        const result = await listOllamaChatModels({ abortSignal: controller.signal })
        this.ollamaChatModels = result.models
        this.ollamaChatModelsCheckedAt = now
      } finally {
        clearTimeout(timeout)
      }
    }
    return this.listAvailableModels()
  }

  listAvailableModels(): ListModelsResponse {
    const response = listStaticAvailableModels(this.credentials?.availableAuthModes?.() ?? [])
    const models = mergeModelOptions(response.models, this.ollamaChatModels)
    const defaultModel =
      response.defaultModel ??
      (this.ollamaChatModels[0]
        ? {
            providerId: this.ollamaChatModels[0].providerId,
            authMode: this.ollamaChatModels[0].authMode,
            modelId: this.ollamaChatModels[0].modelId,
            thinkingOptionId: this.ollamaChatModels[0].defaultThinkingOptionId,
          }
        : null)
    return { models, defaultModel }
  }

  findAvailableModelOption(providerId: string, modelId: string, authMode = "api_key"): ModelOption | undefined {
    return this.listAvailableModels().models.find(
      (candidate) => candidate.providerId === providerId && candidate.authMode === authMode && candidate.modelId === modelId,
    )
  }

  resolveModelSettings(saved: ModelSettingsSelection, role: "chat" | "memory_agent" | WorkerModelRole): ModelSettingsResolution {
    return resolveModelSettingsForAvailableModels(saved, role, this.listAvailableModels())
  }

  resolveRuntimeConfig(runtimeConfig: RuntimeConfig): RuntimeConfig {
    const resolution = this.resolveModelSettings(
      {
        providerId: runtimeConfig.providerId,
        authMode: runtimeConfig.authMode ?? "api_key",
        modelId: runtimeConfig.modelId,
        thinkingEnabled: runtimeConfig.thinkingEnabled,
        ...(runtimeConfig.thinkingEffort ? { thinkingEffort: runtimeConfig.thinkingEffort } : {}),
      },
      "chat",
    )
    if (!resolution.effective) {
      throw new SocratesError("model_unavailable", resolution.reason ?? "No available model is configured.", { recoverable: true })
    }
    const resolved: RuntimeConfig = {
      ...runtimeConfig,
      providerId: resolution.effective.providerId,
      authMode: resolution.effective.authMode,
      modelId: resolution.effective.modelId,
      thinkingEnabled: resolution.effective.thinkingEnabled,
      ...(resolution.effective.thinkingEffort ? { thinkingEffort: resolution.effective.thinkingEffort } : {}),
    }
    if (!resolution.effective.thinkingEffort) {
      delete resolved.thinkingEffort
    }
    return resolved
  }

  listWorkerModelSettings(): { settings: WorkerModelSettings[]; resolutions: ModelSettingsResolution[] } {
    const settings = this.workerModelSettings.ensureAll()
    return {
      settings,
      resolutions: settings.map((setting) => this.resolveModelSettings(setting, setting.workerId)),
    }
  }

  getWorkerModelSetting(workerId: WorkerModelRole): WorkerModelSettings {
    const saved = this.workerModelSettings.ensureSetting(workerId)
    const resolution = this.resolveModelSettings(saved, workerId)
    return resolution.effective ? { ...saved, ...resolution.effective } : saved
  }

  updateWorkerModelSettings(workerId: WorkerModelRole, input: UpdateWorkerModelSettingsRequest): UpdateWorkerModelSettingsResponse {
    if (this.credentials?.availableAuthModes) {
      const model = this.listAvailableModels().models.find(
        (candidate) =>
          candidate.providerId === input.providerId &&
          candidate.authMode === (input.authMode ?? "api_key") &&
          candidate.modelId === input.modelId,
      )
      if (!model) {
        throw new SocratesError("worker_model_unavailable", "Choose an available model before saving this worker setting.", { recoverable: true })
      }
    }
    return { settings: this.workerModelSettings.updateSetting(workerId, input) }
  }

  async runGlobalMemoryAgent(trigger: "scheduled" | "manual" = "manual"): Promise<TriggerMemoryAgentRunResponse> {
    await this.refreshAvailableModels()
    const settings = this.memoryAgentSettings.ensureSettings()
    const resolution = this.resolveModelSettings(settings, "memory_agent")
    const effectiveSettings = resolution.effective ? { ...settings, ...resolution.effective } : settings
    return this.memory.runGlobalMemoryAgent({
      trigger,
      settings: effectiveSettings,
      state: this.memoryAgentSettings.ensureState(),
      updateState: (patch) => this.memoryAgentSettings.updateState(patch),
    })
  }

  startGlobalMemoryScheduler(): void {
    if (this.memoryAgentScheduler) {
      return
    }
    this.memoryAgentScheduler = setInterval(() => {
      void this.runScheduledGlobalMemoryAgentIfDue()
    }, 60_000)
    this.memoryAgentScheduler.unref?.()
    void this.runScheduledGlobalMemoryAgentIfDue()
  }

  private async runScheduledGlobalMemoryAgentIfDue(): Promise<void> {
    const settings = this.memoryAgentSettings.ensureSettings()
    if (!settings.enabled) {
      return
    }
    const state = this.memoryAgentSettings.ensureState()
    const lastCheckedMs = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : 0
    if (state.status === "running" || (lastCheckedMs > 0 && Date.now() - lastCheckedMs < settings.cadenceMinutes * 60_000)) {
      return
    }
    await this.runGlobalMemoryAgent("scheduled")
  }

  runProjectDocsTool(projectId: string, workspacePath: string, input: ProjectDocsToolInput): ProjectDocsToolOutput {
    return this.memory.runProjectDocsTool(projectId, workspacePath, input)
  }

  runRepoDocsTool(projectId: string, workspacePath: string, input: RepoDocsToolInput): RepoDocsToolOutput {
    return this.memory.runRepoDocsTool(projectId, workspacePath, input)
  }

  runSoulTool(projectId: string, input: SoulToolInput): SoulToolOutput {
    return this.memory.runSoulTool(projectId, this.primaryWorkspacePathOrUndefined(projectId), input)
  }

  runUserProfileTool(projectId: string, input: UserProfileToolInput): UserProfileToolOutput {
    return this.memory.runUserProfileTool(projectId, this.primaryWorkspacePathOrUndefined(projectId), input)
  }

  listNotifications(input: { unreadOnly?: boolean; limit?: number } = {}): ListNotificationsResponse {
    return this.notifications.listNotifications(input)
  }

  markNotificationRead(notificationId: string): MarkNotificationReadResponse {
    return this.notifications.markRead(notificationId)
  }

  markAllNotificationsRead(): MarkAllNotificationsReadResponse {
    return this.notifications.markAllRead()
  }

  patchProject(projectId: string, input: PatchProjectRequest): Project {
    return this.projects.patchProject(projectId, input)
  }

  updateProjectWorkspace(projectId: string, input: UpdateProjectWorkspaceRequest): UpdateProjectWorkspaceResponse {
    return this.projects.updateProjectWorkspace(projectId, input)
  }

  listResources(projectId: string, options: { includeDeleted?: boolean } = {}): ProjectResource[] {
    return this.resources.listResources(projectId, options)
  }

  createResource(projectId: string, input: CreateProjectResourceRequest): ProjectResource {
    return this.resources.createResource(projectId, input)
  }

  createUploadedResources(projectId: string, inputs: UploadedResourceInput[]): ProjectResource[] {
    return this.resources.createUploadedResources(projectId, inputs)
  }

  createConversationAttachments(
    projectId: string,
    conversationId: string,
    inputs: UploadedAttachmentInput[],
  ): MessageAttachment[] {
    return this.attachments.createDraftAttachments(projectId, conversationId, inputs)
  }

  getConversationAttachmentContent(projectId: string, conversationId: string, attachmentId: string): MessageAttachment {
    return this.attachments.getAttachmentForContent(projectId, conversationId, attachmentId)
  }

  deleteResource(projectId: string, resourceId: string): string {
    return this.resources.deleteResource(projectId, resourceId)
  }

  upsertProjectInstructions(projectId: string, input: UpsertProjectInstructionsRequest): ProjectInstructions {
    return this.instructions.upsertProjectInstructions(projectId, input)
  }

  listConversations(projectId: string): Conversation[] {
    return this.conversations.listConversations(projectId)
  }

  createConversation(projectId: string, input: CreateConversationRequest): Conversation {
    return this.conversations.createConversation(projectId, input)
  }

  listActiveTurnServerEvents(projectId: string, conversationId: string): ServerEvent[] {
    return this.events.listActiveTurnServerEvents(projectId, conversationId)
  }

  updateConversationTitle(projectId: string, conversationId: string, input: UpdateConversationRequest): Conversation {
    return this.conversations.updateConversationTitle(projectId, conversationId, input)
  }

  getConversation(
    projectId: string,
    conversationId: string,
  ): {
    conversation: Conversation
    messages: Message[]
    toolRuns: ConversationToolRun[]
    terminals?: ConversationTerminal[]
    partialTurns?: ConversationPartialTurn[]
    activitySteps?: ConversationActivityStep[]
    tokenUsage: ConversationTokenUsage
    costUsage: ConversationCostUsage
    turnUsageReports?: ConversationUsageReportBundle["turnUsageReports"]
    contextUsage?: ConversationContextUsage
    lastRuntimeConfig?: RuntimeConfig
  } {
    const conversation = this.conversations.getConversation(projectId, conversationId)
    const toolRuns = this.tools.getConversationToolRuns(conversationId)
    const usageReports = this.modelTelemetry.getConversationUsageReportBundle(conversationId)
    return {
      ...conversation,
      costUsage: usageReports.costUsage,
      ...(usageReports.turnUsageReports.length > 0 ? { turnUsageReports: usageReports.turnUsageReports } : {}),
      toolRuns,
      activitySteps: this.modelTelemetry.getConversationActivitySteps(conversationId, toolRuns),
      terminals: this.terminals.listConversationTerminals(conversationId),
    }
  }

  createConversationUserMessage(
    projectId: string,
    conversationId: string,
    input: CreateConversationMessageRequest,
  ): { conversation: Conversation; message: Message } {
    return this.conversations.createConversationUserMessage(projectId, conversationId, input)
  }

  autoTitleConversation(projectId: string, conversationId: string, title: string, expectedTitle?: string): Conversation | undefined {
    return this.conversations.autoTitleConversation(projectId, conversationId, title, expectedTitle)
  }

  deleteConversation(projectId: string, conversationId: string): { deletedConversationId: string } {
    this.terminals.stopConversationTerminals(conversationId)
    const deleted = this.conversations.deleteConversation(projectId, conversationId)
    this.retrieval.deleteConversation(projectId, conversationId)
    return deleted
  }

  createTurnFromUserMessage(projectId: string, conversationId: string, payload: ChatMessageSendPayload): CreatedTurn {
    return this.turns.createTurnFromUserMessage(projectId, conversationId, payload)
  }

  registerTerminalWait(input: Parameters<AgentTaskStore["registerTerminalWait"]>[0]) {
    return this.agentTasks.registerTerminalWait(input)
  }

  claimTerminalTaskWake(terminalId: string, wakeEvent: "completed" | "failed" | "input_required"): ReadyTerminalTask[] {
    return this.agentTasks.claimWakeForTerminal(terminalId, wakeEvent)
  }

  beginTerminalTaskContinuation(task: ReadyTerminalTask): ContinuedTerminalTask | undefined {
    return this.agentTasks.beginContinuation(task)
  }

  listReadyTerminalTasks(): ReadyTerminalTask[] {
    return this.agentTasks.listReadyTasks()
  }

  requeueInterruptedTerminalTasks(): number {
    return this.agentTasks.requeueInterruptedContinuations()
  }

  completeTerminalTaskForTurn(turnId: string, status: "completed" | "failed" | "cancelled"): void {
    this.agentTasks.completeTaskForTurn(turnId, status)
  }

  hasWaitingTerminalTask(terminalId: string): boolean {
    return this.agentTasks.hasWaitingTerminalTask(terminalId)
  }

  getConversationModelMessages(
    projectId: string,
    conversationId: string,
    options: { includeImageParts?: boolean } = {},
  ): ConversationModelMessage[] {
    return this.conversations.getConversationModelMessages(projectId, conversationId, {
      ...options,
      readAttachmentDataUrl: (attachment) => this.attachments.readAttachmentDataUrl(attachment),
    })
  }

  createModelCall(input: {
    conversationId: string
    sessionId: string
    turnId: string
    runtimeConfigId: string
    providerId: string
    modelId: string
    request: unknown
  }): string {
    return this.modelTelemetry.createModelCall(input)
  }

  appendModelStreamChunk(input: {
    modelCallId: string
    turnId: string
    channel: "reasoning" | "answer" | "metadata"
    text?: string
    payload?: unknown
  }): void {
    this.modelTelemetry.appendModelStreamChunk(input)
  }

  completeModelCall(input: { modelCallId: string; response: unknown; providerResponse?: unknown; usage?: StoredModelUsage }): void {
    this.modelTelemetry.completeModelCall(input)
  }

  failModelCall(modelCallId: string, errorId?: string): void {
    this.modelTelemetry.failModelCall(modelCallId, errorId)
  }

  completeAgentTurn(input: {
    conversationId: string
    sessionId: string
    turnId: string
    content: string
    reasoning?: string
  }): Message {
    return this.turns.completeAgentTurn(input)
  }

  failTurn(input: {
    conversationId: string
    sessionId: string
    turnId: string
    code: string
    message: string
    details?: unknown
  }): string {
    return this.turns.failTurn(input)
  }

  recordContextUsageSnapshot(input: {
    conversationId: string
    sessionId: string
    turnId: string
    modelCallId: string
    providerId: string
    modelId: string
    contextWindowTokens: number
    contextUsedTokens: number
    metadata?: Record<string, unknown>
  }): void {
    this.modelTelemetry.recordContextUsageSnapshot(input)
  }

  recordConversationTitleUsage(input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId: string
    sourceId: string
    providerId: string
    modelId: string
    status: string
    startedAt?: string
    completedAt?: string
    usage?: StoredModelUsage
  }): void {
    this.modelTelemetry.recordConversationTitleUsage(input)
  }

  recordMemoryRouterUsage(input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId: string
    sourceId: string
    providerId: string
    modelId: string
    status: string
    startedAt?: string
    completedAt?: string
    usage?: StoredModelUsage
  }): void {
    this.modelTelemetry.recordMemoryRouterUsage(input)
  }

  getLatestContextCompactionSnapshot(conversationId: string): ContextCompactionSummary | undefined {
    return this.contextCompactions.getLatestActive(conversationId)
  }

  startContextCompactionSnapshot(
    input: StartCompactionSnapshotInput & { projectId: string; conversationId: string; sessionId: string; turnId: string },
  ): void {
    this.contextCompactions.start(input)
  }

  completeContextCompactionSnapshot(input: CompleteCompactionSnapshotInput): void {
    const completed = this.contextCompactions.complete(input)
    if (completed) {
      this.modelTelemetry.recordContextCompactionUsage({
        projectId: completed.projectId,
        conversationId: completed.conversationId,
        sessionId: completed.sessionId,
        snapshotId: completed.snapshotId,
        providerId: completed.providerId,
        modelId: completed.modelId,
        status: completed.status,
        ...(completed.turnId ? { turnId: completed.turnId } : {}),
        ...(completed.startedAt ? { startedAt: completed.startedAt } : {}),
        ...(completed.completedAt ? { completedAt: completed.completedAt } : {}),
        ...(completed.usage ? { usage: completed.usage } : {}),
      })
      if (completed.turnId) {
        this.modelTelemetry.buildTurnUsageReport(completed.turnId)
      }
      this.traces.indexCompactionSnapshot(completed)
    }
  }

  failContextCompactionSnapshot(input: FailCompactionSnapshotInput): string {
    return this.contextCompactions.fail(input)
  }

  getConversationTokenUsage(conversationId: string): ConversationTokenUsage {
    return this.modelTelemetry.getConversationTokenUsage(conversationId)
  }

  buildTurnUsageReport(turnId: string) {
    return this.modelTelemetry.buildTurnUsageReport(turnId)
  }

  completePlaceholderTurn(projectId: string, conversationId: string, turnId: string): Message | null {
    return this.turns.completePlaceholderTurn(projectId, conversationId, turnId)
  }

  cancelTurn(
    turnId: string,
    reason?: string,
  ): { projectId: string; conversationId: string; sessionId: string; turnId: string; partialAssistantMessage?: Message } {
    const partialAnswer = this.modelTelemetry.getAnswerTextByTurnId(turnId)
    const cancelled = this.turns.cancelTurn(turnId, reason, partialAnswer)
    this.approvals.rejectPendingForTurn(turnId, reason)
    this.tools.cancelOpenShellCommandsForTurn(turnId)
    this.tools.cancelOpenToolCallsForTurn(turnId)
    this.modelTelemetry.cancelOpenModelCallsForTurn(turnId)
    return cancelled
  }

  resolveApproval(approvalId: string, decision: "approved" | "rejected", reason?: string): void {
    this.approvals.resolveApproval(approvalId, decision, reason)
  }

  createApproval(input: Parameters<ApprovalStore["createApproval"]>[0]): string {
    return this.approvals.createApproval(input)
  }

  createToolCall(input: Parameters<ToolStore["createToolCall"]>[0]): void {
    this.tools.createToolCall(input)
  }

  attachToolApproval(toolCallId: string, approvalId: string): void {
    this.tools.attachApproval(toolCallId, approvalId)
  }

  markToolRunning(toolCallId: string): void {
    this.tools.markToolRunning(toolCallId)
  }

  markToolRunningByApproval(approvalId: string): void {
    this.tools.markToolRunningByApproval(approvalId)
  }

  completeToolCall(toolCallId: string, result: unknown): void {
    this.tools.completeToolCall(toolCallId, result)
  }

  failToolCall(toolCallId: string, errorId?: string, rejected?: boolean): void {
    this.tools.failToolCall(toolCallId, errorId, rejected)
  }

  createShellCommand(input: Parameters<ToolStore["createShellCommand"]>[0]): string {
    return this.tools.createShellCommand(input)
  }

  appendShellOutput(toolCallId: string, stream: "stdout" | "stderr" | "log" | "result", text: string): void {
    this.tools.appendShellOutput(toolCallId, stream, text)
  }

  updateShellCommandMetadata(toolCallId: string, metadata: unknown): void {
    this.tools.updateShellCommandMetadata(toolCallId, metadata)
  }

  completeShellCommand(toolCallId: string, input: Parameters<ToolStore["completeShellCommand"]>[1]): void {
    this.tools.completeShellCommand(toolCallId, input)
  }

  failShellCommand(toolCallId: string): void {
    this.tools.failShellCommand(toolCallId)
  }

  createTerminal(input: Parameters<TerminalStore["createTerminal"]>[0]): string {
    return this.terminals.createTerminal(input)
  }

  updateTerminal(terminalId: string, input: Parameters<TerminalStore["updateTerminal"]>[1]): void {
    this.terminals.updateTerminal(terminalId, input)
  }

  appendTerminalOutput(input: Parameters<TerminalStore["appendOutput"]>[0]): number {
    return this.terminals.appendOutput(input)
  }

  getModelVisibleTerminalOutputSequence(terminalId: string): number {
    return this.terminals.getModelVisibleOutputSequence(terminalId)
  }

  setModelVisibleTerminalOutputSequence(terminalId: string, sequence: number): void {
    this.terminals.setModelVisibleOutputSequence(terminalId, sequence)
  }

  terminalOutputSnapshot(terminalId: string, fromSequence?: number, charLimit?: number): ReturnType<TerminalStore["terminalOutputSnapshot"]> {
    return this.terminals.terminalOutputSnapshot(terminalId, fromSequence, charLimit)
  }

  findTerminal(conversationId: string, identifier: string) {
    return this.terminals.findTerminalRow(conversationId, identifier)
  }

  listConversationTerminals(conversationId: string): ConversationTerminal[] {
    return this.terminals.listConversationTerminals(conversationId)
  }

  listActiveTerminals(): ConversationTerminal[] {
    return this.terminals.listActiveTerminals()
  }

  terminalContextBrief(conversationId: string): string | undefined {
    return this.terminals.terminalContextBrief(conversationId)
  }

  markRunningTerminalsDetached(): ConversationTerminal[] {
    return this.terminals.markRunningDetached()
  }

  stopConversationTerminals(conversationId: string): void {
    this.terminals.stopConversationTerminals(conversationId)
  }

  stopProjectTerminals(projectId: string): void {
    this.terminals.stopProjectTerminals(projectId)
  }

  recordFileOperations(input: Parameters<ToolStore["recordFileOperations"]>[0]): void {
    this.tools.recordFileOperations(input)
  }

  recordPatch(input: Parameters<ToolStore["recordPatch"]>[0]): void {
    this.tools.recordPatch(input)
  }

  indexTurnTraceDocuments(projectId: string, conversationId: string, turnId: string): void {
    this.traces.indexTurn(projectId, conversationId, turnId)
    this.retrieval.enqueueTurn(projectId, turnId)
  }

  retrieveToolTraces(projectId: string, conversationId: string, input: TraceRetrieveToolInput) {
    return this.traces.retrieve(projectId, conversationId, input)
  }

  async retrieveGlobalToolTraces(input: TraceRetrieveGlobalToolInput): Promise<TraceRetrieveGlobalToolOutput> {
    if (input.operation === "inspect") {
      const previous = input.resultNumber ? this.globalTraceRefs[input.resultNumber - 1] : undefined
      const turnId = input.turnId ?? previous?.turnId
      const projectId = previous?.projectId ?? input.projectId ?? this.resolveGlobalInspectProjectId(input, turnId)
      if (!projectId) {
        throw new SocratesError("trace_result_not_found", "The requested trace result could not be resolved to a visible project.", { recoverable: true })
      }
      const inspected = await this.retrieval.retrieveMainTrace(projectId, "", {
        operation: "inspect",
        ...(turnId ? { turnId } : {}),
        ...(input.conversationTitle ? { conversationTitle: input.conversationTitle } : {}),
        ...(input.turnNo ? { turnNo: input.turnNo } : {}),
        ...(input.charLimit ? { charLimit: input.charLimit } : {}),
      })
      const results = inspected.results.map((result, index) => ({ ...result, resultNumber: index + 1, projectTitle: this.projectTitle(projectId) }))
      this.globalTraceRefs = results.map((result) => ({ projectId, turnId: result.turnId }))
      return { results, totalMatches: results.length }
    }

    const projectIds = this.resolveGlobalRetrievalProjectIds(input)
    const warnings: string[] = []
    const limit = Math.min(8, input.limit ?? 8)
    const query = input.query?.trim()
    const mode = input.mode ?? "lexical"
    const collected: Array<{ projectId: string; result: Omit<TraceRetrieveGlobalResult, "resultNumber">; rawScore: number }> = []

    if (mode === "audit" || !query) {
      for (const projectId of projectIds) {
        try {
          const projectResult = await this.retrieval.retrieveMainTrace(
            projectId,
            "",
            toMainTraceSearchInput(input),
            input.conversationId,
          )
          for (const result of projectResult.results) {
            collected.push({
              projectId,
              result: { ...result, projectTitle: this.projectTitle(projectId) },
              rawScore: 1 / (60 + result.resultNumber),
            })
          }
        } catch (error) {
          warnings.push(`${this.projectTitle(projectId)}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } else {
      for (const projectId of projectIds) {
        try {
          const ranked = await this.retrieval.search({
            projectId,
            query,
            mode,
            filters: {
              corpusKind: "trace_turn",
              scope: "project",
              ...(input.conversationId ? { conversationId: input.conversationId } : {}),
              ...(input.conversationTitle ? { conversationTitle: input.conversationTitle } : {}),
              ...(input.role ? { role: input.role } : {}),
              ...(input.createdAfter ? { createdAfter: input.createdAfter } : {}),
              ...(input.createdBefore ? { createdBefore: input.createdBefore } : {}),
            },
            limit: 8,
          })
          for (const result of ranked) {
            collected.push({
              projectId,
              result: {
                content: result.content,
                turnId: result.metadata.turnId,
                projectTitle: this.projectTitle(projectId),
                conversationTitle: result.metadata.conversationTitle,
                turnNumber: result.metadata.turnNumber,
                matchedRole: result.metadata.matchedRole as "user" | "assistant",
                status: result.metadata.status as TraceRetrieveGlobalResult["status"],
                occurredAt: result.metadata.occurredAt,
              },
              rawScore: result.rawScore,
            })
          }
        } catch (error) {
          warnings.push(`${this.projectTitle(projectId)}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    const normalized = mode !== "audit" && query
      ? normalizeScores(collected.map((candidate) => candidate.rawScore), mode === "semantic" ? "lower" : "higher")
      : collected.map((candidate) => candidate.rawScore)
    const ranked = rankDistinctParents(
      collected.map((candidate, index) => ({
        chunkId: `${candidate.projectId}:${candidate.result.turnId}`,
        parentId: `${candidate.projectId}:${candidate.result.turnId}`,
        content: candidate.result.content,
        rawScore: normalized[index] ?? 0,
        normalizedScore: normalized[index] ?? 0,
        occurredAt: candidate.result.occurredAt,
        metadata: candidate,
      })),
      { limit },
    )
    const results = ranked.map(({ metadata }, index) => ({ ...metadata.result, resultNumber: index + 1 }))
    this.globalTraceRefs = ranked.map(({ metadata }) => ({ projectId: metadata.projectId, turnId: metadata.result.turnId }))
    return { results, totalMatches: results.length, ...(warnings.length ? { warnings } : {}) }
  }

  retrieveMainToolTraces(projectId: string, conversationId: string, input: TraceRetrieveMainToolInput | TraceRetrieveToolInput) {
    return this.retrieval.retrieveMainTrace(projectId, conversationId, traceRetrieveMainToolInputSchema.parse(input))
  }

  searchMemory(projectId: string, input: MemorySearchInput, automaticFallback = false) {
    return this.retrieval.searchMemory(projectId, input, automaticFallback)
  }

  getProjectEmbeddingStatus(projectId: string) {
    const { activeJob: _retiredLegacyJob, lastError: _retiredLegacyError, ...embedding } = this.embeddings.getStatus(projectId)
    const retrieval = this.retrieval.status(projectId)
    return {
      ...embedding,
      totalDocuments: (retrieval?.traceParents ?? 0) + (retrieval?.memoryParents ?? 0),
      indexedDocuments: retrieval?.vectorReady ? (retrieval.traceParents + retrieval.memoryParents) : 0,
      pendingDocuments: retrieval?.vectorReady ? 0 : (retrieval?.traceParents ?? 0) + (retrieval?.memoryParents ?? 0),
      failedDocuments: retrieval?.status === "failed" ? (retrieval.traceParents + retrieval.memoryParents) : 0,
      retrieval: {
        status: (retrieval?.status ?? "pending") as "pending" | "rebuilding" | "ready" | "failed",
        lexicalReady: retrieval?.lexicalReady ?? false,
        vectorReady: retrieval?.vectorReady ?? false,
        qaParents: retrieval?.traceParents ?? 0,
        qaChunks: retrieval?.traceChunks ?? 0,
        memoryParents: retrieval?.memoryParents ?? 0,
        memoryChunks: retrieval?.memoryChunks ?? 0,
        ...(retrieval?.lastError ? { lastError: retrieval.lastError } : {}),
        ...(retrieval?.rebuildStartedAt ? { rebuildStartedAt: retrieval.rebuildStartedAt } : {}),
        ...(retrieval?.rebuildCompletedAt ? { rebuildCompletedAt: retrieval.rebuildCompletedAt } : {}),
        ...(retrieval?.updatedAt ? { updatedAt: retrieval.updatedAt } : {}),
      },
    }
  }

  getProjectRetrievalStatus(projectId: string) {
    return this.retrieval.status(projectId)
  }

  waitForRetrievalIdle(projectId?: string) {
    return this.retrieval.waitForIdle(projectId)
  }

  checkProjectEmbeddings(projectId: string, input: CheckProjectEmbeddingsRequest) {
    return this.embeddings.check(projectId, input)
  }

  listOllamaEmbeddingModels(input: ListOllamaEmbeddingModelsQuery = {}) {
    return this.embeddings.listOllamaModels(input)
  }

  async configureProjectEmbeddings(projectId: string, input: ConfigureProjectEmbeddingsRequest) {
    await this.embeddings.configure(projectId, input)
    this.retrieval.enqueueRebuild(projectId, "embedding_configuration_changed")
    return this.getProjectEmbeddingStatus(projectId)
  }

  reindexProjectEmbeddings(projectId: string) {
    this.embeddings.reindex(projectId)
    this.retrieval.enqueueRebuild(projectId, "manual_reindex")
    return this.getProjectEmbeddingStatus(projectId)
  }

  private resolveGlobalRetrievalProjectIds(input: TraceRetrieveGlobalSearchInput): string[] {
    const requestedIds = traceSelectorValues(input.projectId)
    if (requestedIds.length > 0) return requestedIds
    if (input.conversationId) {
      const rows = this.handle.sqlite.prepare("SELECT DISTINCT project_id AS projectId FROM conversations WHERE id = ?").all(input.conversationId) as Array<{ projectId: string }>
      return rows.map((row) => row.projectId)
    }
    const titles = traceSelectorValues(input.projectTitle)
    if (titles.length > 0) {
      const rows = this.handle.sqlite.prepare(`SELECT id FROM projects WHERE status <> 'deleted' AND LOWER(name) IN (${titles.map(() => "LOWER(?)").join(",")})`).all(...titles) as Array<{ id: string }>
      return rows.map((row) => row.id)
    }
    return (this.handle.sqlite.prepare("SELECT id FROM projects WHERE status <> 'deleted' ORDER BY updated_at DESC").all() as Array<{ id: string }>).map((row) => row.id)
  }

  private projectTitle(projectId: string): string {
    return (this.handle.sqlite.prepare("SELECT name FROM projects WHERE id = ?").get(projectId) as { name: string } | undefined)?.name ?? projectId
  }

  private resolveGlobalInspectProjectId(
    input: Extract<TraceRetrieveGlobalToolInput, { operation: "inspect" }>,
    turnId?: string,
  ): string | undefined {
    if (turnId) {
      return (this.handle.sqlite.prepare("SELECT c.project_id AS projectId FROM turns t INNER JOIN conversations c ON c.id = t.conversation_id WHERE t.id = ?").get(turnId) as { projectId: string } | undefined)?.projectId
    }
    if (input.projectTitle) {
      return (this.handle.sqlite.prepare("SELECT id FROM projects WHERE status <> 'deleted' AND LOWER(name) = LOWER(?) ORDER BY updated_at DESC LIMIT 1").get(input.projectTitle) as { id: string } | undefined)?.id
    }
    return undefined
  }

  submitFeedback(payload: FeedbackSubmitPayload): void {
    this.feedback.submitFeedback(payload)
  }

  recordError(input: RecordErrorInput): string {
    return this.errors.recordError(input)
  }

  appendEvent(input: StoreEventInput): void {
    this.events.appendEvent(input)
  }

  private primaryWorkspacePathOrUndefined(projectId: string): string | undefined {
    try {
      return this.projects.getPrimaryWorkspacePath(projectId)
    } catch {
      return undefined
    }
  }
}

const mergeModelOptions = (primary: ModelOption[], secondary: ModelOption[]): ModelOption[] => {
  const seen = new Set<string>()
  const merged: ModelOption[] = []
  for (const model of [...primary, ...secondary]) {
    const key = `${model.providerId}:${model.authMode}:${model.modelId}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    merged.push(model)
  }
  return merged
}

const traceSelectorValues = (value: string | string[] | undefined): string[] =>
  (Array.isArray(value) ? value : value ? [value] : []).map((item) => item.trim()).filter(Boolean)

const toMainTraceSearchInput = (
  input: TraceRetrieveGlobalSearchInput,
): Exclude<TraceRetrieveMainToolInput, { operation: "inspect" }> => {
  const common = {
    operation: "search" as const,
    scope: "project" as const,
    ...(input.conversationTitle ? { conversationTitle: input.conversationTitle } : {}),
    ...(input.role ? { role: input.role } : {}),
    ...(input.createdAfter ? { createdAfter: input.createdAfter } : {}),
    ...(input.createdBefore ? { createdBefore: input.createdBefore } : {}),
    ...(input.limit ? { limit: input.limit } : {}),
  }
  if (input.mode === "audit") {
    return {
      ...common,
      mode: "audit",
      query: input.query,
      ...(input.include ? { include: input.include } : {}),
      ...(input.paths ? { paths: input.paths } : {}),
      ...(input.command ? { command: input.command } : {}),
      ...(input.toolNames ? { toolNames: input.toolNames } : {}),
    }
  }
  if (input.mode === "semantic" || input.mode === "combined") {
    return { ...common, mode: input.mode, query: input.query }
  }
  return {
    ...common,
    mode: "lexical",
    ...(input.query ? { query: input.query } : {}),
    ...("turnNo" in input && input.turnNo ? { turnNo: input.turnNo } : {}),
  }
}
