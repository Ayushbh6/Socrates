import type {
  ChatMessageSendPayload,
  CompleteOnboardingRequest,
  Conversation,
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
  RuntimeConfig,
  UpsertProjectInstructionsRequest,
  User,
} from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import {
  ensureWorkspaceScaffold,
  inferResourceKind,
  pickWorkspaceFolder,
  storeResourceFile,
  type WorkspaceMode,
} from "@socrates/workspace"
import { and, count, desc, eq, inArray } from "drizzle-orm"
import type { DatabaseHandle } from "../db/client"
import {
  artifacts,
  approvals,
  conversations,
  errors,
  events,
  messageFeedback,
  messages,
  projectInstructions,
  projectResources,
  projectWorkspaces,
  projects,
  sessions,
  turnRuntimeConfigs,
  turns,
  users,
} from "../db/schema"
import {
  mapConversation,
  mapMessage,
  mapProject,
  mapProjectInstructions,
  mapProjectResource,
  mapProjectWorkspace,
  mapUser,
} from "../db/mappers"

const activeTurnStatuses = ["queued", "running", "awaiting_approval"]

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
  userMessage: Message
}

export type UploadedResourceInput = {
  originalName: string
  data: Buffer
  mimeType?: string
}

export class SocratesStore {
  constructor(private readonly handle: DatabaseHandle) {}

  close(): void {
    this.handle.close()
  }

  getCurrentUser(): User | null {
    const row = this.handle.db.select().from(users).limit(1).get()
    return row ? mapUser(row) : null
  }

  completeOnboarding(input: CompleteOnboardingRequest): User {
    const existing = this.handle.db.select().from(users).limit(1).get()
    const now = nowIso()

    if (existing) {
      this.handle.db
        .update(users)
        .set({
          displayName: input.displayName,
          onboardingCompleted: true,
          updatedAt: now,
          onboardedAt: existing.onboardedAt ?? now,
        })
        .where(eq(users.id, existing.id))
        .run()

      const updated = this.handle.db.select().from(users).where(eq(users.id, existing.id)).get()
      if (!updated) {
        throw new SocratesError("user_not_found", "User was not found after onboarding update")
      }
      this.appendEvent({
        type: "user.updated",
        source: "server",
        payload: { userId: updated.id },
      })
      return mapUser(updated)
    }

    const id = createId("user")
    this.handle.db
      .insert(users)
      .values({
        id,
        displayName: input.displayName,
        onboardingCompleted: true,
        createdAt: now,
        updatedAt: now,
        onboardedAt: now,
      })
      .run()

    this.appendEvent({
      type: "user.onboarding.completed",
      source: "server",
      payload: { userId: id },
    })

    return mapUser(this.mustGetUserRow(id))
  }

  async pickWorkspaceFolder(input: PickWorkspaceFolderRequest): Promise<PickWorkspaceFolderResponse> {
    return pickWorkspaceFolder(input)
  }

  listProjects(): ProjectListItem[] {
    const user = this.requireUser()
    const projectRows = this.handle.db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, user.id), inArray(projects.status, ["active", "archived"])))
      .orderBy(desc(projects.updatedAt))
      .all()

    return projectRows.map((projectRow) => {
      const workspaceRow = this.mustGetPrimaryWorkspaceRow(projectRow.id)
      const conversationCountRow = this.handle.db
        .select({ value: count() })
        .from(conversations)
        .where(and(eq(conversations.projectId, projectRow.id), inArray(conversations.status, ["active", "archived"])))
        .get()
      const latestConversation = this.handle.db
        .select({ updatedAt: conversations.updatedAt })
        .from(conversations)
        .where(eq(conversations.projectId, projectRow.id))
        .orderBy(desc(conversations.updatedAt))
        .limit(1)
        .get()

      return {
        project: mapProject(projectRow),
        primaryWorkspace: mapProjectWorkspace(workspaceRow),
        conversationCount: conversationCountRow?.value ?? 0,
        ...(latestConversation ? { lastActivityAt: latestConversation.updatedAt } : {}),
      }
    })
  }

  createProject(input: CreateProjectRequest): { project: Project; primaryWorkspace: ProjectWorkspace } {
    const user = this.requireUser()
    const now = nowIso()
    const projectId = createId("proj")
    const workspaceKind = this.workspaceKindFromCreationMode(input.creationMode)
    const scaffold = ensureWorkspaceScaffold({
      workspacePath: input.workspacePath,
      mode: input.creationMode,
    })
    this.assertWorkspacePathAvailable(scaffold.workspacePath)

    this.handle.db
      .insert(projects)
      .values({
        id: projectId,
        userId: user.id,
        name: input.name,
        description: input.description,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const primaryWorkspace = this.createWorkspace(projectId, workspaceKind, scaffold.workspacePath)

    this.appendEvent({
      projectId,
      type: "project.created",
      source: "server",
      payload: { projectId },
    })

    return {
      project: mapProject(this.mustGetProjectRow(projectId)),
      primaryWorkspace,
    }
  }

  getProjectDashboard(projectId: string): ProjectDashboard {
    const project = mapProject(this.mustGetProjectRow(projectId))
    const workspaceRow = this.mustGetPrimaryWorkspaceRow(projectId)
    const resourceRows = this.handle.db.select().from(projectResources).where(eq(projectResources.projectId, projectId)).all()
    const conversationRows = this.handle.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.projectId, projectId), inArray(conversations.status, ["active", "archived"])))
      .orderBy(desc(conversations.updatedAt))
      .all()
    const instructionRow = this.handle.db
      .select()
      .from(projectInstructions)
      .where(and(eq(projectInstructions.projectId, projectId), eq(projectInstructions.status, "active")))
      .orderBy(desc(projectInstructions.updatedAt))
      .limit(1)
      .get()

    return {
      project,
      primaryWorkspace: mapProjectWorkspace(workspaceRow),
      resources: this.mapResourceRows(resourceRows),
      conversations: conversationRows.map(mapConversation),
      ...(instructionRow ? { instructions: mapProjectInstructions(instructionRow) } : {}),
    }
  }

  patchProject(projectId: string, input: PatchProjectRequest): Project {
    this.mustGetProjectRow(projectId)
    const now = nowIso()
    this.handle.db
      .update(projects)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
        updatedAt: now,
        ...(input.status === "archived" ? { archivedAt: now } : {}),
      })
      .where(eq(projects.id, projectId))
      .run()

    this.appendEvent({
      projectId,
      type: "project.updated",
      source: "server",
      payload: { projectId },
    })

    return mapProject(this.mustGetProjectRow(projectId))
  }

  listResources(projectId: string): ProjectResource[] {
    this.mustGetProjectRow(projectId)
    const rows = this.handle.db
      .select()
      .from(projectResources)
      .where(eq(projectResources.projectId, projectId))
      .orderBy(desc(projectResources.updatedAt))
      .all()
    return this.mapResourceRows(rows)
  }

  createResource(projectId: string, input: CreateProjectResourceRequest): ProjectResource {
    this.mustGetProjectRow(projectId)
    const now = nowIso()
    const id = createId("pres")

    this.handle.db
      .insert(projectResources)
      .values({
        id,
        projectId,
        name: input.name,
        kind: input.kind,
        source: input.source,
        uri: input.uri,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run()

    this.appendEvent({
      projectId,
      type: "project.resource.created",
      source: "server",
      payload: { projectId, resourceId: id },
    })

    return this.mustGetResource(id)
  }

  createUploadedResources(projectId: string, inputs: UploadedResourceInput[]): ProjectResource[] {
    if (inputs.length === 0) {
      throw new SocratesError("resource_file_required", "Upload at least one file to add project resources")
    }
    if (inputs.length > 10) {
      throw new SocratesError("resource_upload_limit_exceeded", "Upload up to 10 files at once", {
        details: { maxFiles: 10, receivedFiles: inputs.length },
        recoverable: true,
      })
    }

    this.mustGetProjectRow(projectId)
    const workspace = this.mustGetPrimaryWorkspaceRow(projectId)
    if (!workspace.path) {
      throw new SocratesError("project_workspace_path_missing", "Project does not have a primary workspace path", {
        details: { projectId },
      })
    }

    const now = nowIso()
    const resourceIds: string[] = []

    for (const input of inputs) {
      const stored = storeResourceFile({
        workspacePath: workspace.path,
        originalName: input.originalName,
        data: input.data,
      })
      const artifactId = createId("art")
      const resourceId = createId("pres")

      this.handle.db
        .insert(artifacts)
        .values({
          id: artifactId,
          projectId,
          kind: "file",
          path: stored.path,
          mimeType: input.mimeType,
          sizeBytes: input.data.byteLength,
          createdAt: now,
        })
        .run()

      this.handle.db
        .insert(projectResources)
        .values({
          id: resourceId,
          projectId,
          artifactId,
          name: stored.fileName,
          kind: inferResourceKind(stored.fileName),
          source: "uploaded",
          uri: stored.path,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run()

      resourceIds.push(resourceId)
      this.appendEvent({
        projectId,
        type: "project.resource.created",
        source: "server",
        payload: { projectId, resourceId, artifactId, uri: stored.path },
      })
    }

    return resourceIds.map((resourceId) => this.mustGetResource(resourceId))
  }

  upsertProjectInstructions(projectId: string, input: UpsertProjectInstructionsRequest): ProjectInstructions {
    this.mustGetProjectRow(projectId)
    const now = nowIso()
    const existing = this.handle.db
      .select()
      .from(projectInstructions)
      .where(and(eq(projectInstructions.projectId, projectId), eq(projectInstructions.status, "active")))
      .orderBy(desc(projectInstructions.updatedAt))
      .limit(1)
      .get()

    const id = existing?.id ?? createId("pins")
    if (existing) {
      this.handle.db
        .update(projectInstructions)
        .set({
          content: input.content,
          updatedAt: now,
        })
        .where(eq(projectInstructions.id, existing.id))
        .run()
    } else {
      this.handle.db
        .insert(projectInstructions)
        .values({
          id,
          projectId,
          content: input.content,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }

    this.appendEvent({
      projectId,
      type: "project.instructions.updated",
      source: "server",
      payload: { projectId, instructionsId: id },
    })

    return mapProjectInstructions(this.mustGetInstructionsRow(id))
  }

  listConversations(projectId: string): Conversation[] {
    this.mustGetProjectRow(projectId)
    return this.handle.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.projectId, projectId), inArray(conversations.status, ["active", "archived"])))
      .orderBy(desc(conversations.updatedAt))
      .all()
      .map(mapConversation)
  }

  createConversation(projectId: string, input: CreateConversationRequest): Conversation {
    const project = this.mustGetProjectRow(projectId)
    const now = nowIso()
    const id = createId("conv")

    this.handle.db
      .insert(conversations)
      .values({
        id,
        projectId,
        userId: project.userId,
        title: input.title,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run()

    this.appendEvent({
      projectId,
      conversationId: id,
      type: "conversation.created",
      source: "server",
      payload: { projectId, conversationId: id },
    })

    return mapConversation(this.mustGetConversationRow(projectId, id))
  }

  getConversation(projectId: string, conversationId: string): { conversation: Conversation; messages: Message[] } {
    const conversation = mapConversation(this.mustGetConversationRow(projectId, conversationId))
    const rows = this.handle.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt)
      .all()

    return {
      conversation,
      messages: rows.map(mapMessage),
    }
  }

  createTurnFromUserMessage(
    projectId: string,
    conversationId: string,
    payload: ChatMessageSendPayload,
  ): CreatedTurn {
    const conversation = this.mustGetConversationRow(projectId, conversationId)
    const activeTurn = this.getActiveTurn(conversationId)
    if (activeTurn) {
      throw new SocratesError("turn_already_active", "This conversation already has an active turn", {
        details: { activeTurnId: activeTurn.id },
        recoverable: true,
      })
    }

    const now = nowIso()
    const sessionId = this.ensureSession(projectId, conversationId)
    const turnId = createId("turn")
    const messageId = payload.clientMessageId

    this.handle.db
      .insert(messages)
      .values({
        id: messageId,
        conversationId,
        sessionId,
        turnId,
        role: "user",
        content: payload.content,
        contentFormat: "markdown",
        status: "completed",
        createdAt: now,
        completedAt: now,
      })
      .run()

    this.handle.db
      .insert(turns)
      .values({
        id: turnId,
        sessionId,
        conversationId,
        userMessageId: messageId,
        status: "running",
        startedAt: now,
      })
      .run()

    this.insertRuntimeConfig(turnId, payload.runtimeConfig, now)
    this.touchConversation(conversation.id, now)

    const userMessage = mapMessage(this.mustGetMessageRow(messageId))
    this.appendEvent({
      projectId,
      conversationId,
      sessionId,
      turnId,
      type: "turn.started",
      source: "server",
      payload: { turnId, userMessage },
    })

    return { sessionId, turnId, userMessage }
  }

  completePlaceholderTurn(projectId: string, conversationId: string, turnId: string): Message | null {
    const turn = this.handle.db.select().from(turns).where(eq(turns.id, turnId)).get()
    if (!turn || turn.status !== "running") {
      return null
    }

    const now = nowIso()
    const messageId = createId("msg")
    const content = "Socrates backend skeleton received the message. Model execution will be added in a later sprint."

    this.handle.db
      .insert(messages)
      .values({
        id: messageId,
        conversationId,
        sessionId: turn.sessionId,
        turnId,
        role: "assistant",
        content,
        contentFormat: "markdown",
        status: "completed",
        createdAt: now,
        completedAt: now,
      })
      .run()

    this.handle.db
      .update(turns)
      .set({
        assistantMessageId: messageId,
        status: "completed",
        completedAt: now,
      })
      .where(eq(turns.id, turnId))
      .run()

    this.touchConversation(conversationId, now)
    return mapMessage(this.mustGetMessageRow(messageId))
  }

  cancelTurn(turnId: string, reason?: string): { projectId: string; conversationId: string; sessionId: string; turnId: string } {
    const turn = this.handle.db.select().from(turns).where(eq(turns.id, turnId)).get()
    if (!turn) {
      throw new SocratesError("turn_not_found", "Turn not found")
    }

    if (!activeTurnStatuses.includes(turn.status)) {
      throw new SocratesError("turn_not_active", "Turn is not active", {
        details: { turnId, status: turn.status },
      })
    }

    const session = this.handle.db.select().from(sessions).where(eq(sessions.id, turn.sessionId)).get()
    if (!session) {
      throw new SocratesError("session_not_found", "Session not found for turn", { details: { turnId } })
    }

    const now = nowIso()
    this.handle.db
      .update(turns)
      .set({
        status: "cancelled",
        cancelledAt: now,
        metadataJson: JSON.stringify({ reason }),
      })
      .where(eq(turns.id, turnId))
      .run()

    this.appendEvent({
      projectId: session.projectId,
      conversationId: turn.conversationId,
      sessionId: session.id,
      turnId,
      type: "turn.cancelled",
      source: "server",
      payload: { turnId, reason },
    })

    return {
      projectId: session.projectId,
      conversationId: turn.conversationId,
      sessionId: session.id,
      turnId,
    }
  }

  resolveApproval(approvalId: string, decision: "approved" | "rejected", reason?: string): void {
    const approval = this.handle.db.select().from(approvals).where(eq(approvals.id, approvalId)).get()
    if (!approval) {
      throw new SocratesError("approval_not_found", "Approval request not found", { details: { approvalId } })
    }

    const now = nowIso()
    this.handle.db
      .update(approvals)
      .set({
        status: decision,
        decision,
        decidedAt: now,
        metadataJson: JSON.stringify({ reason }),
      })
      .where(eq(approvals.id, approvalId))
      .run()
  }

  submitFeedback(payload: FeedbackSubmitPayload): void {
    const message = this.handle.db.select().from(messages).where(eq(messages.id, payload.messageId)).get()
    if (!message) {
      throw new SocratesError("message_not_found", "Message not found for feedback", {
        details: { messageId: payload.messageId },
      })
    }

    const now = nowIso()
    this.handle.db
      .insert(messageFeedback)
      .values({
        id: createId("fb"),
        conversationId: message.conversationId,
        sessionId: message.sessionId,
        turnId: payload.turnId ?? message.turnId,
        messageId: payload.messageId,
        modelCallId: payload.modelCallId,
        rating: payload.rating,
        reasonCode: payload.reasonCode,
        note: payload.note,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const feedbackTurnId = payload.turnId ?? message.turnId ?? undefined
    this.appendEvent({
      conversationId: message.conversationId,
      sessionId: message.sessionId,
      ...(feedbackTurnId ? { turnId: feedbackTurnId } : {}),
      type: "feedback.created",
      source: "server",
      payload,
    })
  }

  recordError(input: {
    conversationId?: string
    sessionId?: string
    turnId?: string
    source: string
    code: string
    message: string
    details?: unknown
    recoverable: boolean
  }): void {
    this.handle.db
      .insert(errors)
      .values({
        id: createId("err"),
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        source: input.source,
        code: input.code,
        message: input.message,
        detailsJson: input.details === undefined ? undefined : JSON.stringify(input.details),
        recoverable: input.recoverable,
        createdAt: nowIso(),
      })
      .run()
  }

  appendEvent(input: {
    projectId?: string
    conversationId?: string
    sessionId?: string
    turnId?: string
    type: string
    source: string
    payload: unknown
  }): void {
    const row = this.handle.sqlite.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM events").get() as {
      next_sequence: number
    }

    this.handle.db
      .insert(events)
      .values({
        id: createId("evt"),
        projectId: input.projectId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        sequence: row.next_sequence,
        type: input.type,
        source: input.source,
        payloadJson: JSON.stringify(input.payload),
        createdAt: nowIso(),
      })
      .run()
  }

  private requireUser(): User {
    const user = this.getCurrentUser()
    if (!user || !user.onboardingCompleted) {
      throw new SocratesError("user_not_onboarded", "Complete onboarding before using projects")
    }
    return user
  }

  private createWorkspace(projectId: string, kind: "existing_folder" | "created_folder", workspacePath: string): ProjectWorkspace {
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

  private workspaceKindFromCreationMode(mode: WorkspaceMode): "existing_folder" | "created_folder" {
    return mode === "existing_folder" ? "existing_folder" : "created_folder"
  }

  private assertWorkspacePathAvailable(workspacePath: string): void {
    const existing = this.handle.db
      .select()
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.path, workspacePath), inArray(projectWorkspaces.status, ["active", "missing", "detached"])))
      .limit(1)
      .get()

    if (existing) {
      throw new SocratesError("workspace_already_attached", "This workspace folder is already attached to a project", {
        details: { workspacePath, projectId: existing.projectId },
      })
    }
  }

  private ensureSession(projectId: string, conversationId: string): string {
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

  private insertRuntimeConfig(turnId: string, runtimeConfig: RuntimeConfig, createdAt: string): void {
    this.handle.db
      .insert(turnRuntimeConfigs)
      .values({
        id: createId("trc"),
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
  }

  private getActiveTurn(conversationId: string): typeof turns.$inferSelect | undefined {
    return this.handle.db
      .select()
      .from(turns)
      .where(and(eq(turns.conversationId, conversationId), inArray(turns.status, activeTurnStatuses)))
      .orderBy(desc(turns.startedAt))
      .limit(1)
      .get()
  }

  private touchConversation(conversationId: string, updatedAt: string): void {
    this.handle.db.update(conversations).set({ updatedAt }).where(eq(conversations.id, conversationId)).run()
  }

  private mustGetUserRow(id: string): typeof users.$inferSelect {
    const row = this.handle.db.select().from(users).where(eq(users.id, id)).get()
    if (!row) {
      throw new SocratesError("user_not_found", "User not found", { details: { id } })
    }
    return row
  }

  private mustGetProjectRow(id: string): typeof projects.$inferSelect {
    const row = this.handle.db.select().from(projects).where(eq(projects.id, id)).get()
    if (!row) {
      throw new SocratesError("project_not_found", "Project not found", { details: { projectId: id } })
    }
    return row
  }

  private getPrimaryWorkspaceRow(projectId: string): typeof projectWorkspaces.$inferSelect | undefined {
    return this.handle.db
      .select()
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.isPrimary, true)))
      .limit(1)
      .get()
  }

  private mustGetPrimaryWorkspaceRow(projectId: string): typeof projectWorkspaces.$inferSelect {
    const row = this.getPrimaryWorkspaceRow(projectId)
    if (!row) {
      throw new SocratesError("project_workspace_not_found", "Project primary workspace not found", {
        details: { projectId },
      })
    }
    return row
  }

  private mustGetResourceRow(id: string): typeof projectResources.$inferSelect {
    const row = this.handle.db.select().from(projectResources).where(eq(projectResources.id, id)).get()
    if (!row) {
      throw new SocratesError("project_resource_not_found", "Project resource not found", { details: { resourceId: id } })
    }
    return row
  }

  private mustGetResource(id: string): ProjectResource {
    const row = this.mustGetResourceRow(id)
    const artifact = row.artifactId
      ? this.handle.db.select().from(artifacts).where(eq(artifacts.id, row.artifactId)).get()
      : null
    return mapProjectResource(row, artifact)
  }

  private mapResourceRows(rows: Array<typeof projectResources.$inferSelect>): ProjectResource[] {
    const artifactIds = rows.flatMap((row) => (row.artifactId ? [row.artifactId] : []))
    const artifactRows =
      artifactIds.length > 0
        ? this.handle.db.select().from(artifacts).where(inArray(artifacts.id, artifactIds)).all()
        : []
    const artifactsById = new Map(artifactRows.map((artifact) => [artifact.id, artifact]))

    return rows.map((row) => mapProjectResource(row, row.artifactId ? artifactsById.get(row.artifactId) : null))
  }

  private mustGetInstructionsRow(id: string): typeof projectInstructions.$inferSelect {
    const row = this.handle.db.select().from(projectInstructions).where(eq(projectInstructions.id, id)).get()
    if (!row) {
      throw new SocratesError("project_instructions_not_found", "Project instructions not found", {
        details: { instructionsId: id },
      })
    }
    return row
  }

  private mustGetConversationRow(projectId: string, conversationId: string): typeof conversations.$inferSelect {
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

  private mustGetMessageRow(id: string): typeof messages.$inferSelect {
    const row = this.handle.db.select().from(messages).where(eq(messages.id, id)).get()
    if (!row) {
      throw new SocratesError("message_not_found", "Message not found", { details: { messageId: id } })
    }
    return row
  }
}
