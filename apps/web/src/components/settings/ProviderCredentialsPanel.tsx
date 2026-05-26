"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { CheckCircle2, KeyRound, RefreshCw, Trash2, Upload } from "lucide-react";
import type { ProviderCredentialStatus, ProviderId } from "@socrates/contracts";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { desktopCredentials, desktopUpdates, isTauriRuntime, type DesktopUpdateStatus } from "@/lib/desktop";

const providerOrder: ProviderId[] = ["openrouter", "openai", "google"];

type ProviderCredentialsPanelProps = {
  showUpdater?: boolean;
  onOpenRouterReadyChange?: (ready: boolean) => void;
};

export function ProviderCredentialsPanel({ showUpdater = false, onOpenRouterReadyChange }: ProviderCredentialsPanelProps) {
  const [statuses, setStatuses] = useState<ProviderCredentialStatus[]>([]);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [envImportPath, setEnvImportPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<DesktopUpdateStatus>({ state: "idle" });
  const [desktopMode, setDesktopMode] = useState(false);

  const openRouterReady = useMemo(
    () => statuses.some((status) => status.providerId === "openrouter" && status.configured),
    [statuses],
  );

  useEffect(() => {
    onOpenRouterReadyChange?.(openRouterReady);
  }, [onOpenRouterReadyChange, openRouterReady]);

  useEffect(() => {
    setDesktopMode(isTauriRuntime());
  }, []);

  const loadStatus = async () => {
    const data = await api.getProviderCredentialStatus();
    setStatuses(data.providers);
  };

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
                </div>
                <Button type="button" size="icon" variant="ghost" onClick={() => void deleteCredential(providerId)} disabled={isBusy}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
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
    case "openai":
      return "OpenAI";
    case "google":
      return "Google";
  }
};

const descriptionFor = (providerId: ProviderId): string => {
  switch (providerId) {
    case "openrouter":
      return "Required for the default chat model and context compression.";
    case "openai":
      return "Required for hosted semantic embeddings when local Ollama is not used.";
    case "google":
      return "Optional chat provider.";
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
