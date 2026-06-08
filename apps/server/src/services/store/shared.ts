import type { RuntimeConfig, User, ProjectResource, ProjectWorkspace } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import type { WorkspaceMode } from "@socrates/workspace"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import type { DatabaseHandle } from "../../db/client"
import { artifacts, conversations, messages, projectResources, projectWorkspaces, projects, sessions, turnRuntimeConfigs, turns, users } from "../../db/schema"
import { mapProjectResource, mapProjectWorkspace, mapUser } from "../../db/mappers"
import type { StoreEventInput } from "./types"

export const activeTurnStatuses = ["queued", "running", "awaiting_approval"]
export const defaultConversationTitle = "New conversation"

export const deriveConversationTitle = (content: string): string => {
  const normalized = content.trim().replace(/\s+/g, " ")
  if (!normalized) {
    return "Image chat..."
  }
  if (normalized.length <= 15) {
    return normalized
  }
  return `${normalized.slice(0, 15).trimEnd()}...`
}

export type StoreContext = {
  handle: DatabaseHandle
  appendEvent: (input: StoreEventInput) => void
}

export class StoreBase {
  constructor(protected readonly context: StoreContext) {}

  protected get handle(): DatabaseHandle {
    return this.context.handle
  }

  protected appendEvent(input: StoreEventInput): void {
    this.context.appendEvent(input)
  }

  protected getCurrentUserRow(): typeof users.$inferSelect | undefined {
    return this.handle.db.select().from(users).limit(1).get()
  }

  protected requireUser(): User {
    const user = this.getCurrentUserRow()
    if (!user || !user.onboardingCompleted) {
      throw new SocratesError("user_not_onboarded", "Complete onboarding before using projects")
    }
    return mapUser(user)
  }

  protected createWorkspace(projectId: string, kind: "existing_folder" | "created_folder", workspacePath: string): ProjectWorkspace {
    const now = nowIso()
    const id = createId("pws")
    this.handle.db
      .insert(projectWorkspaces)
      .values({
        id,
        projectId,
        kind,
        path: workspacePath,
        isPrimary: true,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run()

    this.appendEvent({
      projectId,
      type: "project.workspace.attached",
      source: "server",
      payload: { projectId, workspaceId: id, path: workspacePath },
    })

    const row = this.getPrimaryWorkspaceRow(projectId)
    if (!row) {
      throw new SocratesError("project_workspace_not_found", "Workspace was not found after creation")
    }
    return mapProjectWorkspace(row)
  }

  protected workspaceKindFromCreationMode(mode: WorkspaceMode): "existing_folder" | "created_folder" {
    return mode === "existing_folder" ? "existing_folder" : "created_folder"
  }

  protected assertWorkspacePathAvailable(workspacePath: string): void {
    const existing = this.handle.db
      .select()
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.path, workspacePath), inArray(projectWorkspaces.status, ["active", "missing"])))
      .limit(1)
      .get()

    if (existing) {
      throw new SocratesError("workspace_already_attached", "This workspace folder is already attached to a project", {
        details: { workspacePath, projectId: existing.projectId },
      })
    }
  }

  protected ensureSession(projectId: string, conversationId: string): string {
    const existing = this.handle.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.projectId, projectId), eq(sessions.conversationId, conversationId), inArray(sessions.status, ["active", "idle"])))
      .orderBy(desc(sessions.createdAt))
      .limit(1)
      .get()

    if (existing) {
      this.handle.db.update(sessions).set({ status: "running", updatedAt: nowIso() }).where(eq(sessions.id, existing.id)).run()
      return existing.id
    }

    const now = nowIso()
    const id = createId("sess")
    const workspace = this.getPrimaryWorkspaceRow(projectId)
    this.handle.db
      .insert(sessions)
      .values({
        id,
        projectId,
        conversationId,
        projectWorkspaceId: workspace?.id,
        workspacePath: workspace?.path,
        workspaceName: workspace?.path?.split("/").filter(Boolean).at(-1),
        gitRepoRoot: workspace?.gitRepoRoot,
        gitBranch: workspace?.gitBranch,
        gitCommit: workspace?.gitCommit,
        status: "running",
        createdAt: now,
        updatedAt: now,
      })
      .run()

    this.appendEvent({
      projectId,
      conversationId,
      sessionId: id,
      type: "session.created",
      source: "server",
      payload: { sessionId: id, conversationId },
    })

    return id
  }

  protected insertRuntimeConfig(turnId: string, runtimeConfig: RuntimeConfig, createdAt: string): string {
    const id = createId("trc")
    this.handle.db
      .insert(turnRuntimeConfigs)
      .values({
        id,
        turnId,
        providerId: runtimeConfig.providerId,
        modelId: runtimeConfig.modelId,
        thinkingEnabled: runtimeConfig.thinkingEnabled,
        thinkingEffort: runtimeConfig.thinkingEffort,
        approvalMode: runtimeConfig.approvalMode,
        sandboxMode: runtimeConfig.sandboxMode,
        createdAt,
      })
      .run()
    return id
  }

  protected getActiveTurn(conversationId: string): typeof turns.$inferSelect | undefined {
    return this.handle.db
      .select()
      .from(turns)
      .where(and(eq(turns.conversationId, conversationId), inArray(turns.status, activeTurnStatuses)))
      .orderBy(desc(turns.startedAt))
      .limit(1)
      .get()
  }

  protected touchConversation(conversationId: string, updatedAt: string): void {
    this.handle.db.update(conversations).set({ updatedAt }).where(eq(conversations.id, conversationId)).run()
  }

  protected mustGetUserRow(id: string): typeof users.$inferSelect {
    const row = this.handle.db.select().from(users).where(eq(users.id, id)).get()
    if (!row) {
      throw new SocratesError("user_not_found", "User not found", { details: { id } })
    }
    return row
  }

  protected mustGetProjectRow(id: string): typeof projects.$inferSelect {
    const row = this.handle.db.select().from(projects).where(eq(projects.id, id)).get()
    if (!row) {
      throw new SocratesError("project_not_found", "Project not found", { details: { projectId: id } })
    }
    return row
  }

  protected getPrimaryWorkspaceRow(projectId: string): typeof projectWorkspaces.$inferSelect | undefined {
    return this.handle.db
      .select()
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.isPrimary, true)))
      .orderBy(sql`CASE WHEN ${projectWorkspaces.status} = 'active' THEN 0 ELSE 1 END`, desc(projectWorkspaces.updatedAt))
      .limit(1)
      .get()
  }

  protected mustGetPrimaryWorkspaceRow(projectId: string): typeof projectWorkspaces.$inferSelect {
    const row = this.getPrimaryWorkspaceRow(projectId)
    if (!row) {
      throw new SocratesError("project_workspace_not_found", "Project primary workspace not found", {
        details: { projectId },
      })
    }
    return row
  }

  protected mustGetResourceRow(id: string): typeof projectResources.$inferSelect {
    const row = this.handle.db.select().from(projectResources).where(eq(projectResources.id, id)).get()
    if (!row) {
      throw new SocratesError("project_resource_not_found", "Project resource not found", { details: { resourceId: id } })
    }
    return row
  }

  protected mustGetResource(id: string): ProjectResource {
    const row = this.mustGetResourceRow(id)
    const artifact = row.artifactId
      ? this.handle.db.select().from(artifacts).where(eq(artifacts.id, row.artifactId)).get()
      : null
    return mapProjectResource(row, artifact)
  }

  protected mapResourceRows(rows: Array<typeof projectResources.$inferSelect>): ProjectResource[] {
    const artifactIds = rows.flatMap((row) => (row.artifactId ? [row.artifactId] : []))
    const artifactRows =
      artifactIds.length > 0
        ? this.handle.db.select().from(artifacts).where(inArray(artifacts.id, artifactIds)).all()
        : []
    const artifactsById = new Map(artifactRows.map((artifact) => [artifact.id, artifact]))

    return rows.map((row) => mapProjectResource(row, row.artifactId ? artifactsById.get(row.artifactId) : null))
  }

  protected mustGetConversationRow(projectId: string, conversationId: string): typeof conversations.$inferSelect {
    const row = this.handle.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.projectId, projectId), eq(conversations.id, conversationId)))
      .get()
    if (!row) {
      throw new SocratesError("conversation_not_found", "Conversation not found", {
        details: { projectId, conversationId },
      })
    }
    return row
  }

  protected mustGetMessageRow(id: string): typeof messages.$inferSelect {
    const row = this.handle.db.select().from(messages).where(eq(messages.id, id)).get()
    if (!row) {
      throw new SocratesError("message_not_found", "Message not found", { details: { messageId: id } })
    }
    return row
  }
}
