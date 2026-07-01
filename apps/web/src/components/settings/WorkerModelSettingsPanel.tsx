"use client";

import { useEffect, useMemo, useState } from "react";
import { Bot, BrainCircuit, CheckCircle2, Loader2, PencilLine, Route, Type } from "lucide-react";
import type { ModelOption, ModelThinkingOption, WorkerModelRole, WorkerModelSettings } from "@socrates/contracts";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";

const workers: Array<{
  id: WorkerModelRole;
  title: string;
  description: string;
  icon: typeof PencilLine;
}> = [
  {
    id: "skill_writer",
    title: "Skill Writer",
    description: "Writes approved skill creations and updates.",
    icon: PencilLine,
  },
  {
    id: "context_compactor",
    title: "Context Compactor",
    description: "Compresses long chat and worker context.",
    icon: BrainCircuit,
  },
  {
    id: "title_generator",
    title: "Title Generator",
    description: "Creates short names for new conversations.",
    icon: Type,
  },
  {
    id: "memory_router",
    title: "Memory Router",
    description: "Chooses project, repo, and profile recall before and after turns.",
    icon: Route,
  },
];

export function WorkerModelSettingsPanel() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [settings, setSettings] = useState<WorkerModelSettings[]>([]);
  const [savingWorkerId, setSavingWorkerId] = useState<WorkerModelRole | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const settingsByWorker = useMemo(
    () => new Map(settings.map((item) => [item.workerId, item] as const)),
    [settings],
  );

  const load = async () => {
    const [modelList, workerSettings] = await Promise.all([api.listModels(), api.listWorkerModelSettings()]);
    setModels(modelList.models);
    setSettings(workerSettings.settings);
  };

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const [modelList, workerSettings] = await Promise.all([api.listModels(), api.listWorkerModelSettings()]);
        if (mounted) {
          setModels(modelList.models);
          setSettings(workerSettings.settings);
          setError(null);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "Could not load worker model settings.");
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

  const save = async (workerId: WorkerModelRole, model: ModelOption, thinkingOption: ModelThinkingOption) => {
    setSavingWorkerId(workerId);
    setMessage(null);
    setError(null);
    try {
      const response = await api.updateWorkerModelSettings(workerId, {
        providerId: model.providerId,
        modelId: model.modelId,
        thinkingEnabled: thinkingOption.enabled,
        ...(thinkingOption.effort ? { thinkingEffort: thinkingOption.effort } : {}),
      });
      setSettings((current) => current.map((item) => (item.workerId === workerId ? response.settings : item)));
      setMessage(`${labelForWorker(workerId)} model saved.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save worker model setting.");
    } finally {
      setSavingWorkerId(null);
    }
  };

  const refresh = async () => {
    setIsLoading(true);
    setMessage(null);
    setError(null);
    try {
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh worker model settings.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-brand-teal-dark" />
            <h2 className="text-base font-semibold text-brand-text-dark">Worker models</h2>
          </div>
          <p className="mt-1 text-sm leading-6 text-brand-text-light">
            Choose helper models without changing the main chat model.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={isLoading || savingWorkerId !== null}>
          {isLoading ? <Loader2 className="mr-2 size-3 animate-spin" /> : null}
          Refresh
        </Button>
      </div>

      <div className="grid gap-3">
        {workers.map((worker) => {
          const setting = settingsByWorker.get(worker.id);
          const selectedModel = setting ? findModel(models, setting) : undefined;
          const selectedThinking = selectedModel && setting ? findThinkingOption(selectedModel, setting) : undefined;
          const Icon = worker.icon;
          const disabled = models.length === 0 || !setting || savingWorkerId !== null;

          return (
            <div key={worker.id} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 text-brand-teal-dark" />
                    <h3 className="text-sm font-semibold text-brand-text-dark">{worker.title}</h3>
                    {savingWorkerId === worker.id ? (
                      <Loader2 className="size-4 animate-spin text-brand-text-light" />
                    ) : setting ? (
                      <CheckCircle2 className="size-4 text-green-600" />
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-brand-text-light">{worker.description}</p>
                  <p className="mt-2 text-xs text-brand-text-light">
                    {selectedModel ? `${selectedModel.label} (${selectedModel.providerLabel})` : "No model selected."}
                  </p>
                </div>

                <div className="grid min-w-0 flex-1 gap-3 md:max-w-xl md:grid-cols-[minmax(0,1fr)_9rem]">
                  <label className="block text-xs font-medium text-brand-text-dark">
                    Model
                    <select
                      value={selectedModel ? modelKey(selectedModel) : ""}
                      onChange={(event) => {
                        const nextModel = models.find((model) => modelKey(model) === event.target.value);
                        const thinking = nextModel ? defaultThinkingOption(nextModel) : undefined;
                        if (nextModel && thinking) {
                          void save(worker.id, nextModel, thinking);
                        }
                      }}
                      disabled={disabled}
                      className="mt-2 h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-brand-text-dark outline-none transition focus:border-brand-teal-dark focus:ring-2 focus:ring-brand-teal-dark/10 disabled:bg-gray-50 disabled:text-brand-text-light"
                    >
                      {!selectedModel && <option value="">Choose model</option>}
                      {models.map((model) => (
                        <option key={modelKey(model)} value={modelKey(model)}>
                          {model.label} ({model.providerLabel})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block text-xs font-medium text-brand-text-dark">
                    Thinking
                    <select
                      value={selectedThinking?.id ?? ""}
                      onChange={(event) => {
                        if (!selectedModel) {
                          return;
                        }
                        const nextThinking = selectedModel.thinkingOptions.find((option) => option.id === event.target.value);
                        if (nextThinking) {
                          void save(worker.id, selectedModel, nextThinking);
                        }
                      }}
                      disabled={disabled || !selectedModel}
                      className="mt-2 h-10 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-brand-text-dark outline-none transition focus:border-brand-teal-dark focus:ring-2 focus:ring-brand-teal-dark/10 disabled:bg-gray-50 disabled:text-brand-text-light"
                    >
                      {selectedModel?.thinkingOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {message && <p className="text-sm text-green-700">{message}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}

const modelKey = (model: Pick<ModelOption, "providerId" | "modelId">): string => `${model.providerId}:${model.modelId}`;

const findModel = (models: ModelOption[], setting: Pick<WorkerModelSettings, "providerId" | "modelId">): ModelOption | undefined =>
  models.find((model) => model.providerId === setting.providerId && model.modelId === setting.modelId);

const defaultThinkingOption = (model: ModelOption): ModelThinkingOption | undefined =>
  model.thinkingOptions.find((option) => option.id === model.defaultThinkingOptionId) ?? model.thinkingOptions[0];

const findThinkingOption = (model: ModelOption, setting: Pick<WorkerModelSettings, "thinkingEnabled" | "thinkingEffort">): ModelThinkingOption | undefined =>
  model.thinkingOptions.find((option) => option.enabled === setting.thinkingEnabled && option.effort === setting.thinkingEffort) ??
  model.thinkingOptions.find((option) => option.enabled === setting.thinkingEnabled) ??
  defaultThinkingOption(model);

const labelForWorker = (workerId: WorkerModelRole): string => workers.find((worker) => worker.id === workerId)?.title ?? "Worker";
