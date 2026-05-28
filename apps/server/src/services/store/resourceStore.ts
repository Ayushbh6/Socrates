import fs from "node:fs"
import path from "node:path"
import type { CreateProjectResourceRequest, ProjectResource } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { deleteStoredResourceFile, inferResourceKind, listStoredResourceFiles, storeResourceFile } from "@socrates/workspace"
import { and, desc, eq, inArray } from "drizzle-orm"
import { artifacts, projectResources } from "../../db/schema"
import { StoreBase } from "./shared"
import type { UploadedResourceInput } from "./types"

const visibleResourceStatuses = ["active", "processing", "failed", "archived"]

export class ResourceStore extends StoreBase {
  listResources(projectId: string, options: { includeDeleted?: boolean } = {}): ProjectResource[] {
    this.mustGetProjectRow(projectId)
    this.syncWorkspaceResourceFiles(projectId)
    const rows = this.handle.db
      .select()
      .from(projectResources)
      .where(
        options.includeDeleted
          ? eq(projectResources.projectId, projectId)
          : and(eq(projectResources.projectId, projectId), inArray(projectResources.status, visibleResourceStatuses)),
      )
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

  syncWorkspaceResourceFiles(projectId: string): void {
    this.mustGetProjectRow(projectId)
    const workspace = this.mustGetPrimaryWorkspaceRow(projectId)
    if (!workspace.path) {
      return
    }

    const now = nowIso()
    const resourcesPath = path.resolve(workspace.path, ".socrates", "resources")
    const files = listStoredResourceFiles(workspace.path)
    const filesByPath = new Map(files.map((file) => [file.path, file]))
    const existingRows = this.handle.db
      .select()
      .from(projectResources)
      .where(eq(projectResources.projectId, projectId))
      .all()
    const existingByUri = new Map(existingRows.flatMap((row) => (row.uri ? [[row.uri, row]] : [])))

    for (const file of files) {
      const existing = existingByUri.get(file.path)
      if (existing) {
        if (existing.status === "deleted") {
          this.handle.db
            .update(projectResources)
            .set({ status: "active", updatedAt: now })
            .where(eq(projectResources.id, existing.id))
            .run()
          this.appendEvent({
            projectId,
            type: "project.resource.synced",
            source: "server",
            payload: { projectId, resourceId: existing.id, uri: file.path, action: "reactivated" },
          })
        }
        this.upsertResourceArtifact(projectId, existing.id, existing.artifactId, file, now)
        continue
      }

      const artifactId = createId("art")
      const resourceId = createId("pres")
      this.handle.db
        .insert(artifacts)
        .values({
          id: artifactId,
          projectId,
          kind: "file",
          path: file.path,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          createdAt: now,
        })
        .run()

      this.handle.db
        .insert(projectResources)
        .values({
          id: resourceId,
          projectId,
          artifactId,
          name: file.fileName,
          kind: inferResourceKind(file.fileName),
          source: "uploaded",
          uri: file.path,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run()

      this.appendEvent({
        projectId,
        type: "project.resource.synced",
        source: "server",
        payload: { projectId, resourceId, artifactId, uri: file.path, action: "created" },
      })
    }

    for (const row of existingRows) {
      if (
        row.status === "deleted" ||
        row.source !== "uploaded" ||
        !row.uri ||
        filesByPath.has(row.uri) ||
        !isPathInsideDirectory(resourcesPath, row.uri)
      ) {
        continue
      }
      if (fs.existsSync(row.uri)) {
        continue
      }
      this.handle.db
        .update(projectResources)
        .set({ status: "deleted", updatedAt: now })
        .where(eq(projectResources.id, row.id))
        .run()
      this.appendEvent({
        projectId,
        type: "project.resource.synced",
        source: "server",
        payload: { projectId, resourceId: row.id, uri: row.uri, action: "marked_deleted" },
      })
    }
  }

  deleteResource(projectId: string, resourceId: string): string {
    this.mustGetProjectRow(projectId)
    const row = this.mustGetResourceRow(resourceId)
    if (row.projectId !== projectId) {
      throw new SocratesError("project_resource_not_found", "Project resource not found", { details: { resourceId } })
    }
    if (row.status === "deleted") {
      return resourceId
    }

    const workspace = this.mustGetPrimaryWorkspaceRow(projectId)
    let fileDeleted = false
    let fileDeleteSkippedReason: string | undefined
    if (row.source === "uploaded" && workspace.path) {
      const result = deleteStoredResourceFile({
        workspacePath: workspace.path,
        ...(row.uri ? { resourcePath: row.uri } : {}),
      })
      fileDeleted = result.deleted
      fileDeleteSkippedReason = result.skippedReason
    }

    const now = nowIso()
    this.handle.db
      .update(projectResources)
      .set({ status: "deleted", updatedAt: now })
      .where(eq(projectResources.id, resourceId))
      .run()

    this.appendEvent({
      projectId,
      type: "project.resource.deleted",
      source: "server",
      payload: { projectId, resourceId, fileDeleted, fileDeleteSkippedReason },
    })

    return resourceId
  }

  private upsertResourceArtifact(
    projectId: string,
    resourceId: string,
    artifactId: string | null,
    file: { path: string; mimeType: string; sizeBytes: number },
    now: string,
  ): void {
    if (artifactId) {
      this.handle.db
        .update(artifacts)
        .set({ path: file.path, mimeType: file.mimeType, sizeBytes: file.sizeBytes })
        .where(eq(artifacts.id, artifactId))
        .run()
      return
    }

    const nextArtifactId = createId("art")
    this.handle.db
      .insert(artifacts)
      .values({
        id: nextArtifactId,
        projectId,
        kind: "file",
        path: file.path,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        createdAt: now,
      })
      .run()
    this.handle.db
      .update(projectResources)
      .set({ artifactId: nextArtifactId, updatedAt: now })
      .where(eq(projectResources.id, resourceId))
      .run()
  }
}

const isPathInsideDirectory = (directory: string, candidatePath: string): boolean => {
  const relative = path.relative(path.resolve(directory), path.resolve(candidatePath))
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
}
