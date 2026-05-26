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
  ConversationContextUsage,
  ConversationPartialTurn,
  ConversationTokenUsage,
  ConversationToolRun,
  CreateConversationMessageRequest,
  CreateConversationRequest,
  CreateProjectRequest,
  CreateProjectResourceRequest,
  CheckProjectEmbeddingsRequest,
  ConfigureProjectEmbeddingsRequest,
  FeedbackSubmitPayload,
  Message,
  PatchProjectRequest,
  InspectWorkspaceRequest,
  InspectWorkspaceResponse,
  PickWorkspaceFolderRequest,
  PickWorkspaceFolderResponse,
  Project,
  ProjectInstructions,
  ProjectResource,
  ProjectWorkspace,
  TraceRetrieveToolInput,
  UpdateProjectWorkspaceRequest,
  UpdateProjectWorkspaceResponse,
  UpdateConversationRequest,
  UpsertProjectInstructionsRequest,
  User,
} from "@socrates/contracts"
import { createDefaultEmbeddingProvider, type EmbeddingProvider, type ProviderCredentialResolver } from "@socrates/providers"
import type { DatabaseHandle } from "../db/client"
import { ApprovalStore } from "./store/approvalStore"
import { ContextCompactionStore } from "./store/contextCompactionStore"
import { ConversationStore } from "./store/conversationStore"
import { ErrorStore, type RecordErrorInput } from "./store/errorStore"
import { EventStore } from "./store/eventStore"
import { EmbeddingStore } from "./store/embeddingStore"
import { FeedbackStore } from "./store/feedbackStore"
import { InstructionStore } from "./store/instructionStore"
import { ModelTelemetryStore } from "./store/modelTelemetryStore"
import { ProjectStore } from "./store/projectStore"
import { ResourceStore } from "./store/resourceStore"
import type { StoreContext } from "./store/shared"
import { TraceStore } from "./store/traceStore"
import { ToolStore } from "./store/toolStore"
import { TurnStore } from "./store/turnStore"
import type {
  AgentContext,
  ConversationModelMessage,
  CreatedTurn,
  ProjectDashboard,
  ProjectListItem,
  StoreEventInput,
  StoredModelUsage,
  UploadedResourceInput,
} from "./store/types"
import { UserStore } from "./store/userStore"

export type {
  AgentContext,
  ConversationModelMessage,
  CreatedTurn,
  ProjectDashboard,
  ProjectListItem,
  StoreEventInput,
  StoredModelUsage,
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
  private readonly feedback: FeedbackStore
  private readonly tools: ToolStore
  private readonly traces: TraceStore
  private readonly embeddings: EmbeddingStore
  private readonly contextCompactions: ContextCompactionStore

  constructor(
    private readonly handle: DatabaseHandle,
    embeddingProvider?: EmbeddingProvider,
    credentials?: ProviderCredentialResolver,
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
    this.turns = new TurnStore(context, this.errors)
    this.approvals = new ApprovalStore(context)
    this.feedback = new FeedbackStore(context)
    this.tools = new ToolStore(context)
    this.embeddings = new EmbeddingStore(context, embeddingProvider ?? createDefaultEmbeddingProvider(credentials), credentials)
    this.traces = new TraceStore(context, this.embeddings)
    this.contextCompactions = new ContextCompactionStore(context, this.errors)
  }

  close(): void {
    this.handle.close()
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
    return this.projects.createProject(input)
  }

  getProjectDashboard(projectId: string): ProjectDashboard {
    return {
      ...this.projects.getProjectDashboard(projectId),
      embeddingStatus: this.embeddings.getStatus(projectId),
    }
  }

  getAgentContext(projectId: string): AgentContext {
    return this.projects.getAgentContext(projectId)
  }

  getPrimaryWorkspacePath(projectId: string): string {
    return this.projects.getPrimaryWorkspacePath(projectId)
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
    partialTurns?: ConversationPartialTurn[]
    tokenUsage: ConversationTokenUsage
    contextUsage?: ConversationContextUsage
  } {
    const conversation = this.conversations.getConversation(projectId, conversationId)
    return {
      ...conversation,
      toolRuns: this.tools.getConversationToolRuns(conversationId),
    }
  }

  createConversationUserMessage(
    projectId: string,
    conversationId: string,
    input: CreateConversationMessageRequest,
  ): { conversation: Conversation; message: Message } {
    return this.conversations.createConversationUserMessage(projectId, conversationId, input)
  }

  deleteConversation(projectId: string, conversationId: string): { deletedConversationId: string } {
    return this.conversations.deleteConversation(projectId, conversationId)
  }

  createTurnFromUserMessage(projectId: string, conversationId: string, payload: ChatMessageSendPayload): CreatedTurn {
    return this.turns.createTurnFromUserMessage(projectId, conversationId, payload)
  }

  getConversationModelMessages(projectId: string, conversationId: string): ConversationModelMessage[] {
    return this.conversations.getConversationModelMessages(projectId, conversationId)
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

  completeModelCall(input: { modelCallId: string; response: unknown; usage?: StoredModelUsage }): void {
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
      this.traces.indexCompactionSnapshot(completed)
    }
  }

  failContextCompactionSnapshot(input: FailCompactionSnapshotInput): string {
    return this.contextCompactions.fail(input)
  }

  getConversationTokenUsage(conversationId: string): ConversationTokenUsage {
    return this.modelTelemetry.getConversationTokenUsage(conversationId)
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

  completeShellCommand(toolCallId: string, input: Parameters<ToolStore["completeShellCommand"]>[1]): void {
    this.tools.completeShellCommand(toolCallId, input)
  }

  failShellCommand(toolCallId: string): void {
    this.tools.failShellCommand(toolCallId)
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
}
