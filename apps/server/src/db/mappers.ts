import type { Conversation, Message, Project, ProjectResource, ProjectWorkspace, User } from "@socrates/contracts"
import type { conversations, messages, projectResources, projectWorkspaces, projects, users } from "./schema"

type UserRow = typeof users.$inferSelect
type ProjectRow = typeof projects.$inferSelect
type ProjectWorkspaceRow = typeof projectWorkspaces.$inferSelect
type ProjectResourceRow = typeof projectResources.$inferSelect
type ConversationRow = typeof conversations.$inferSelect
type MessageRow = typeof messages.$inferSelect

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

export const mapProjectResource = (row: ProjectResourceRow): ProjectResource => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  kind: row.kind as ProjectResource["kind"],
  source: row.source as ProjectResource["source"],
  status: row.status as ProjectResource["status"],
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
  status: row.status as Message["status"],
  createdAt: row.createdAt,
})
