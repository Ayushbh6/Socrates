import type {
  CompleteCompactionSnapshotInput,
  ContextCompactionSummary,
  FailCompactionSnapshotInput,
  StartCompactionSnapshotInput,
} from "@socrates/core"
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
  UpdateMemoryAgentGlobalSettingsRequest,
  UpdateMemoryAgentGlobalSettingsResponse,
  UpdateWorkerModelSettingsRequest,
  UpdateWorkerModelSettingsResponse,
  MemoryAgentFileContentQuery,
  MemoryNoteToolInput,
  MemoryNoteToolOutput,
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
  SkillsToolInput,
  SkillsToolOutput,
  SoulToolInput,
  SoulToolOutput,
  ToolDocsToolInput,
  ToolDocsToolOutput,
  TraceRetrieveToolInput,
  UserProfileToolInput,
  UserProfileToolOutput,
  UpdateProjectWorkspaceRequest,
  UpdateProjectWorkspaceResponse,
  UpdateConversationRequest,
  UpsertProjectInstructionsRequest,
  User,
  ServerEvent,
  WorkerModelRole,
  WorkerModelSettings,
} from "@socrates/contracts"
import { AiSdkProvider, createDefaultEmbeddingProvider, type EmbeddingProvider, type ModelProvider, type ProviderCredentialResolver } from "@socrates/providers"
import type { DatabaseHandle } from "../db/client"
import { ApprovalStore } from "./store/approvalStore"
import { AttachmentStore } from "./store/attachmentStore"
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
  private readonly traces: TraceStore
  private readonly memory: MemoryStore
  private readonly memoryAgentSettings: MemoryAgentGlobalSettingsStore
  private readonly workerModelSettings: WorkerModelSettingsStore
  private readonly notifications: NotificationStore
  private readonly embeddings: EmbeddingStore
  private readonly contextCompactions: ContextCompactionStore
  private memoryAgentScheduler: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly handle: DatabaseHandle,
    embeddingProvider?: EmbeddingProvider,
    credentials?: ProviderCredentialResolver,
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
    this.embeddings = new EmbeddingStore(context, embeddingProvider ?? createDefaultEmbeddingProvider(credentials), credentials)
    this.traces = new TraceStore(context, this.embeddings)
    this.notifications = new NotificationStore(context)
    this.memoryAgentSettings = new MemoryAgentGlobalSettingsStore(context)
    this.workerModelSettings = new WorkerModelSettingsStore(context)
    const memoryOptions = {
      ...(options.socratesHome ? { socratesHome: options.socratesHome } : {}),
      ...(options.memoryProvider ? { provider: options.memoryProvider } : credentials ? { provider: new AiSdkProvider(credentials) } : {}),
      ...(credentials ? { credentials } : {}),
      traceRetrieve: (projectId: string, conversationId: string, input: TraceRetrieveToolInput) => this.traces.retrieve(projectId, conversationId, input),
      traceRetrieveGlobal: (input: TraceRetrieveToolInput) => this.traces.retrieveGlobal(input),
      getMemoryAgentGlobalSettings: () => this.memoryAgentSettings.ensureSettings(),
      getWorkerModelSettings: (workerId: WorkerModelRole) => this.workerModelSettings.ensureSetting(workerId),
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
    await this.embeddings.dispose()
    this.handle.close()
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
      embeddingStatus: this.embeddings.getStatus(projectId),
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

  async buildGlobalSkill(input: BuildGlobalSkillRequest): Promise<BuildGlobalSkillResponse> {
    return { skill: await this.memory.buildGlobalSkill(input.request, input.name) }
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
    const state = this.memoryAgentSettings.ensureState()
    return {
      settings,
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
    return { settings: this.memoryAgentSettings.updateSettings(input) }
  }

  listWorkerModelSettings(): { settings: WorkerModelSettings[] } {
    return { settings: this.workerModelSettings.ensureAll() }
  }

  getWorkerModelSetting(workerId: WorkerModelRole): WorkerModelSettings {
    return this.workerModelSettings.ensureSetting(workerId)
  }

  updateWorkerModelSettings(workerId: WorkerModelRole, input: UpdateWorkerModelSettingsRequest): UpdateWorkerModelSettingsResponse {
    return { settings: this.workerModelSettings.updateSetting(workerId, input) }
  }

  async runGlobalMemoryAgent(trigger: "scheduled" | "manual" = "manual"): Promise<TriggerMemoryAgentRunResponse> {
    return this.memory.runGlobalMemoryAgent({
      trigger,
      settings: this.memoryAgentSettings.ensureSettings(),
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
    return this.conversations.deleteConversation(projectId, conversationId)
  }

  createTurnFromUserMessage(projectId: string, conversationId: string, payload: ChatMessageSendPayload): CreatedTurn {
    return this.turns.createTurnFromUserMessage(projectId, conversationId, payload)
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
    this.embeddings.enqueueTurn(projectId, conversationId, turnId)
  }

  retrieveToolTraces(projectId: string, conversationId: string, input: TraceRetrieveToolInput) {
    return this.traces.retrieve(projectId, conversationId, input)
  }

  getProjectEmbeddingStatus(projectId: string) {
    return this.embeddings.getStatus(projectId)
  }

  checkProjectEmbeddings(projectId: string, input: CheckProjectEmbeddingsRequest) {
    return this.embeddings.check(projectId, input)
  }

  configureProjectEmbeddings(projectId: string, input: ConfigureProjectEmbeddingsRequest) {
    return this.embeddings.configure(projectId, input)
  }

  reindexProjectEmbeddings(projectId: string) {
    return this.embeddings.reindex(projectId)
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
