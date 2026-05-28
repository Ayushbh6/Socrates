import type { Conversation, Message, MessageAttachment, Project, ProjectInstructions, ProjectResource, ProjectWorkspace, User } from "@socrates/contracts"
import type { artifacts, conversations, messageAttachments, messages, projectInstructions, projectResources, projectWorkspaces, projects, users } from "./schema"

type UserRow = typeof users.$inferSelect
type ProjectRow = typeof projects.$inferSelect
type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect
type ProjectResourceRow = typeof projectResources.$inferSelect
type ProjectInstructionsRow = typeof projectInstructions.$inferSelect
type ArtifactRow = typeof artifacts.$inferSelect
type ConversationRow = typeof conversations.$inferSelect
type MessageRow = typeof messages.$inferSelect
type MessageAttachmentRow = typeof messageAttachments.$inferSelect

const parseMessageMetadata = (
  metadataJson: string | null,
): { reasoning?: string; partial?: boolean; cancelled?: boolean; cancellationReason?: string } => {
  if (!metadataJson) {
    return {}
  }

  try {
    const parsed = JSON.parse(metadataJson) as {
      reasoning?: unknown
      partial?: unknown
      cancelled?: unknown
      cancellationReason?: unknown
      reason?: unknown
    }
    return {
      ...(typeof parsed.reasoning === "string" && parsed.reasoning.length > 0 ? { reasoning: parsed.reasoning } : {}),
      ...(parsed.partial === true ? { partial: true } : {}),
      ...(parsed.cancelled === true ? { cancelled: true } : {}),
      ...(typeof parsed.cancellationReason === "string"
        ? { cancellationReason: parsed.cancellationReason }
        : typeof parsed.reason === "string"
          ? { cancellationReason: parsed.reason }
          : {}),
    }
  } catch {
    return {}
  }
}

export const mapUser = (row: UserRow): User => ({
  id: row.id,
  displayName: row.displayName,
  onboardingCompleted: row.onboardingCompleted,
})

export const mapProject = (row: ProjectRow): Project => ({
  id: row.id,
  userId: row.userId,
  name: row.name,
  ...(row.description ? { description: row.description } : {}),
  status: row.status as Project["status"],
  updatedAt: row.updatedAt,
})

export const mapProjectWorkspace = (row: ProjectWorkspaceRow): ProjectWorkspace => ({
  id: row.id,
  projectId: row.projectId,
  kind: row.kind as ProjectWorkspace["kind"],
  ...(row.path ? { path: row.path } : {}),
  ...(row.gitRepoRoot ? { gitRepoRoot: row.gitRepoRoot } : {}),
  ...(row.gitBranch ? { gitBranch: row.gitBranch } : {}),
  isPrimary: row.isPrimary,
  status: row.status as ProjectWorkspace["status"],
})

export const mapProjectResource = (row: ProjectResourceRow, artifact?: ArtifactRow | null): ProjectResource => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  kind: row.kind as ProjectResource["kind"],
  source: row.source as ProjectResource["source"],
  ...(row.uri ? { uri: row.uri } : {}),
  ...(artifact?.sizeBytes === null || artifact?.sizeBytes === undefined ? {} : { sizeBytes: artifact.sizeBytes }),
  ...(artifact?.mimeType ? { mimeType: artifact.mimeType } : {}),
  status: row.status as ProjectResource["status"],
})

export const mapProjectInstructions = (row: ProjectInstructionsRow): ProjectInstructions => ({
  id: row.id,
  projectId: row.projectId,
  content: row.content,
  updatedAt: row.updatedAt,
})

export const mapConversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  projectId: row.projectId,
  ...(row.title ? { title: row.title } : {}),
  status: row.status as Conversation["status"],
  updatedAt: row.updatedAt,
})

export const mapMessage = (row: MessageRow): Message => ({
  id: row.id,
  conversationId: row.conversationId,
  sessionId: row.sessionId,
  ...(row.turnId ? { turnId: row.turnId } : {}),
  role: row.role as Message["role"],
  content: row.content,
  ...parseMessageMetadata(row.metadataJson),
  status: row.status as Message["status"],
  createdAt: row.createdAt,
})

export const mapMessageAttachment = (row: MessageAttachmentRow): MessageAttachment => ({
  id: row.id,
  projectId: row.projectId,
  conversationId: row.conversationId,
  ...(row.sessionId ? { sessionId: row.sessionId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  ...(row.messageId ? { messageId: row.messageId } : {}),
  artifactId: row.artifactId,
  kind: row.kind as MessageAttachment["kind"],
  fileName: row.fileName,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  uri: row.uri,
  url: `/api/projects/${encodeURIComponent(row.projectId)}/conversations/${encodeURIComponent(row.conversationId)}/attachments/${encodeURIComponent(row.id)}/content`,
  status: row.status as MessageAttachment["status"],
  createdAt: row.createdAt,
})
