import type {
  CheckProjectEmbeddingsRequest,
  CheckProjectEmbeddingsResponse,
  ConfigureProjectEmbeddingsRequest,
  ProjectEmbeddingCredentialSource,
  ProjectEmbeddingJobStatus,
  ProjectEmbeddingProvider,
  ProjectEmbeddingStatus,
} from "@socrates/contracts"
import type { EmbeddingProvider } from "@socrates/providers"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { listWorkspaceEnvKeyCandidates, readWorkspaceEnvValue } from "@socrates/workspace"
import { and, desc, eq } from "drizzle-orm"
import { projectEmbeddingConfigs, traceDocuments, traceEmbeddings, traceIndexJobs } from "../../db/schema"
import { StoreBase } from "./shared"

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "embeddinggemma"
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"

const EMBEDDING_BATCH_SIZE = 16
const traceDocumentSelect = `td.id AS id,
  td.project_id AS projectId,
  td.conversation_id AS conversationId,
  td.turn_id AS turnId,
  td.source_kind AS sourceKind,
  td.source_table AS sourceTable,
  td.source_id AS sourceId,
  td.handle AS handle,
  td.title AS title,
  td.summary AS summary,
  td.content AS content,
  td.content_hash AS contentHash,
  td.importance AS importance,
  td.preserve_verbatim AS preserveVerbatim,
  td.chunk_index AS chunkIndex,
  td.token_count_estimate AS tokenCountEstimate,
  td.metadata_json AS metadataJson,
  td.created_at AS createdAt,
  td.updated_at AS updatedAt`

type ProjectEmbeddingConfigRow = typeof projectEmbeddingConfigs.$inferSelect
type TraceDocumentRow = typeof traceDocuments.$inferSelect

export type TraceQueryEmbeddingResult = {
  ready: boolean
  providerId?: ProjectEmbeddingProvider
  modelId?: string
  dimensions?: number
  embedding?: number[]
  warnings?: string[]
}

export class EmbeddingStore extends StoreBase {
  private readonly runningProjects = new Set<string>()

  constructor(
    context: ConstructorParameters<typeof StoreBase>[0],
    private readonly provider: EmbeddingProvider,
  ) {
    super(context)
  }

  getStatus(projectId: string): ProjectEmbeddingStatus {
    this.mustGetProjectRow(projectId)
    return this.buildStatus(projectId)
  }

  async check(projectId: string, input: CheckProjectEmbeddingsRequest): Promise<CheckProjectEmbeddingsResponse> {
    this.mustGetProjectRow(projectId)
    const providerId = input.providerId
    const modelId = defaultModelId(providerId, input.modelId)

    if (providerId === "openai" && !input.credentialSource) {
      const workspacePath = this.getPrimaryWorkspacePath(projectId)
      const candidates = listWorkspaceEnvKeyCandidates(workspacePath, "OPENAI_API_KEY")
      return {
        providerId,
        modelId,
        ok: Boolean(process.env.OPENAI_API_KEY) || candidates.some((candidate) => candidate.hasKey),
        serverEnvAvailable: Boolean(process.env.OPENAI_API_KEY),
        workspaceEnvCandidates: candidates.map((candidate) => ({
          fileName: candidate.fileName,
          hasOpenAiApiKey: candidate.hasKey,
        })),
        message: "Checked server and workspace environment files for OPENAI_API_KEY.",
      }
    }

    const credentials = this.resolveCredentials(projectId, providerId, input.credentialSource ?? "none", input.workspaceEnvFile)
    const check = await this.provider.check(providerRequest(providerId, modelId, credentials.apiKey, input.ollamaBaseUrl))

    return {
      providerId,
      modelId,
      ok: check.ok,
      ...(check.dimensions ? { dimensions: check.dimensions } : {}),
      ...(providerId === "openai"
        ? {
            serverEnvAvailable: Boolean(process.env.OPENAI_API_KEY),
            ...(input.workspaceEnvFile ? { selectedWorkspaceEnvFile: input.workspaceEnvFile } : {}),
          }
        : {}),
      message: check.message,
    }
  }

  async configure(projectId: string, input: ConfigureProjectEmbeddingsRequest): Promise<ProjectEmbeddingStatus> {
    this.mustGetProjectRow(projectId)
    const providerId = input.providerId
    const modelId = defaultModelId(providerId, input.modelId)
    const credentials = this.resolveCredentials(projectId, providerId, input.credentialSource, input.workspaceEnvFile)
    const check = await this.provider.check(providerRequest(providerId, modelId, credentials.apiKey, input.ollamaBaseUrl))
    if (!check.ok || !check.dimensions) {
      throw new SocratesError("embedding_check_failed", check.message, {
        details: { providerId, modelId },
        recoverable: true,
      })
    }

    const now = nowIso()
    this.handle.db
      .update(projectEmbeddingConfigs)
      .set({ active: false, updatedAt: now })
      .where(eq(projectEmbeddingConfigs.projectId, projectId))
      .run()

    this.handle.db
      .insert(projectEmbeddingConfigs)
      .values({
        id: createId("embcfg"),
        projectId,
        providerId,
        modelId,
        dimensions: check.dimensions,
        credentialSource: input.credentialSource,
        workspaceEnvFile: input.workspaceEnvFile,
        ollamaBaseUrl: input.ollamaBaseUrl ?? (providerId === "ollama" ? DEFAULT_OLLAMA_BASE_URL : undefined),
        status: "ready",
        active: true,
        lastCheckedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    this.enqueueProject(projectId, "configure")
    this.processProjectInBackground(projectId)
    return this.buildStatus(projectId)
  }

  reindex(projectId: string): ProjectEmbeddingStatus {
    this.mustGetProjectRow(projectId)
    this.enqueueProject(projectId, "manual_reindex")
    this.processProjectInBackground(projectId)
    return this.buildStatus(projectId)
  }

  enqueueProject(projectId: string, reason: string): string | undefined {
    const config = this.getActiveConfig(projectId)
    if (!config || config.status !== "ready") {
      return undefined
    }
    const now = nowIso()
    const jobId = createId("tjob")
    this.handle.db
      .insert(traceIndexJobs)
      .values({
        id: jobId,
        projectId,
        jobKind: "embed_trace_documents",
        status: "queued",
        attempts: 0,
        createdAt: now,
        metadataJson: JSON.stringify({ reason, configId: config.id }),
      })
      .run()
    return jobId
  }

  enqueueTurn(projectId: string, conversationId: string, turnId: string): string | undefined {
    const config = this.getActiveConfig(projectId)
    if (!config || config.status !== "ready") {
      return undefined
    }
    const now = nowIso()
    const jobId = createId("tjob")
    this.handle.db
      .insert(traceIndexJobs)
      .values({
        id: jobId,
        projectId,
        conversationId,
        turnId,
        jobKind: "embed_trace_documents",
        status: "queued",
        attempts: 0,
        createdAt: now,
        metadataJson: JSON.stringify({ reason: "turn_indexed", configId: config.id }),
      })
      .run()
    this.processProjectInBackground(projectId)
    return jobId
  }

  async embedTraceQuery(projectId: string, query: string): Promise<TraceQueryEmbeddingResult> {
    const config = this.getActiveConfig(projectId)
    if (!config || config.status !== "ready" || !config.dimensions) {
      return {
        ready: false,
        warnings: [`Semantic trace retrieval is not configured for this project. Use the project dashboard to enable semantic search.`],
      }
    }
    try {
      const credentials = this.resolveCredentials(
        projectId,
        config.providerId as ProjectEmbeddingProvider,
        config.credentialSource as ProjectEmbeddingCredentialSource,
        config.workspaceEnvFile ?? undefined,
      )
      const result = await this.provider.embed({
        ...providerRequest(config.providerId as ProjectEmbeddingProvider, config.modelId, credentials.apiKey, config.ollamaBaseUrl ?? undefined),
        value: query,
      })
      if (result.dimensions !== config.dimensions || !result.embeddings[0]) {
        return {
          ready: false,
          warnings: [`Semantic trace retrieval returned dimensions that do not match the active project embedding config.`],
        }
      }
      return {
        ready: true,
        providerId: config.providerId as ProjectEmbeddingProvider,
        modelId: config.modelId,
        dimensions: config.dimensions,
        embedding: result.embeddings[0],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ready: false, warnings: [`Semantic trace retrieval failed: ${message}`] }
    }
  }

  private processProjectInBackground(projectId: string): void {
    void this.processProject(projectId)
  }

  private async processProject(projectId: string): Promise<void> {
    if (this.runningProjects.has(projectId)) {
      return
    }
    this.runningProjects.add(projectId)
    try {
      const job = this.nextQueuedJob(projectId)
      if (!job) {
        return
      }
      const startedAt = nowIso()
      this.handle.db
        .update(traceIndexJobs)
        .set({ status: "running", startedAt, attempts: job.attempts + 1 })
        .where(eq(traceIndexJobs.id, job.id))
        .run()

      const config = this.getActiveConfig(projectId)
      if (!config || config.status !== "ready" || !config.dimensions) {
        this.completeJob(job.id, 0, "No active embedding config.")
        return
      }

      try {
        const embedded = await this.embedMissingDocuments(projectId, config)
        this.completeJob(job.id, embedded)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.handle.db
          .update(traceIndexJobs)
          .set({ status: "failed", completedAt: nowIso(), metadataJson: JSON.stringify({ error: message }) })
          .where(eq(traceIndexJobs.id, job.id))
          .run()
        this.handle.db
          .update(projectEmbeddingConfigs)
          .set({ lastError: message, updatedAt: nowIso() })
          .where(eq(projectEmbeddingConfigs.id, config.id))
          .run()
      }
    } finally {
      this.runningProjects.delete(projectId)
      if (this.nextQueuedJob(projectId)) {
        this.processProjectInBackground(projectId)
      }
    }
  }

  private async embedMissingDocuments(projectId: string, config: ProjectEmbeddingConfigRow): Promise<number> {
    let embedded = 0
    while (true) {
      const docs = this.findMissingDocuments(projectId, config)
      if (docs.length === 0) {
        return embedded
      }
      const credentials = this.resolveCredentials(
        projectId,
        config.providerId as ProjectEmbeddingProvider,
        config.credentialSource as ProjectEmbeddingCredentialSource,
        config.workspaceEnvFile ?? undefined,
      )
      const result = await this.provider.embedMany({
        ...providerRequest(config.providerId as ProjectEmbeddingProvider, config.modelId, credentials.apiKey, config.ollamaBaseUrl ?? undefined),
        values: docs.map((doc) => embeddingTextForDocument(doc)),
      })
      if (result.dimensions !== config.dimensions || result.embeddings.length !== docs.length) {
        throw new SocratesError("embedding_dimensions_mismatch", "Embedding provider returned an unexpected embedding shape", {
          details: { expectedDimensions: config.dimensions, actualDimensions: result.dimensions },
          recoverable: true,
        })
      }
      const now = nowIso()
      for (const [index, doc] of docs.entries()) {
        const embedding = result.embeddings[index]
        if (!embedding) {
          continue
        }
        this.handle.sqlite
          .prepare(
            `INSERT OR REPLACE INTO trace_embeddings
              (id, project_id, trace_document_id, provider_id, model_id, dimensions, content_hash, vector_json, usage_json, status, error_message, created_at, updated_at, embedded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', NULL, ?, ?, ?)`,
          )
          .run(
            createId("temb"),
            projectId,
            doc.id,
            config.providerId,
            config.modelId,
            config.dimensions,
            doc.contentHash,
            JSON.stringify(embedding),
            result.usage ? JSON.stringify(result.usage) : null,
            now,
            now,
            now,
          )
        embedded += 1
      }
    }
  }

  private findMissingDocuments(projectId: string, config: ProjectEmbeddingConfigRow): TraceDocumentRow[] {
    return this.handle.sqlite
      .prepare(
        `SELECT ${traceDocumentSelect}
         FROM trace_documents td
         LEFT JOIN trace_embeddings te
           ON te.trace_document_id = td.id
          AND te.provider_id = ?
          AND te.model_id = ?
          AND te.dimensions = ?
          AND te.content_hash = td.content_hash
          AND te.status = 'completed'
         WHERE td.project_id = ? AND te.id IS NULL
         ORDER BY td.created_at ASC
         LIMIT ?`,
      )
      .all(config.providerId, config.modelId, config.dimensions, projectId, EMBEDDING_BATCH_SIZE) as TraceDocumentRow[]
  }

  private completeJob(jobId: string, embeddedDocuments: number, warning?: string): void {
    this.handle.db
      .update(traceIndexJobs)
      .set({
        status: "completed",
        completedAt: nowIso(),
        metadataJson: JSON.stringify({ embeddedDocuments, ...(warning ? { warning } : {}) }),
      })
      .where(eq(traceIndexJobs.id, jobId))
      .run()
  }

  private nextQueuedJob(projectId: string): typeof traceIndexJobs.$inferSelect | undefined {
    return this.handle.db
      .select()
      .from(traceIndexJobs)
      .where(and(eq(traceIndexJobs.projectId, projectId), eq(traceIndexJobs.jobKind, "embed_trace_documents"), eq(traceIndexJobs.status, "queued")))
      .orderBy(traceIndexJobs.createdAt)
      .limit(1)
      .get()
  }

  private getActiveConfig(projectId: string): ProjectEmbeddingConfigRow | undefined {
    return this.handle.db
      .select()
      .from(projectEmbeddingConfigs)
      .where(and(eq(projectEmbeddingConfigs.projectId, projectId), eq(projectEmbeddingConfigs.active, true)))
      .orderBy(desc(projectEmbeddingConfigs.createdAt))
      .limit(1)
      .get()
  }

  private buildStatus(projectId: string): ProjectEmbeddingStatus {
    const totalDocuments = this.handle.db.select().from(traceDocuments).where(eq(traceDocuments.projectId, projectId)).all().length
    const config = this.getActiveConfig(projectId)
    if (!config || !config.dimensions) {
      return {
        configured: false,
        ready: false,
        totalDocuments,
        indexedDocuments: 0,
        pendingDocuments: totalDocuments,
        failedDocuments: 0,
        warnings: ["Semantic search is not configured for this project."],
      }
    }

    const indexedDocuments = (
      this.handle.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
           FROM trace_documents td
           INNER JOIN trace_embeddings te ON te.trace_document_id = td.id
            AND te.provider_id = ?
            AND te.model_id = ?
            AND te.dimensions = ?
            AND te.content_hash = td.content_hash
            AND te.status = 'completed'
           WHERE td.project_id = ?`,
        )
        .get(config.providerId, config.modelId, config.dimensions, projectId) as { count: number }
    ).count
    const failedDocuments = (
      this.handle.sqlite
        .prepare(
          `SELECT COUNT(*) AS count
           FROM trace_embeddings
           WHERE project_id = ? AND provider_id = ? AND model_id = ? AND dimensions = ? AND status = 'failed'`,
        )
        .get(projectId, config.providerId, config.modelId, config.dimensions) as { count: number }
    ).count
    const activeJob = this.handle.db
      .select()
      .from(traceIndexJobs)
      .where(and(eq(traceIndexJobs.projectId, projectId), eq(traceIndexJobs.jobKind, "embed_trace_documents")))
      .orderBy(desc(traceIndexJobs.createdAt))
      .limit(1)
      .get()
    return {
      configured: true,
      ready: config.status === "ready",
      providerId: config.providerId as ProjectEmbeddingProvider,
      modelId: config.modelId,
      configId: config.id,
      dimensions: config.dimensions,
      credentialSource: config.credentialSource as ProjectEmbeddingCredentialSource,
      ...(config.workspaceEnvFile ? { workspaceEnvFile: config.workspaceEnvFile } : {}),
      ...(config.ollamaBaseUrl ? { ollamaBaseUrl: config.ollamaBaseUrl } : {}),
      status: config.status as ProjectEmbeddingStatus["status"],
      totalDocuments,
      indexedDocuments,
      pendingDocuments: Math.max(totalDocuments - indexedDocuments - failedDocuments, 0),
      failedDocuments,
      ...(activeJob
        ? {
            activeJob: {
              id: activeJob.id,
              status: activeJob.status as ProjectEmbeddingJobStatus,
              createdAt: activeJob.createdAt,
              ...(activeJob.startedAt ? { startedAt: activeJob.startedAt } : {}),
              ...(activeJob.completedAt ? { completedAt: activeJob.completedAt } : {}),
            },
          }
        : {}),
      ...(config.lastError ? { lastError: config.lastError } : {}),
      updatedAt: config.updatedAt,
    }
  }

  private getPrimaryWorkspacePath(projectId: string): string {
    const workspace = this.mustGetPrimaryWorkspaceRow(projectId)
    if (!workspace.path) {
      throw new SocratesError("project_workspace_path_missing", "Project primary workspace has no path", { details: { projectId } })
    }
    return workspace.path
  }

  private resolveCredentials(
    projectId: string,
    providerId: ProjectEmbeddingProvider,
    credentialSource: ProjectEmbeddingCredentialSource,
    workspaceEnvFile?: string,
  ): { apiKey?: string } {
    if (providerId === "ollama") {
      return {}
    }
    if (credentialSource === "server_env") {
      return process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}
    }
    if (credentialSource === "workspace_env" && workspaceEnvFile) {
      const apiKey = readWorkspaceEnvValue(this.getPrimaryWorkspacePath(projectId), workspaceEnvFile, "OPENAI_API_KEY")
      return apiKey ? { apiKey } : {}
    }
    return {}
  }
}

const defaultModelId = (providerId: ProjectEmbeddingProvider, modelId: string | undefined): string =>
  modelId ?? (providerId === "openai" ? DEFAULT_OPENAI_EMBEDDING_MODEL : DEFAULT_OLLAMA_EMBEDDING_MODEL)

const providerRequest = (providerId: ProjectEmbeddingProvider, modelId: string, apiKey: string | undefined, baseUrl: string | undefined) => ({
  providerId,
  modelId,
  ...(apiKey ? { apiKey } : {}),
  ...(baseUrl ? { baseUrl } : {}),
})

const embeddingTextForDocument = (doc: TraceDocumentRow): string =>
  [`Title: ${doc.title}`, doc.summary ? `Summary: ${doc.summary}` : "", `Content:\n${doc.content}`].filter(Boolean).join("\n")
