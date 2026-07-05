"use client";

import { AlertCircle, BrainCircuit, CheckCircle2, Cpu, ExternalLink, HardDrive, Loader2, RefreshCw, Sparkles, Terminal, Wifi } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";
import type {
  CheckProjectEmbeddingsResponse,
  ListOllamaEmbeddingModelsResponse,
  OllamaEmbeddingModel,
  ProjectEmbeddingCredentialSource,
  ProjectEmbeddingProvider,
  ProjectEmbeddingStatus,
} from "@socrates/contracts";

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_OLLAMA_MODEL = "embeddinggemma:latest";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
const OLLAMA_DOWNLOAD_URL = "https://ollama.com/download";

export function SemanticSearchPanel({
  projectId,
  status,
  onStatusChange,
}: {
  projectId: string;
  status?: ProjectEmbeddingStatus;
  onStatusChange: (status: ProjectEmbeddingStatus) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [isReindexing, setIsReindexing] = useState(false);
  const shouldPoll = Boolean(status?.activeJob && ["queued", "running"].includes(status.activeJob.status));

  useEffect(() => {
    if (!shouldPoll) {
      return;
    }
    let cancelled = false;
    const interval = window.setInterval(() => {
      void api.getProjectEmbeddingStatus(projectId).then((response) => {
        if (!cancelled) {
          onStatusChange(response.status);
        }
      });
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [onStatusChange, projectId, shouldPoll]);

  const configuredLabel = status?.configured ? `${status.providerId} / ${status.modelId}` : "Not enabled";
  const isBusy = status?.activeJob?.status === "queued" || status?.activeJob?.status === "running";

  const handleReindex = async () => {
    setIsReindexing(true);
    try {
      const response = await api.reindexProjectEmbeddings(projectId);
      onStatusChange(response.status);
    } finally {
      setIsReindexing(false);
    }
  };

  return (
    <div className="border-b border-gray-200 py-6">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BrainCircuit className="size-4 text-brand-teal-dark" />
          <h3 className="font-medium text-brand-text-dark">Semantic Search</h3>
        </div>
        {isBusy && <Loader2 className="size-4 animate-spin text-brand-teal-dark" />}
      </div>

      <div className="space-y-2 text-sm text-brand-text-light">
        <p className="truncate">{configuredLabel}</p>
        {status?.configured && (
          <p>
            {status.indexedDocuments}/{status.totalDocuments} indexed
            {status.pendingDocuments > 0 ? `, ${status.pendingDocuments} pending` : ""}
            {status.failedDocuments > 0 ? `, ${status.failedDocuments} failed` : ""}
          </p>
        )}
        {status?.lastError && <p className="text-red-600">{status.lastError}</p>}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={() => setIsOpen(true)}>
          {status?.configured ? "Configure" : "Enable"}
        </Button>
        {status?.configured && (
          <Button type="button" variant="outline" size="sm" disabled={isReindexing || isBusy} onClick={() => void handleReindex()}>
            {isReindexing ? <Loader2 className="mr-2 size-3 animate-spin" /> : <RefreshCw className="mr-2 size-3" />}
            Reindex
          </Button>
        )}
      </div>

      {isOpen && (
        <EmbeddingSetupDialog
          projectId={projectId}
          currentStatus={status}
          onClose={() => setIsOpen(false)}
          onStatusChange={onStatusChange}
        />
      )}
    </div>
  );
}

function EmbeddingSetupDialog({
  projectId,
  currentStatus,
  onClose,
  onStatusChange,
}: {
  projectId: string;
  currentStatus?: ProjectEmbeddingStatus;
  onClose: () => void;
  onStatusChange: (status: ProjectEmbeddingStatus) => void;
}) {
  const [providerId, setProviderId] = useState<ProjectEmbeddingProvider>(currentStatus?.providerId ?? "openai");
  const [openAiModel, setOpenAiModel] = useState(currentStatus?.providerId === "openai" ? currentStatus.modelId ?? DEFAULT_OPENAI_MODEL : DEFAULT_OPENAI_MODEL);
  const [ollamaModel, setOllamaModel] = useState(currentStatus?.providerId === "ollama" ? currentStatus.modelId ?? DEFAULT_OLLAMA_MODEL : DEFAULT_OLLAMA_MODEL);
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(currentStatus?.ollamaBaseUrl ?? DEFAULT_OLLAMA_URL);
  const [credentialSource, setCredentialSource] = useState<ProjectEmbeddingCredentialSource | null>(currentStatus?.credentialSource ?? null);
  const [workspaceEnvFile, setWorkspaceEnvFile] = useState(currentStatus?.workspaceEnvFile ?? "");
  const [checkResult, setCheckResult] = useState<CheckProjectEmbeddingsResponse | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [ollamaDiscovery, setOllamaDiscovery] = useState<ListOllamaEmbeddingModelsResponse | null>(null);
  const [isLoadingOllamaModels, setIsLoadingOllamaModels] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modelId = providerId === "openai" ? openAiModel : ollamaModel;
  const otherInstalledOllamaModels = useMemo(
    () => ollamaDiscovery?.installedModels.filter((model) => !model.embeddingCapable) ?? [],
    [ollamaDiscovery],
  );
  const openAiCandidates = useMemo(
    () => checkResult?.workspaceEnvCandidates?.filter((candidate) => candidate.hasOpenAiApiKey) ?? [],
    [checkResult],
  );
  const canConfigure =
    checkResult?.ok &&
    (providerId === "ollama" ||
      credentialSource === "server_env" ||
      (credentialSource === "workspace_env" && workspaceEnvFile.length > 0));
  const canCheckSetup = providerId === "openai" || Boolean(ollamaDiscovery?.reachable);

  useEffect(() => {
    if (providerId !== "ollama") {
      return;
    }
    let cancelled = false;
    setIsLoadingOllamaModels(true);
    void api
      .listOllamaEmbeddingModels({ ollamaBaseUrl })
      .then((response) => {
        if (cancelled) {
          return;
        }
        setOllamaDiscovery(response);
        if (response.suggestedModelId && (ollamaModel === DEFAULT_OLLAMA_MODEL || currentStatus?.providerId !== "ollama")) {
          setOllamaModel(response.suggestedModelId);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not list Ollama models.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingOllamaModels(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentStatus?.providerId, ollamaBaseUrl, providerId]);

  const handleRefreshOllamaModels = async () => {
    setIsLoadingOllamaModels(true);
    setError(null);
    try {
      const response = await api.listOllamaEmbeddingModels({ ollamaBaseUrl });
      setOllamaDiscovery(response);
      if (response.suggestedModelId && (ollamaModel === DEFAULT_OLLAMA_MODEL || currentStatus?.providerId !== "ollama")) {
        setOllamaModel(response.suggestedModelId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not list Ollama models.");
    } finally {
      setIsLoadingOllamaModels(false);
    }
  };

  const runCheck = async (selectedModelId = modelId) => {
    setIsChecking(true);
    setError(null);
    try {
      const response = await api.checkProjectEmbeddings(projectId, {
        providerId,
        modelId: selectedModelId,
        ...(providerId === "openai" && credentialSource ? { credentialSource } : {}),
        ...(providerId === "openai" && credentialSource === "workspace_env" && workspaceEnvFile ? { workspaceEnvFile } : {}),
        ...(providerId === "ollama" ? { credentialSource: "none", ollamaBaseUrl } : {}),
      });
      setCheckResult(response);
      if (providerId === "openai") {
        if (response.serverEnvAvailable) {
          setCredentialSource("server_env");
        } else if (response.workspaceEnvCandidates?.filter((candidate) => candidate.hasOpenAiApiKey).length === 1) {
          setCredentialSource("workspace_env");
          setWorkspaceEnvFile(response.workspaceEnvCandidates.find((candidate) => candidate.hasOpenAiApiKey)?.fileName ?? "");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not check embeddings.");
    } finally {
      setIsChecking(false);
    }
  };

  const handleSelectOllamaModel = (selectedModelId: string) => {
    setOllamaModel(selectedModelId);
    setCheckResult(null);
    setError(null);
  };

  const handleConfigure = async () => {
    if (!canConfigure) {
      return;
    }
    setIsConfiguring(true);
    setError(null);
    try {
      const response = await api.configureProjectEmbeddings(projectId, {
        providerId,
        modelId,
        credentialSource: providerId === "openai" ? credentialSource ?? "server_env" : "none",
        ...(providerId === "openai" && credentialSource === "workspace_env" ? { workspaceEnvFile } : {}),
        ...(providerId === "ollama" ? { ollamaBaseUrl } : {}),
      });
      onStatusChange(response.status);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not configure embeddings.");
    } finally {
      setIsConfiguring(false);
    }
  };

  return (
    <Modal
      title="Semantic search"
      description="Choose a hosted or local embedding provider for this project."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!canConfigure || isConfiguring} onClick={() => void handleConfigure()}>
            {isConfiguring && <Loader2 className="mr-2 size-4 animate-spin" />}
            Save and index
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <ProviderChoice
            active={providerId === "openai"}
            icon={<Wifi className="size-4" />}
            title="Online"
            detail="OpenAI hosted embeddings"
            onClick={() => {
              setProviderId("openai");
              setCheckResult(null);
              setError(null);
            }}
          />
          <ProviderChoice
            active={providerId === "ollama"}
            icon={<HardDrive className="size-4" />}
            title="Offline"
            detail="Local Ollama embeddings"
            onClick={() => {
              setProviderId("ollama");
              setCredentialSource("none");
              setCheckResult(null);
              setError(null);
            }}
          />
        </div>

        {providerId === "openai" ? (
          <div className="space-y-3">
            <LabeledInput label="Model" value={openAiModel} onChange={setOpenAiModel} />
            {checkResult?.serverEnvAvailable && (
              <label className="flex items-center gap-2 text-sm text-brand-text-dark">
                <input
                  type="radio"
                  checked={credentialSource === "server_env"}
                  onChange={() => setCredentialSource("server_env")}
                />
                Use server environment OPENAI_API_KEY
              </label>
            )}
            {openAiCandidates.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase text-brand-text-light">Workspace env files</p>
                {openAiCandidates.map((candidate) => (
                  <label key={candidate.fileName} className="flex items-center gap-2 text-sm text-brand-text-dark">
                    <input
                      type="radio"
                      checked={credentialSource === "workspace_env" && workspaceEnvFile === candidate.fileName}
                      onChange={() => {
                        setCredentialSource("workspace_env");
                        setWorkspaceEnvFile(candidate.fileName);
                      }}
                    />
                    {candidate.fileName}
                  </label>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <LabeledInput
              label="Ollama URL"
              value={ollamaBaseUrl}
              onChange={(value) => {
                setOllamaBaseUrl(value);
                setCheckResult(null);
              }}
            />

            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-brand-text-light">
              <div className="flex items-start gap-2">
                {isLoadingOllamaModels ? (
                  <Loader2 className="mt-0.5 size-4 animate-spin text-brand-teal-dark" />
                ) : ollamaDiscovery?.reachable ? (
                  <CheckCircle2 className="mt-0.5 size-4 text-brand-teal-dark" />
                ) : (
                  <AlertCircle className="mt-0.5 size-4 text-amber-600" />
                )}
                <div className="min-w-0">
                  <p className="font-medium text-brand-text-dark">
                    {isLoadingOllamaModels ? "Checking local Ollama..." : (ollamaDiscovery?.message ?? "Ollama has not been checked yet.")}
                  </p>
                  {ollamaDiscovery?.hardware && (
                    <p className="mt-1 flex items-center gap-1">
                      <Cpu className="size-3" />
                      {hardwareLabel(ollamaDiscovery)}
                    </p>
                  )}
                  <p className="mt-1">Discovery only reads local metadata. It never downloads models.</p>
                </div>
              </div>
            </div>

            {ollamaDiscovery && !ollamaDiscovery.reachable && (
              <OllamaInstallGuideCard
                guide={ollamaInstallGuide(ollamaDiscovery.hardware.platform)}
                isLoading={isLoadingOllamaModels}
                onRecheck={() => void handleRefreshOllamaModels()}
              />
            )}

            {ollamaDiscovery?.reachable && (
              <>
                {ollamaDiscovery.suggestedModelId && (
                  <div className="rounded-lg border border-brand-teal-dark/30 bg-brand-teal-dark/5 p-3 text-sm">
                    <div className="mb-1 flex items-center gap-2 font-medium text-brand-text-dark">
                      <Sparkles className="size-4 text-brand-teal-dark" />
                      Recommended for this machine
                    </div>
                    <p className="text-brand-text-light">
                      {ollamaDiscovery.suggestedModelId} · {ollamaDiscovery.hardware.recommendationReason}
                    </p>
                    {ollamaDiscovery.embeddingModels.length === 0 && (
                      <ManualCommand command={`ollama pull ${ollamaDiscovery.suggestedModelId}`} />
                    )}
                  </div>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-semibold uppercase text-brand-text-light">Installed embedding models</p>
                    <Button type="button" variant="outline" size="sm" disabled={isLoadingOllamaModels} onClick={() => void handleRefreshOllamaModels()}>
                      {isLoadingOllamaModels ? <Loader2 className="mr-2 size-3 animate-spin" /> : <RefreshCw className="mr-2 size-3" />}
                      Recheck Ollama
                    </Button>
                  </div>
                  {ollamaDiscovery.embeddingModels.length ? (
                    <div className="grid gap-2">
                      {ollamaDiscovery.embeddingModels.map((model) => (
                        <OllamaModelCard
                          key={model.modelId}
                          model={model}
                          selected={ollamaModel === model.modelId}
                          onSelect={handleSelectOllamaModel}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-dashed border-gray-200 px-3 py-2 text-sm text-brand-text-light">
                      No installed Ollama embedding models were detected. Run one exact model command, then recheck.
                    </p>
                  )}
                  {otherInstalledOllamaModels.length > 0 && (
                    <p className="text-xs text-brand-text-light">
                      Detected non-embedding model{otherInstalledOllamaModels.length === 1 ? "" : "s"}:{" "}
                      {otherInstalledOllamaModels.map((model) => model.modelId).join(", ")}
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase text-brand-text-light">Recommended model commands</p>
                  <div className="grid gap-2">
                    {ollamaDiscovery.recommendedModels.map((model) => (
                      <OllamaModelCard
                        key={model.modelId}
                        model={model}
                        selected={ollamaModel === model.modelId}
                        onSelect={handleSelectOllamaModel}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-brand-text-light">Socrates will not download models from this screen. Run a command manually, then recheck Ollama.</p>
                </div>

                <LabeledInput
                  label="Selected or custom model"
                  value={ollamaModel}
                  onChange={(value) => {
                    setOllamaModel(value);
                    setCheckResult(null);
                  }}
                />
                <ManualCommand command={`ollama pull ${ollamaModel.trim() || "<model>"}`} />
              </>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="sm" disabled={isChecking || !canCheckSetup} onClick={() => void runCheck()}>
            {isChecking && <Loader2 className="mr-2 size-3 animate-spin" />}
            Check setup
          </Button>
          {checkResult && (
            <p className={`text-sm ${checkResult.ok ? "text-brand-text-light" : "text-red-600"}`}>{checkResult.message}</p>
          )}
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

function OllamaModelCard({
  model,
  selected,
  onSelect,
}: {
  model: OllamaEmbeddingModel;
  selected: boolean;
  onSelect: (modelId: string) => void;
}) {
  return (
    <div className={`rounded-lg border p-3 ${selected ? "border-brand-teal-dark bg-brand-teal-dark/5" : "border-gray-200 bg-white"}`}>
      <button type="button" className="w-full min-w-0 text-left" onClick={() => onSelect(model.modelId)}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-brand-text-dark">{model.name}</span>
          {model.recommendedForThisSystem && <Tag tone="teal">Suggested</Tag>}
          {model.installed ? <Tag tone="gray">Installed</Tag> : <Tag tone="gray">Not installed</Tag>}
          {model.sizeLabel && <Tag tone="gray">{model.sizeLabel}</Tag>}
        </div>
        <p className="mt-1 truncate text-sm text-brand-text-light">{model.modelId}</p>
        {model.description && <p className="mt-1 text-xs leading-5 text-brand-text-light">{model.description}</p>}
        {model.recommendationReason && <p className="mt-1 text-xs leading-5 text-brand-text-light">{model.recommendationReason}</p>}
      </button>
      {model.pullCommand && !model.installed && <ManualCommand command={model.pullCommand} />}
    </div>
  );
}

type OllamaInstallGuide = {
  command: string;
  osLabel: string;
};

function OllamaInstallGuideCard({
  guide,
  isLoading,
  onRecheck,
}: {
  guide: OllamaInstallGuide;
  isLoading: boolean;
  onRecheck: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-brand-text-dark">Install Ollama for {guide.osLabel}</p>
          <p className="mt-1 leading-5">Socrates did not find a running local Ollama server. Install Ollama from the official page, start it, then recheck.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" asChild>
              <a href={OLLAMA_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                <ExternalLink className="mr-2 size-3" />
                Install Ollama
              </a>
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={isLoading} onClick={onRecheck}>
              {isLoading ? <Loader2 className="mr-2 size-3 animate-spin" /> : <RefreshCw className="mr-2 size-3" />}
              Recheck Ollama
            </Button>
          </div>
          <ManualCommand command={guide.command} />
        </div>
      </div>
    </div>
  );
}

function ManualCommand({ command }: { command: string }) {
  return (
    <div className="mt-2 flex min-w-0 items-center gap-2 rounded bg-gray-50 px-2 py-1 text-xs text-brand-text-light">
      <Terminal className="size-3 shrink-0" />
      <code className="min-w-0 overflow-x-auto whitespace-nowrap font-mono">{command}</code>
    </div>
  );
}

function Tag({ children, tone }: { children: ReactNode; tone: "gray" | "teal" }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${tone === "teal" ? "bg-brand-teal-dark/10 text-brand-teal-dark" : "bg-gray-100 text-brand-text-light"}`}>
      {children}
    </span>
  );
}

function hardwareLabel(discovery: ListOllamaEmbeddingModelsResponse): string {
  const memoryGb = Math.round(discovery.hardware.totalMemoryBytes / 1024 / 1024 / 1024);
  const arch = discovery.hardware.arch === "arm64" ? "Apple Silicon / ARM64" : discovery.hardware.arch;
  return `${memoryGb} GB RAM, ${discovery.hardware.cpuCount} CPU cores, ${arch}`;
}

function ollamaInstallGuide(platform: string): OllamaInstallGuide {
  if (platform === "win32") {
    return { osLabel: "Windows", command: "irm https://ollama.com/install.ps1 | iex" };
  }
  if (platform === "linux") {
    return { osLabel: "Linux", command: "curl -fsSL https://ollama.com/install.sh | sh" };
  }
  if (platform === "darwin") {
    return { osLabel: "macOS", command: "curl -fsSL https://ollama.com/install.sh | sh" };
  }
  return { osLabel: platform, command: "Open https://ollama.com/download" };
}

function ProviderChoice({
  active,
  icon,
  title,
  detail,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border p-4 text-left transition ${
        active ? "border-brand-teal-dark bg-brand-teal-dark/5 text-brand-text-dark" : "border-gray-200 text-brand-text-light hover:border-gray-300"
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className="text-xs leading-5">{detail}</p>
    </button>
  );
}

function LabeledInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase text-brand-text-light">{label}</span>
      <input
        className="mt-1 w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-brand-text-dark outline-none focus:border-brand-teal-dark"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
