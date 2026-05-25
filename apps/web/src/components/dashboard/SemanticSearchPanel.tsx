"use client";

import { BrainCircuit, HardDrive, Loader2, RefreshCw, Wifi } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";
import type {
  CheckProjectEmbeddingsResponse,
  ProjectEmbeddingCredentialSource,
  ProjectEmbeddingProvider,
  ProjectEmbeddingStatus,
} from "@socrates/contracts";

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_OLLAMA_MODEL = "embeddinggemma";
const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

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
  const [error, setError] = useState<string | null>(null);

  const modelId = providerId === "openai" ? openAiModel : ollamaModel;
  const openAiCandidates = useMemo(
    () => checkResult?.workspaceEnvCandidates?.filter((candidate) => candidate.hasOpenAiApiKey) ?? [],
    [checkResult],
  );
  const canConfigure =
    checkResult?.ok &&
    (providerId === "ollama" ||
      credentialSource === "server_env" ||
      (credentialSource === "workspace_env" && workspaceEnvFile.length > 0));

  const handleCheck = async () => {
    setIsChecking(true);
    setError(null);
    try {
      const response = await api.checkProjectEmbeddings(projectId, {
        providerId,
        modelId,
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
          <div className="space-y-3">
            <LabeledInput label="Model" value={ollamaModel} onChange={setOllamaModel} />
            <LabeledInput label="Ollama URL" value={ollamaBaseUrl} onChange={setOllamaBaseUrl} />
          </div>
        )}

        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="sm" disabled={isChecking} onClick={() => void handleCheck()}>
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
