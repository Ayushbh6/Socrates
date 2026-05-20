import type {
  CreateProjectRequest,
  PatchProjectRequest,
  PickWorkspaceFolderRequest,
  PickWorkspaceFolderResponse,
  Project,
  ProjectResource,
  ProjectWorkspace,
} from "@socrates/contracts"
import { createId, nowIso } from "@socrates/shared"
import { ensureWorkspaceScaffold, pickWorkspaceFolder } from "@socrates/workspace"
import { and, count, desc, eq, inArray } from "drizzle-orm"
import { conversations, projectResources, projects } from "../../db/schema"
import { mapConversation, mapProject, mapProjectInstructions, mapProjectWorkspace } from "../../db/mappers"
import { StoreBase } from "./shared"
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
    const instructionRow = this.instructions.getActiveInstructionsRow(projectId)

    return {
      project,
      primaryWorkspace: mapProjectWorkspace(workspaceRow),
      resources: this.mapResourceRows(resourceRows) as ProjectResource[],
      conversations: conversationRows.map(mapConversation),
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
}
