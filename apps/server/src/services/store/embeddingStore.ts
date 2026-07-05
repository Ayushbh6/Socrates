import type {
  CheckProjectEmbeddingsRequest,
  CheckProjectEmbeddingsResponse,
  ConfigureProjectEmbeddingsRequest,
  ListOllamaEmbeddingModelsQuery,
  ListOllamaEmbeddingModelsResponse,
  OllamaEmbeddingModel,
  OllamaRuntimeHardware,
  ProjectEmbeddingCredentialSource,
  ProjectEmbeddingJobStatus,
  ProjectEmbeddingProvider,
  ProjectEmbeddingStatus,
} from "@socrates/contracts"
import { envProviderCredentialResolver, type EmbeddingModelInfo, type EmbeddingProvider, type ProviderCredentialResolver } from "@socrates/providers"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { listWorkspaceEnvKeyCandidates, readWorkspaceEnvValue } from "@socrates/workspace"
import { and, desc, eq } from "drizzle-orm"
import os from "node:os"
import { projectEmbeddingConfigs, traceDocuments, traceEmbeddings, traceIndexJobs } from "../../db/schema"
import { StoreBase } from "./shared"

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "embeddinggemma:latest"
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
  private readonly runningTasks = new Set<Promise<void>>()
  private disposed = false

  constructor(
    context: ConstructorParameters<typeof StoreBase>[0],
    private readonly provider: EmbeddingProvider,
    private readonly credentials: ProviderCredentialResolver = envProviderCredentialResolver,
  ) {
    super(context)
  }

  getStatus(projectId: string): ProjectEmbeddingStatus {
    this.mustGetProjectRow(projectId)
    return this.buildStatus(projectId)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.allSettled([...this.runningTasks])
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
        ok: Boolean(this.credentials.getApiKey("openai")) || candidates.some((candidate) => candidate.hasKey),
        serverEnvAvailable: Boolean(this.credentials.getApiKey("openai")),
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
            serverEnvAvailable: Boolean(this.credentials.getApiKey("openai")),
            ...(input.workspaceEnvFile ? { selectedWorkspaceEnvFile: input.workspaceEnvFile } : {}),
          }
        : {}),
      message: check.message,
    }
  }

  async listOllamaModels(input: ListOllamaEmbeddingModelsQuery = {}): Promise<ListOllamaEmbeddingModelsResponse> {
    const baseUrl = input.ollamaBaseUrl ?? DEFAULT_OLLAMA_BASE_URL
    const hardware = detectOllamaHardware()
    let installedModels: OllamaEmbeddingModel[] = []
    let reachable = false
    let message = `Could not reach Ollama at ${baseUrl}. Start Ollama before choosing a local embedding model.`
    const warnings: string[] = []

    try {
      if (!this.provider.listModels) {
        throw new SocratesError("embedding_model_discovery_not_supported", "The active embedding provider does not support Ollama model discovery.", {
          recoverable: true,
        })
      }
      const result = await this.provider.listModels({ providerId: "ollama", baseUrl })
      installedModels = result.models.map(toOllamaModel)
      reachable = true
      message =
        installedModels.length === 0
          ? "Ollama is running, but no local models are installed yet."
          : `Ollama is running with ${installedModels.length} installed model${installedModels.length === 1 ? "" : "s"}.`
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error))
    }

    const recommendedModels = recommendedOllamaModels(hardware, installedModels)
    const suggestedModelId = recommendedModels.find((model) => model.recommendedForThisSystem)?.modelId
    const embeddingModels = installedModels.filter((model) => model.embeddingCapable)

    return {
      reachable,
      baseUrl,
      installedModels,
      embeddingModels,
      recommendedModels,
      ...(suggestedModelId ? { suggestedModelId } : {}),
      hardware,
      message,
      ...(warnings.length > 0 ? { warnings } : {}),
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

    this.pruneInactiveEmbeddingRows(projectId, providerId, modelId, check.dimensions)
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
    if (this.disposed) {
      return
    }
    let task: Promise<void>
    task = this.processProject(projectId)
      .catch(() => undefined)
      .finally(() => {
        this.runningTasks.delete(task)
      })
    this.runningTasks.add(task)
  }

  private async processProject(projectId: string): Promise<void> {
    if (this.disposed) {
      return
    }
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
        this.completeJob(job.id, embedded, undefined, config.id)
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
      if (!this.disposed && this.nextQueuedJob(projectId)) {
        this.processProjectInBackground(projectId)
      }
    }
  }

  private async embedMissingDocuments(projectId: string, config: ProjectEmbeddingConfigRow): Promise<number> {
    let embedded = 0
    while (true) {
      if (!this.isActiveConfig(projectId, config.id)) {
        return embedded
      }
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
      if (!this.isActiveConfig(projectId, config.id)) {
        return embedded
      }
      const now = nowIso()
      for (const [index, doc] of docs.entries()) {
        if (!this.isActiveConfig(projectId, config.id)) {
          return embedded
        }
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

  private pruneInactiveEmbeddingRows(projectId: string, providerId: ProjectEmbeddingProvider, modelId: string, dimensions: number): void {
    this.handle.sqlite
      .prepare(
        `DELETE FROM trace_embeddings
         WHERE project_id = ?
           AND (
             provider_id <> ?
             OR model_id <> ?
             OR dimensions <> ?
             OR NOT EXISTS (
               SELECT 1
               FROM trace_documents td
               WHERE td.id = trace_embeddings.trace_document_id
                 AND td.project_id = trace_embeddings.project_id
                 AND td.content_hash = trace_embeddings.content_hash
             )
           )`,
      )
      .run(projectId, providerId, modelId, dimensions)
  }

  private isActiveConfig(projectId: string, configId: string): boolean {
    return this.getActiveConfig(projectId)?.id === configId
  }

  private completeJob(jobId: string, embeddedDocuments: number, warning?: string, configId?: string): void {
    const now = nowIso()
    this.handle.db
      .update(traceIndexJobs)
      .set({
        status: "completed",
        completedAt: now,
        metadataJson: JSON.stringify({ embeddedDocuments, ...(warning ? { warning } : {}) }),
      })
      .where(eq(traceIndexJobs.id, jobId))
      .run()
    if (configId && !warning) {
      this.handle.db.update(projectEmbeddingConfigs).set({ lastError: null, updatedAt: now }).where(eq(projectEmbeddingConfigs.id, configId)).run()
    }
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
    const pendingDocuments = Math.max(totalDocuments - indexedDocuments - failedDocuments, 0)
    const shouldShowLastError = Boolean(config.lastError) && (config.status === "failed" || failedDocuments > 0 || pendingDocuments > 0 || activeJob?.status === "failed")
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
      pendingDocuments,
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
      ...(shouldShowLastError ? { lastError: config.lastError ?? undefined } : {}),
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
      const apiKey = this.credentials.getApiKey("openai")
      return apiKey ? { apiKey } : {}
    }
    if (credentialSource === "workspace_env" && workspaceEnvFile) {
      const apiKey = readWorkspaceEnvValue(this.getPrimaryWorkspacePath(projectId), workspaceEnvFile, "OPENAI_API_KEY")
      return apiKey ? { apiKey } : {}
    }
    return {}
  }
}

const OLLAMA_RECOMMENDATIONS: Array<
  Pick<OllamaEmbeddingModel, "modelId" | "name" | "description" | "sizeLabel" | "recommendationReason"> & { minMemoryGb: number }
> = [
  {
    modelId: "embeddinggemma:latest",
    name: "EmbeddingGemma",
    description: "Small, current, and comfortable for laptop-local semantic search.",
    sizeLabel: "small",
    recommendationReason: "Best default for most local Socrates projects.",
    minMemoryGb: 4,
  },
  {
    modelId: "qwen3-embedding:0.6b",
    name: "Qwen3 Embedding 0.6B",
    description: "Balanced multilingual and code retrieval without jumping to a large model.",
    sizeLabel: "small-medium",
    recommendationReason: "Good when you want a stronger multilingual/code-oriented model.",
    minMemoryGb: 8,
  },
  {
    modelId: "nomic-embed-text-v2-moe:latest",
    name: "Nomic Embed Text v2 MoE",
    description: "Modern multilingual retrieval model from the Nomic family.",
    sizeLabel: "medium",
    recommendationReason: "Useful when multilingual retrieval is the priority.",
    minMemoryGb: 8,
  },
  {
    modelId: "nomic-embed-text:latest",
    name: "Nomic Embed Text",
    description: "Established local embedding model with broad Ollama usage.",
    sizeLabel: "small",
    recommendationReason: "Reliable classic fallback for local semantic search.",
    minMemoryGb: 4,
  },
  {
    modelId: "mxbai-embed-large:latest",
    name: "MxBai Embed Large",
    description: "Quality-focused local embedding model; heavier than the default options.",
    sizeLabel: "medium",
    recommendationReason: "Consider this when retrieval quality matters more than speed.",
    minMemoryGb: 12,
  },
]

const detectOllamaHardware = (): OllamaRuntimeHardware => {
  const totalMemoryBytes = os.totalmem()
  const freeMemoryBytes = os.freemem()
  const totalMemoryGb = totalMemoryBytes / 1024 / 1024 / 1024
  const memoryTier: OllamaRuntimeHardware["memoryTier"] = totalMemoryGb >= 24 ? "large" : totalMemoryGb >= 12 ? "balanced" : "compact"
  return {
    platform: process.platform,
    arch: process.arch,
    cpuCount: Math.max(os.cpus().length, 1),
    totalMemoryBytes,
    freeMemoryBytes,
    memoryTier,
    recommendationReason:
      memoryTier === "large"
        ? "This machine has enough memory for medium local embedding models, but Socrates still recommends pulling one exact model at a time."
        : memoryTier === "balanced"
          ? "This machine is a good fit for a compact local embedding model that will not dominate laptop resources."
          : "This machine should prefer the smallest local embedding models first.",
  }
}

const recommendedOllamaModels = (hardware: OllamaRuntimeHardware, installedModels: OllamaEmbeddingModel[]): OllamaEmbeddingModel[] => {
  const installedByBase = new Map(installedModels.map((model) => [baseModelId(model.modelId), model]))
  const suggestedModelId = suggestedModelForHardware(hardware)
  return OLLAMA_RECOMMENDATIONS.map((recommendation) => {
    const installed = installedByBase.get(baseModelId(recommendation.modelId))
    return {
      modelId: installed?.modelId ?? recommendation.modelId,
      name: installed?.name ?? recommendation.name,
      installed: Boolean(installed),
      status: installed?.status ?? "embedding",
      embeddingCapable: installed?.embeddingCapable ?? true,
      ...(installed?.sizeBytes ? { sizeBytes: installed.sizeBytes } : {}),
      ...(installed?.modifiedAt ? { modifiedAt: installed.modifiedAt } : {}),
      ...(installed?.family ? { family: installed.family } : {}),
      ...(installed?.families ? { families: installed.families } : {}),
      ...(installed?.parameterSize ? { parameterSize: installed.parameterSize } : {}),
      ...(installed?.quantizationLevel ? { quantizationLevel: installed.quantizationLevel } : {}),
      ...(installed?.contextLength ? { contextLength: installed.contextLength } : {}),
      ...(installed?.embeddingLength ? { embeddingLength: installed.embeddingLength } : {}),
      ...(installed?.capabilities ? { capabilities: installed.capabilities } : {}),
      description: recommendation.description,
      pullCommand: `ollama pull ${recommendation.modelId}`,
      sizeLabel: installed?.sizeBytes ? formatBytes(installed.sizeBytes) : recommendation.sizeLabel,
      recommendationReason: recommendation.recommendationReason,
      recommendedForThisSystem: recommendation.modelId === suggestedModelId,
    }
  }).filter((model) => {
    const recommendation = OLLAMA_RECOMMENDATIONS.find((item) => item.modelId === model.modelId || baseModelId(item.modelId) === baseModelId(model.modelId))
    const totalMemoryGb = hardware.totalMemoryBytes / 1024 / 1024 / 1024
    return !recommendation || recommendation.minMemoryGb <= totalMemoryGb || recommendation.modelId === suggestedModelId
  })
}

const suggestedModelForHardware = (hardware: OllamaRuntimeHardware): string =>
  hardware.memoryTier === "large" ? "qwen3-embedding:0.6b" : "embeddinggemma:latest"

const toOllamaModel = (model: EmbeddingModelInfo): OllamaEmbeddingModel => ({
  modelId: model.modelId,
  name: model.name,
  installed: true,
  status: model.status,
  embeddingCapable: model.embeddingCapable,
  ...(model.sizeBytes ? { sizeBytes: model.sizeBytes, sizeLabel: formatBytes(model.sizeBytes) } : {}),
  ...(model.modifiedAt ? { modifiedAt: model.modifiedAt } : {}),
  ...(model.family ? { family: model.family } : {}),
  ...(model.families ? { families: model.families } : {}),
  ...(model.parameterSize ? { parameterSize: model.parameterSize } : {}),
  ...(model.quantizationLevel ? { quantizationLevel: model.quantizationLevel } : {}),
  ...(model.contextLength ? { contextLength: model.contextLength } : {}),
  ...(model.embeddingLength ? { embeddingLength: model.embeddingLength } : {}),
  ...(model.capabilities ? { capabilities: model.capabilities } : {}),
})

const baseModelId = (modelId: string): string => modelId.replace(/:latest$/, "")

const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  }
  return `${Math.max(Math.round(bytes / 1024 / 1024), 1)} MB`
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
