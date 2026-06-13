"use client";

import { useEffect, useState } from "react";
import { Bot, Loader2, Play, RefreshCw } from "lucide-react";
import type {
  GetMemoryAgentResponse,
  MemoryAgentGlobalSettings,
  ModelOption,
  ModelThinkingOption,
  ProviderId,
  UpdateMemoryAgentGlobalSettingsRequest,
} from "@socrates/contracts";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";

const cadenceOptions = [
  { value: 10, label: "Every 10 minutes" },
  { value: 30, label: "Every 30 minutes" },
  { value: 60, label: "Every hour" },
  { value: 300, label: "Every 5 hours" },
  { value: 1440, label: "Once a day" },
];

const providerLabels: Record<ProviderId, string> = {
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
};

export function MemoryAgentPanel() {
  const [data, setData] = useState<GetMemoryAgentResponse | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [memoryAgent, modelList] = await Promise.all([api.getMemoryAgent(), api.listModels()]);
    setData(memoryAgent);
    setModels(modelList.models);
  };

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const [memoryAgent, modelList] = await Promise.all([api.getMemoryAgent(), api.listModels()]);
        if (mounted) {
          setData(memoryAgent);
          setModels(modelList.models);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Could not load memory agent.");
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const save = async (input: UpdateMemoryAgentGlobalSettingsRequest) => {
    setIsSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.updateMemoryAgentSettings(input);
      setData((current) => (current ? { ...current, settings: response.settings } : current));
      setMessage("Memory agent settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save memory agent settings.");
    } finally {
      setIsSaving(false);
    }
  };

  const runNow = async () => {
    setIsRunning(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.runMemoryAgent();
      await load();
      setMessage(response.skippedReason ?? "Memory agent run finished.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run memory agent.");
    } finally {
      setIsRunning(false);
    }
  };

  const settings = data?.settings;
  const selectedModel = settings ? findModelForSettings(models, settings) : undefined;
  const selectedThinkingOption = settings && selectedModel ? findThinkingOptionForSettings(selectedModel, settings) : undefined;
  const modelKeyValue = selectedModel ? modelKey(selectedModel) : settings ? `${settings.providerId}:${settings.modelId}` : "";
  const thinkingValue = selectedThinkingOption?.id ?? "";
  const statusText = data ? `${data.state.status}${data.state.lastRunAt ? `, last run ${formatDate(data.state.lastRunAt)}` : ""}` : "Loading";

  return (
    <section className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-brand-teal-dark" />
            <h2 className="text-sm font-semibold text-brand-text-dark">Memory Agent</h2>
          </div>
          <p className="mt-1 text-xs text-brand-text-light">{statusText}</p>
        </div>
        <Button type="button" variant="outline" onClick={() => void runNow()} disabled={isLoading || isRunning}>
          {isRunning ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Play className="mr-2 size-4" />}
          Run now
        </Button>
      </div>

      {settings && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm text-brand-text-dark">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => void save({ enabled: event.target.checked })}
              disabled={isSaving}
              className="size-4 accent-brand-teal-dark"
            />
            Enabled
          </label>

          <label className="block text-sm font-medium text-brand-text-dark">
            Cadence
            <select
              value={settings.cadenceMinutes}
              onChange={(event) => void save({ cadenceMinutes: Number(event.target.value) })}
              disabled={isSaving}
              className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-brand-text-dark outline-none focus:border-brand-teal-dark"
            >
              {cadenceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm font-medium text-brand-text-dark sm:col-span-2">
            Model
            <select
              value={modelKeyValue}
              onChange={(event) => {
                const nextModel = models.find((model) => modelKey(model) === event.target.value);
                const thinkingOption = nextModel
                  ? nextModel.thinkingOptions.find((option) => option.id === nextModel.defaultThinkingOptionId) ?? nextModel.thinkingOptions[0]
                  : undefined;
                if (nextModel && thinkingOption) {
                  void save({
                    providerId: nextModel.providerId,
                    modelId: nextModel.modelId,
                    thinkingEnabled: thinkingOption.enabled,
                    ...(thinkingOption.effort ? { thinkingEffort: thinkingOption.effort } : {}),
                  });
                }
              }}
              disabled={models.length === 0 || isSaving}
              className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-brand-text-dark outline-none focus:border-brand-teal-dark disabled:bg-gray-50 disabled:text-brand-text-light"
            >
              {models.length === 0 && <option value={modelKeyValue}>{modelLabel(settings, selectedModel)}</option>}
              {models.map((model) => (
                <option key={modelKey(model)} value={modelKey(model)}>
                  {model.label} ({model.providerLabel})
                </option>
              ))}
            </select>
          </label>

          {selectedModel && (
            <label className="block text-sm font-medium text-brand-text-dark sm:col-span-2">
              Thinking
              <select
                value={thinkingValue}
                onChange={(event) => {
                  const option = selectedModel.thinkingOptions.find((item) => item.id === event.target.value);
                  if (option) {
                    void save({
                      thinkingEnabled: option.enabled,
                      ...(option.effort ? { thinkingEffort: option.effort } : {}),
                    });
                  }
                }}
                disabled={isSaving}
                className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-brand-text-dark outline-none focus:border-brand-teal-dark"
              >
                {selectedModel.thinkingOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      <div className="border-t border-gray-100 pt-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-brand-text-light">Recent runs</h3>
          <Button type="button" variant="ghost" size="icon" onClick={() => void load()} disabled={isLoading} aria-label="Refresh memory runs">
            <RefreshCw className="size-4" />
          </Button>
        </div>
        <div className="space-y-3">
          {data?.recentRuns.length === 0 && <p className="text-sm text-brand-text-light">No memory agent runs yet.</p>}
          {data?.recentRuns.map((run) => (
            <div key={run.id} className="rounded-lg border border-gray-100 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium text-brand-text-dark">{run.status}</span>
                <span className="text-xs text-brand-text-light">{formatDate(run.startedAt)}</span>
              </div>
              <p className="mt-1 text-xs text-brand-text-light">
                {run.trigger} / {run.evidenceTurnCount} turns / seq {run.sequenceFrom ?? "?"}-{run.sequenceTo ?? "?"}
              </p>
              {run.output && <p className="mt-2 line-clamp-3 text-sm text-brand-text-light">{run.output}</p>}
              {run.error && <p className="mt-2 text-sm text-red-600">{run.error}</p>}
              {run.actions.length > 0 && (
                <ul className="mt-2 space-y-1 text-xs text-brand-text-light">
                  {run.actions.map((action) => (
                    <li key={action.id}>
                      {action.status} {action.targetKind}: {shortPath(action.targetPath)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>

      {message && <p className="text-sm text-green-700">{message}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}

const modelKey = (model: Pick<ModelOption, "providerId" | "modelId">): string => `${model.providerId}:${model.modelId}`;

const findModelForSettings = (models: ModelOption[], settings: Pick<MemoryAgentGlobalSettings, "providerId" | "modelId">): ModelOption | undefined =>
  models.find((model) => model.providerId === settings.providerId && model.modelId === settings.modelId);

const findThinkingOptionForSettings = (
  model: ModelOption,
  settings: Pick<MemoryAgentGlobalSettings, "thinkingEnabled" | "thinkingEffort">,
): ModelThinkingOption | undefined =>
  model.thinkingOptions.find((option) => option.enabled === settings.thinkingEnabled && option.effort === settings.thinkingEffort) ??
  (!settings.thinkingEnabled ? model.thinkingOptions.find((option) => !option.enabled) : undefined) ??
  (settings.thinkingEnabled && (!settings.thinkingEffort || settings.thinkingEffort === "none")
    ? model.thinkingOptions.find((option) => option.enabled && !option.effort)
    : undefined);

const modelLabel = (settings: MemoryAgentGlobalSettings, model?: ModelOption): string =>
  model ? `${model.providerLabel} / ${model.label}` : `${providerLabels[settings.providerId]} / ${settings.modelId}`;

const formatDate = (value: string): string => new Date(value).toLocaleString();

const shortPath = (value: string): string => value.replace(/^.*\/\.Socrates\//, "~/.Socrates/");
