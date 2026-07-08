"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, KeyRound, RefreshCw, Trash2, Upload } from "lucide-react";
import type { ProviderCredentialStatus, ProviderId } from "@socrates/contracts";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { desktopCredentials, desktopUpdates, isTauriRuntime, type DesktopUpdateStatus } from "@/lib/desktop";

const providerOrder: ProviderId[] = ["openrouter", "deepseek", "openai", "google"];

type ProviderCredentialsPanelProps = {
  showUpdater?: boolean;
  onConfiguredProviderReadyChange?: (ready: boolean) => void;
};

export function ProviderCredentialsPanel({ showUpdater = false, onConfiguredProviderReadyChange }: ProviderCredentialsPanelProps) {
  const [statuses, setStatuses] = useState<ProviderCredentialStatus[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [envImportPath, setEnvImportPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus>({ state: "idle" });
  const [desktopMode, setDesktopMode] = useState(false);

  const configuredProviderReady = useMemo(
    () => statuses.some((status) => status.configured),
    [statuses],
  );
  const chatGptCodexConfigured = useMemo(
    () => statuses.some((status) => status.authModes?.some((item) => item.authMode === "chatgpt_subscription" && item.configured)),
    [statuses],
  );
  const [isChatGptCodexAuthPending, setIsChatGptCodexAuthPending] = useState(false);

  useEffect(() => {
    onConfiguredProviderReadyChange?.(configuredProviderReady);
  }, [configuredProviderReady, onConfiguredProviderReadyChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDesktopMode(isTauriRuntime()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const loadStatus = useCallback(async () => {
    const data = await api.getProviderCredentialStatus();
    setStatuses(data.providers);
    return data.providers;
  }, []);

  useEffect(() => {
    if (!isChatGptCodexAuthPending) {
      return;
    }
    if (chatGptCodexConfigured) {
      setIsChatGptCodexAuthPending(false);
      setMessage("ChatGPT Codex signed in. Socrates will prefer ChatGPT Codex models by default.");
      return;
    }

    let attempts = 0;
    const interval = window.setInterval(() => {
      attempts += 1;
      void loadStatus().then((providers) => {
        const connected = providers.some((status) =>
          status.authModes?.some((item) => item.authMode === "chatgpt_subscription" && item.configured),
        );
        if (connected) {
          setIsChatGptCodexAuthPending(false);
          setMessage("ChatGPT Codex signed in. Socrates will prefer ChatGPT Codex models by default.");
        } else if (attempts >= 60) {
          setIsChatGptCodexAuthPending(false);
        }
      });
    }, 2000);

    return () => window.clearInterval(interval);
  }, [chatGptCodexConfigured, isChatGptCodexAuthPending, loadStatus]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const data = await api.getProviderCredentialStatus();
        if (mounted) {
          setStatuses(data.providers);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Could not load provider credentials.");
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const saveCredential = async (providerId: ProviderId) => {
    const apiKey = inputs[providerId]?.trim();
    if (!apiKey) {
      setError("Enter an API key before saving.");
      return;
    }
    setIsBusy(true);
    setError(null);
    setMessage(null);
    try {
      await desktopCredentials.save(providerId, apiKey);
      await api.setProviderCredentialSession({
        providerId,
        apiKey,
        source: isTauriRuntime() ? "keychain" : "local_file",
      });
      setInputs((current) => ({ ...current, [providerId]: "" }));
      await loadStatus();
      setMessage(`${labelFor(providerId)} credential saved.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save provider credential.");
    } finally {
      setIsBusy(false);
    }
  };

  const deleteCredential = async (providerId: ProviderId) => {
    const confirmed = window.confirm(`Remove the saved ${labelFor(providerId)} API key from Socrates?`);
    if (!confirmed) {
      return;
    }
    setIsBusy(true);
    setError(null);
    setMessage(null);
    try {
      await desktopCredentials.delete(providerId);
      await api.deleteProviderCredentialSession(providerId);
      await loadStatus();
      setMessage(`${labelFor(providerId)} credential removed.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete provider credential.");
    } finally {
      setIsBusy(false);
    }
  };

  const connectChatGptCodex = async () => {
    setIsBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.startOpenAiChatGptOAuth();
      window.open(response.authorizationUrl, "_blank", "noopener,noreferrer");
      setMessage("Finish ChatGPT Codex authorization in the browser window.");
      setIsChatGptCodexAuthPending(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start ChatGPT Codex authorization.");
    } finally {
      setIsBusy(false);
    }
  };

  const disconnectChatGptCodex = async () => {
    const confirmed = window.confirm("Remove the saved ChatGPT Codex connection from Socrates?");
    if (!confirmed) {
      return;
    }
    setIsBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.deleteOpenAiChatGptOAuth();
      await loadStatus();
      setMessage("ChatGPT Codex connection removed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove ChatGPT Codex connection.");
    } finally {
      setIsBusy(false);
    }
  };

  const importEnvFile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const path = envImportPath.trim();
    if (!path) {
      setError("Enter the absolute path to an environment file.");
      return;
    }
    setIsBusy(true);
    setError(null);
    setMessage(null);
    try {
      const imported = await desktopCredentials.importEnvFile(path);
      if (!imported) {
        setError("Environment import is available only in the packaged desktop app.");
        return;
      }
      await Promise.all(
        imported.map((credential) =>
          api.setProviderCredentialSession({
            providerId: credential.providerId,
            apiKey: credential.apiKey,
            source: "env_import",
          }),
        ),
      );
      setMessage(`Imported ${imported.length} credential${imported.length === 1 ? "" : "s"} into the OS keychain.`);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import provider credentials.");
    } finally {
      setIsBusy(false);
    }
  };

  const checkForUpdate = async () => {
    setUpdateStatus(await desktopUpdates.check());
  };

  const installUpdate = async () => {
    setUpdateStatus(await desktopUpdates.downloadAndInstall());
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        {providerOrder.map((providerId) => {
          const status = statuses.find((item) => item.providerId === providerId);
          const chatGptCodexStatus = status?.authModes?.find((item) => item.authMode === "chatgpt_subscription");
          return (
            <div key={providerId} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <KeyRound className="size-4 text-brand-teal-dark" />
                    <h3 className="text-sm font-semibold text-brand-text-dark">{labelFor(providerId)}</h3>
                    {status?.configured && <CheckCircle2 className="size-4 text-green-600" />}
                  </div>
                  <p className="mt-1 text-xs text-brand-text-light">{descriptionFor(providerId)}</p>
                  <p className="mt-2 text-xs text-brand-text-light">
                    {status?.configured ? `Configured from ${status.source}.` : "Not configured."}
                  </p>
                  {status?.authModes && status.authModes.length > 1 && (
                    <div className="mt-3 space-y-1 text-xs text-brand-text-light">
                      {status.authModes.map((authMode) => (
                        <div key={authMode.authMode} className="flex items-center gap-2">
                          {authMode.configured && <CheckCircle2 className="size-3.5 text-green-600" />}
                          <span>{authMode.label}: {authMode.configured ? `connected (${authMode.source})` : "not configured"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {providerId === "openai" && chatGptCodexStatus?.configured && (
                    <div className="mt-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs leading-5 text-green-800">
                      ChatGPT Codex is signed in. Socrates will prefer ChatGPT Codex models by default, while API-key models remain selectable.
                    </div>
                  )}
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => void deleteCredential(providerId)}
                  disabled={isBusy || !status?.configured}
                  aria-label={`Remove saved ${labelFor(providerId)} API key`}
                  title={`Remove saved ${labelFor(providerId)} API key`}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              {providerId === "openai" && (
                <div className="mt-3 flex flex-col gap-2 border-t border-gray-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-xs text-brand-text-light">ChatGPT Codex subscription auth</div>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" onClick={() => void connectChatGptCodex()} disabled={isBusy}>
                      <ExternalLink className="mr-2 size-4" />
                      Connect
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      onClick={() => void disconnectChatGptCodex()}
                      disabled={isBusy || !status?.authModes?.some((item) => item.authMode === "chatgpt_subscription" && item.configured)}
                      aria-label="Remove ChatGPT Codex connection"
                      title="Remove ChatGPT Codex connection"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              )}
              <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                <input
                  type="password"
                  value={inputs[providerId] ?? ""}
                  onChange={(event) => setInputs((current) => ({ ...current, [providerId]: event.target.value }))}
                  placeholder={`${labelFor(providerId)} API key`}
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-teal-dark"
                />
                <Button type="button" variant="outline" onClick={() => void saveCredential(providerId)} disabled={isBusy}>
                  Save
                </Button>
              </div>
            </div>
          );
        })}
      </section>

      {desktopMode && (
        <form onSubmit={importEnvFile} className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-brand-text-dark">
            <Upload className="size-4 text-brand-teal-dark" />
            Import from .env
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={envImportPath}
              onChange={(event) => setEnvImportPath(event.target.value)}
              placeholder="/absolute/path/to/.env"
              className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-teal-dark"
            />
            <Button type="submit" variant="outline" disabled={isBusy}>
              Import
            </Button>
          </div>
        </form>
      )}

      {showUpdater && (
        <section className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-brand-text-dark">Updates</h3>
              <p className="mt-1 text-xs text-brand-text-light">{updateMessage(updateStatus)}</p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => void checkForUpdate()}>
                <RefreshCw className="mr-2 size-4" />
                Check
              </Button>
              {updateStatus.state === "available" && (
                <Button type="button" onClick={() => void installUpdate()}>
                  Install
                </Button>
              )}
            </div>
          </div>
        </section>
      )}

      {message && <p className="text-sm text-green-700">{message}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}

const labelFor = (providerId: ProviderId): string => {
  switch (providerId) {
    case "openrouter":
      return "OpenRouter";
    case "deepseek":
      return "DeepSeek";
    case "openai":
      return "OpenAI";
    case "google":
      return "Google";
    case "ollama":
      return "Ollama";
  }
};

const descriptionFor = (providerId: ProviderId): string => {
  switch (providerId) {
    case "openrouter":
      return "Required for the default chat model and context compression.";
    case "deepseek":
      return "Optional direct provider for official DeepSeek V4 models and KV-cache accounting.";
    case "openai":
      return "Required for hosted semantic embeddings when local Ollama is not used.";
    case "google":
      return "Optional chat provider.";
    case "ollama":
      return "Local chat provider detected from installed Ollama models.";
  }
};

const updateMessage = (status: DesktopUpdateStatus): string => {
  switch (status.state) {
    case "idle":
      return "Check for a signed stable release update.";
    case "available":
      return `Version ${status.version} is available.`;
    case "installed":
    case "not_available":
    case "unavailable":
    case "failed":
      return status.message;
  }
};
