import type {
  Conversation,
  ConversationCostUsage,
  Message,
  TurnUsageReport,
  Project,
  ProjectEmbeddingStatus,
  ProjectInstructions,
  ProjectResource,
  SkillSummary,
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
  skills: SkillSummary[]
  embeddingStatus?: ProjectEmbeddingStatus
}

export type CreatedTurn = {
  sessionId: string
  turnId: string
  runtimeConfigId: string
  userMessage: Message
  shouldGenerateTitle: boolean
  fallbackTitle: string
}

export type StoredModelUsage = {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  uncachedInputTokens?: number
  totalTokens?: number
  costUsd?: number
  costSource?: "provider_reported" | "computed" | "unknown"
  routedProvider?: string
  pricingSnapshot?: unknown
  providerMetadata?: unknown
  raw?: unknown
}

export type ConversationUsageReportBundle = {
  costUsage: ConversationCostUsage
  turnUsageReports: TurnUsageReport[]
}

export type ConversationModelMessage = {
  role: "user" | "assistant" | "system" | "developer"
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image"; mediaType: string; data: string; fileName?: string }
      >
  id?: string
  turnId?: string
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

export type UploadedAttachmentInput = UploadedResourceInput

export type StoreEventInput = {
  projectId?: string
  conversationId?: string
  sessionId?: string
  turnId?: string
  type: string
  source: string
  payload: unknown
}
