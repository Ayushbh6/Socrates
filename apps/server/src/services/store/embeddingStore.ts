import type {
  CheckProjectEmbeddingsRequest,
  CheckProjectEmbeddingsResponse,
  ConfigureProjectEmbeddingsRequest,
  ListOllamaEmbeddingModelsQuery,
  ListOllamaEmbeddingModelsResponse,
  OllamaEmbeddingModel,
  OllamaRuntimeHardware,
  ProjectEmbeddingCredentialSource,
  ProjectEmbeddingProvider,
  ProjectEmbeddingStatus,
} from "@socrates/contracts"
import { envProviderCredentialResolver, type EmbeddingModelInfo, type EmbeddingProvider, type ProviderCredentialResolver } from "@socrates/providers"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { listWorkspaceEnvKeyCandidates, readWorkspaceEnvValue } from "@socrates/workspace"
import { and, desc, eq } from "drizzle-orm"
import os from "node:os"
import { projectEmbeddingConfigs } from "../../db/schema"
import { StoreBase } from "./shared"

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small"
export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "embeddinggemma:latest"
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"

type ProjectEmbeddingConfigRow = typeof projectEmbeddingConfigs.$inferSelect

export type ActiveEmbeddingConfiguration = {
  configId: string
  providerId: ProjectEmbeddingProvider
  modelId: string
  dimensions: number
  credentialSource: ProjectEmbeddingCredentialSource
  workspaceEnvFile?: string
  ollamaBaseUrl?: string
}

export type EmbeddingConfigurationStatus = Omit<ProjectEmbeddingStatus, "retrieval">

export class EmbeddingStore extends StoreBase {
  constructor(
    context: ConstructorParameters<typeof StoreBase>[0],
    private readonly provider: EmbeddingProvider,
    private readonly credentials: ProviderCredentialResolver = envProviderCredentialResolver,
  ) {
    super(context)
  }

  getStatus(projectId: string): EmbeddingConfigurationStatus {
    this.mustGetProjectRow(projectId)
    return this.buildStatus(projectId)
  }

  async dispose(): Promise<void> {}

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

  async configure(projectId: string, input: ConfigureProjectEmbeddingsRequest): Promise<EmbeddingConfigurationStatus> {
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

    return this.buildStatus(projectId)
  }

  reindex(projectId: string): EmbeddingConfigurationStatus {
    this.mustGetProjectRow(projectId)
    return this.buildStatus(projectId)
  }

  getActiveConfiguration(projectId: string): ActiveEmbeddingConfiguration | undefined {
    const config = this.getActiveConfig(projectId)
    if (!config || config.status !== "ready" || !config.dimensions) return undefined
    return {
      configId: config.id,
      providerId: config.providerId as ProjectEmbeddingProvider,
      modelId: config.modelId,
      dimensions: config.dimensions,
      credentialSource: config.credentialSource as ProjectEmbeddingCredentialSource,
      ...(config.workspaceEnvFile ? { workspaceEnvFile: config.workspaceEnvFile } : {}),
      ...(config.ollamaBaseUrl ? { ollamaBaseUrl: config.ollamaBaseUrl } : {}),
    }
  }

  async embedValues(projectId: string, values: string[]): Promise<{ embeddings: number[][]; dimensions: number }> {
    const config = this.getActiveConfiguration(projectId)
    if (!config) {
      throw new SocratesError("semantic_retrieval_unavailable", "Semantic retrieval is not configured for this project.", { recoverable: true })
    }
    const credentials = this.resolveCredentials(projectId, config.providerId, config.credentialSource, config.workspaceEnvFile)
    const result = await this.provider.embedMany({
      ...providerRequest(config.providerId, config.modelId, credentials.apiKey, config.ollamaBaseUrl),
      values,
    })
    if (result.dimensions !== config.dimensions || result.embeddings.length !== values.length) {
      throw new SocratesError("embedding_dimensions_mismatch", "Embedding provider returned an unexpected embedding shape.", {
        details: { expectedDimensions: config.dimensions, actualDimensions: result.dimensions },
        recoverable: true,
      })
    }
    return { embeddings: result.embeddings, dimensions: result.dimensions }
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

  private buildStatus(projectId: string): EmbeddingConfigurationStatus {
    const config = this.getActiveConfig(projectId)
    if (!config || !config.dimensions) {
      return {
        configured: false,
        ready: false,
        totalDocuments: 0,
        indexedDocuments: 0,
        pendingDocuments: 0,
        failedDocuments: 0,
        warnings: ["Semantic search is not configured for this project."],
      }
    }
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
      totalDocuments: 0,
      indexedDocuments: 0,
      pendingDocuments: 0,
      failedDocuments: 0,
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
