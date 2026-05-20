import type { CreateProjectResourceRequest, ProjectResource } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { inferResourceKind, storeResourceFile } from "@socrates/workspace"
import { desc, eq } from "drizzle-orm"
import { artifacts, projectResources } from "../../db/schema"
import { StoreBase } from "./shared"
import type { UploadedResourceInput } from "./types"

export class ResourceStore extends StoreBase {
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
}
