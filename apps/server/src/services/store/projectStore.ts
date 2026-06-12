import path from "node:path"
import type {
  CreateProjectRequest,
  InspectWorkspaceRequest,
  InspectWorkspaceResponse,
  PatchProjectRequest,
  PickWorkspaceFolderRequest,
  PickWorkspaceFolderResponse,
  Project,
  ProjectResource,
  ProjectWorkspace,
  UpdateProjectWorkspaceRequest,
  UpdateProjectWorkspaceResponse,
} from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { copyStoredResourceFile, ensureWorkspaceScaffold, inspectWorkspacePath, pickWorkspaceFolder } from "@socrates/workspace"
import { and, count, desc, eq, inArray } from "drizzle-orm"
import { artifacts, conversations, projectResources, projects, projectWorkspaces, turns } from "../../db/schema"
import { mapConversation, mapProject, mapProjectInstructions, mapProjectWorkspace } from "../../db/mappers"
import { activeTurnStatuses, StoreBase } from "./shared"
import type { AgentContext, ProjectDashboard, ProjectListItem } from "./types"
import type { InstructionStore } from "./instructionStore"

export class ProjectStore extends StoreBase {
  constructor(
    context: ConstructorParameters<typeof StoreBase>[0],
    private readonly instructions: InstructionStore,
  ) {
    super(context)
  }

  async pickWorkspaceFolder(input: PickWorkspaceFolderRequest): Promise<PickWorkspaceFolderResponse> {
    return pickWorkspaceFolder(input)
  }

  inspectWorkspace(input: InspectWorkspaceRequest): InspectWorkspaceResponse {
    return inspectWorkspacePath(input)
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
    if (path.isAbsolute(input.workspacePath)) {
      this.assertWorkspacePathAvailable(path.resolve(input.workspacePath))
    }
    const scaffold = ensureWorkspaceScaffold({
      workspacePath: input.workspacePath,
      mode: input.creationMode,
      ...(input.scaffoldAction ? { scaffoldAction: input.scaffoldAction } : {}),
      requireActionForExistingSocrates: true,
    })

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
    const resourceRows = this.handle.db
      .select()
      .from(projectResources)
      .where(and(eq(projectResources.projectId, projectId), inArray(projectResources.status, ["active", "processing", "failed", "archived"])))
      .all()
    const conversationRows = this.handle.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.projectId, projectId), inArray(conversations.status, ["active", "archived"])))
      .orderBy(desc(conversations.updatedAt))
      .all()
    const instructionRow = this.instructions.getActiveInstructionsRow(projectId)

    return {
      project,
      primaryWorkspace: mapProjectWorkspace(workspaceRow),
      resources: this.mapResourceRows(resourceRows) as ProjectResource[],
      conversations: conversationRows.map(mapConversation),
      skills: [],
      ...(instructionRow ? { instructions: mapProjectInstructions(instructionRow) } : {}),
    }
  }

  getAgentContext(projectId: string): AgentContext {
    const project = this.mustGetProjectRow(projectId)
    const user = this.mustGetUserRow(project.userId)
    const instructionRow = this.instructions.getActiveInstructionsRow(projectId)

    return {
      userDisplayName: user.displayName,
      projectName: project.name,
      ...(project.description ? { projectDescription: project.description } : {}),
      ...(instructionRow ? { projectInstructions: instructionRow.content } : {}),
    }
  }

  getPrimaryWorkspacePath(projectId: string): string {
    const workspace = this.mustGetPrimaryWorkspaceRow(projectId)
    if (!workspace.path) {
      throw new SocratesError("project_workspace_path_missing", "Project primary workspace has no path", { details: { projectId } })
    }
    return workspace.path
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

  updateProjectWorkspace(projectId: string, input: UpdateProjectWorkspaceRequest): UpdateProjectWorkspaceResponse {
    this.mustGetProjectRow(projectId)
    this.assertNoActiveProjectTurns(projectId)

    const oldWorkspace = this.mustGetPrimaryWorkspaceRow(projectId)
    const normalizedNewPath = path.resolve(input.workspacePath)
    if (oldWorkspace.path === normalizedNewPath && input.scaffoldAction === "reset") {
      throw new SocratesError("project_workspace_same_path_reset_denied", "Choose a different workspace before resetting .socrates", {
        details: { projectId, workspacePath: normalizedNewPath },
        recoverable: true,
      })
    }

    const scaffold = ensureWorkspaceScaffold({
      workspacePath: input.workspacePath,
      mode: input.creationMode,
      ...(input.scaffoldAction ? { scaffoldAction: input.scaffoldAction } : {}),
      requireActionForExistingSocrates: true,
    })

    if (oldWorkspace.path !== scaffold.workspacePath) {
      this.assertWorkspacePathAvailableForUpdate(projectId, scaffold.workspacePath)
    }

    const now = nowIso()
    const copiedResources = oldWorkspace.path
      ? this.copyUploadedResourcesToWorkspace(projectId, oldWorkspace.path, scaffold.workspacePath, now)
      : []

    let primaryWorkspace: ProjectWorkspace
    if (oldWorkspace.path === scaffold.workspacePath) {
      this.handle.db.update(projectWorkspaces).set({ updatedAt: now }).where(eq(projectWorkspaces.id, oldWorkspace.id)).run()
      primaryWorkspace = mapProjectWorkspace(this.mustGetPrimaryWorkspaceRow(projectId))
    } else {
      this.handle.db
        .update(projectWorkspaces)
        .set({ status: "detached", isPrimary: false, updatedAt: now })
        .where(eq(projectWorkspaces.id, oldWorkspace.id))
        .run()
      this.appendEvent({
        projectId,
        type: "project.workspace.detached",
        source: "server",
        payload: { projectId, workspaceId: oldWorkspace.id, path: oldWorkspace.path },
      })
      primaryWorkspace = this.createWorkspace(projectId, "existing_folder", scaffold.workspacePath)
    }

    this.handle.db.update(projects).set({ updatedAt: now }).where(eq(projects.id, projectId)).run()

    return {
      primaryWorkspace,
      resources: copiedResources.length > 0 ? copiedResources : this.currentResourceList(projectId),
    }
  }

  private assertNoActiveProjectTurns(projectId: string): void {
    const activeTurn = this.handle.db
      .select({ id: turns.id })
      .from(turns)
      .innerJoin(conversations, eq(turns.conversationId, conversations.id))
      .where(and(eq(conversations.projectId, projectId), inArray(turns.status, activeTurnStatuses)))
      .limit(1)
      .get()

    if (activeTurn) {
      throw new SocratesError("project_workspace_has_active_turn", "Workspace cannot be changed while a turn is active", {
        details: { projectId, turnId: activeTurn.id },
        recoverable: true,
      })
    }
  }

  private assertWorkspacePathAvailableForUpdate(projectId: string, workspacePath: string): void {
    const existing = this.handle.db
      .select()
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.path, workspacePath), inArray(projectWorkspaces.status, ["active", "missing"])))
      .limit(1)
      .get()

    if (existing && existing.projectId !== projectId) {
      throw new SocratesError("workspace_already_attached", "This workspace folder is already attached to a project", {
        details: { workspacePath, projectId: existing.projectId },
      })
    }
    if (existing && existing.projectId === projectId) {
      throw new SocratesError("workspace_already_attached", "This workspace folder is already attached to this project", {
        details: { workspacePath, projectId },
      })
    }
  }

  private copyUploadedResourcesToWorkspace(
    projectId: string,
    oldWorkspacePath: string,
    newWorkspacePath: string,
    now: string,
  ): ProjectResource[] {
    const oldResourcesPath = path.resolve(oldWorkspacePath, ".socrates", "resources")
    const resourceRows = this.handle.db
      .select()
      .from(projectResources)
      .where(and(eq(projectResources.projectId, projectId), eq(projectResources.source, "uploaded"), eq(projectResources.status, "active")))
      .all()

    for (const resource of resourceRows) {
      if (!resource.uri || !isPathInsideDirectory(oldResourcesPath, resource.uri)) {
        continue
      }

      const copied = copyStoredResourceFile({
        sourcePath: resource.uri,
        targetWorkspacePath: newWorkspacePath,
      })
      this.handle.db
        .update(projectResources)
        .set({ uri: copied.path, updatedAt: now })
        .where(eq(projectResources.id, resource.id))
        .run()
      if (resource.artifactId) {
        this.handle.db.update(artifacts).set({ path: copied.path }).where(eq(artifacts.id, resource.artifactId)).run()
      }
    }

    return this.currentResourceList(projectId)
  }

  private currentResourceList(projectId: string): ProjectResource[] {
    const resourceRows = this.handle.db
      .select()
      .from(projectResources)
      .where(and(eq(projectResources.projectId, projectId), inArray(projectResources.status, ["active", "processing", "failed", "archived"])))
      .all()
    return this.mapResourceRows(resourceRows)
  }
}

const isPathInsideDirectory = (directory: string, candidatePath: string): boolean => {
  const relative = path.relative(path.resolve(directory), path.resolve(candidatePath))
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
}
