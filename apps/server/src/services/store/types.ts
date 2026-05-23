import type {
  Conversation,
  Message,
  Project,
  ProjectInstructions,
  ProjectResource,
  ProjectWorkspace,
} from "@socrates/contracts"

export type ProjectListItem = {
  project: Project
  primaryWorkspace: ProjectWorkspace
  conversationCount: number
  lastActivityAt?: string
}

export type ProjectDashboard = {
  project: Project
  primaryWorkspace: ProjectWorkspace
  resources: ProjectResource[]
  conversations: Conversation[]
  instructions?: ProjectInstructions
}

export type CreatedTurn = {
  sessionId: string
  turnId: string
  runtimeConfigId: string
  userMessage: Message
}

export type StoredModelUsage = {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  totalTokens?: number
  raw?: unknown
}

export type ConversationModelMessage = {
  role: "user" | "assistant" | "system" | "developer"
  content: string
}

export type AgentContext = {
  userDisplayName: string
  projectName: string
  projectDescription?: string
  projectInstructions?: string
  workspaceGuidance?: string
}

export type UploadedResourceInput = {
  originalName: string
  data: Buffer
  mimeType?: string
}

export type StoreEventInput = {
  projectId?: string
  conversationId?: string
  sessionId?: string
  turnId?: string
  type: string
  source: string
  payload: unknown
}
