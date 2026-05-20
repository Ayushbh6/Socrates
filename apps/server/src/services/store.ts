import type {
  ChatMessageSendPayload,
  CompleteOnboardingRequest,
  Conversation,
  ConversationTokenUsage,
  CreateConversationMessageRequest,
  CreateConversationRequest,
  CreateProjectRequest,
  CreateProjectResourceRequest,
  FeedbackSubmitPayload,
  Message,
  PatchProjectRequest,
  PickWorkspaceFolderRequest,
  PickWorkspaceFolderResponse,
  Project,
  ProjectInstructions,
  ProjectResource,
  ProjectWorkspace,
  UpdateConversationRequest,
  UpsertProjectInstructionsRequest,
  User,
} from "@socrates/contracts"
import type { DatabaseHandle } from "../db/client"
import { ApprovalStore } from "./store/approvalStore"
import { ConversationStore } from "./store/conversationStore"
import { ErrorStore, type RecordErrorInput } from "./store/errorStore"
import { EventStore } from "./store/eventStore"
import { FeedbackStore } from "./store/feedbackStore"
import { InstructionStore } from "./store/instructionStore"
import { ModelTelemetryStore } from "./store/modelTelemetryStore"
import { ProjectStore } from "./store/projectStore"
import { ResourceStore } from "./store/resourceStore"
import type { StoreContext } from "./store/shared"
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

  constructor(private readonly handle: DatabaseHandle) {
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

  listProjects(): ProjectListItem[] {
    return this.projects.listProjects()
  }

  createProject(input: CreateProjectRequest): { project: Project; primaryWorkspace: ProjectWorkspace } {
    return this.projects.createProject(input)
  }

  getProjectDashboard(projectId: string): ProjectDashboard {
    return this.projects.getProjectDashboard(projectId)
  }

  getAgentContext(projectId: string): AgentContext {
    return this.projects.getAgentContext(projectId)
  }

  patchProject(projectId: string, input: PatchProjectRequest): Project {
    return this.projects.patchProject(projectId, input)
  }

  listResources(projectId: string): ProjectResource[] {
    return this.resources.listResources(projectId)
  }

  createResource(projectId: string, input: CreateProjectResourceRequest): ProjectResource {
    return this.resources.createResource(projectId, input)
  }

  createUploadedResources(projectId: string, inputs: UploadedResourceInput[]): ProjectResource[] {
    return this.resources.createUploadedResources(projectId, inputs)
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
  ): { conversation: Conversation; messages: Message[]; tokenUsage: ConversationTokenUsage } {
    return this.conversations.getConversation(projectId, conversationId)
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
  }): void {
    this.modelTelemetry.recordContextUsageSnapshot(input)
  }

  getConversationTokenUsage(conversationId: string): ConversationTokenUsage {
    return this.modelTelemetry.getConversationTokenUsage(conversationId)
  }

  completePlaceholderTurn(projectId: string, conversationId: string, turnId: string): Message | null {
    return this.turns.completePlaceholderTurn(projectId, conversationId, turnId)
  }

  cancelTurn(turnId: string, reason?: string): { projectId: string; conversationId: string; sessionId: string; turnId: string } {
    return this.turns.cancelTurn(turnId, reason)
  }

  resolveApproval(approvalId: string, decision: "approved" | "rejected", reason?: string): void {
    this.approvals.resolveApproval(approvalId, decision, reason)
  }

  submitFeedback(payload: FeedbackSubmitPayload): void {
    this.feedback.submitFeedback(payload)
  }

  recordError(input: RecordErrorInput): void {
    this.errors.recordError(input)
  }

  appendEvent(input: StoreEventInput): void {
    this.events.appendEvent(input)
  }
}
