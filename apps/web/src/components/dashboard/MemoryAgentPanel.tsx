"use client";

import { Bot, Loader2, Pencil } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { GetProjectResponse, MemoryAgentSettings, ModelOption, ModelThinkingOption, ProviderId } from "@socrates/contracts";

const providerLabels: Record<ProviderId, string> = {
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
};

export function MemoryAgentPanel({
  settings,
  models,
  isSaving,
  onSave,
}: {
  settings: MemoryAgentSettings;
  models: ModelOption[];
  isSaving: boolean;
  onSave: (settings: Pick<MemoryAgentSettings, "providerId" | "modelId" | "thinkingEnabled" | "thinkingEffort">) => Promise<void>;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selectedModel = findModelForSettings(models, settings);
  const selectedThinkingOption = selectedModel ? findThinkingOptionForSettings(selectedModel, settings) : undefined;
  const modelLabel = selectedModel ? `${selectedModel.providerLabel} / ${selectedModel.label}` : `${providerLabels[settings.providerId]} / ${settings.modelId}`;
  const thinkingLabel = selectedThinkingOption?.label ?? (settings.thinkingEnabled ? "On" : "Off");

  return (
    <div className="border-b border-gray-200 py-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-brand-teal-dark" />
          <h3 className="font-medium text-brand-text-dark">Memory Agent</h3>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setIsOpen(true)}
          aria-label="Configure memory agent"
          title="Configure memory agent"
          className="size-6 rounded-full text-brand-text-light hover:bg-gray-100 hover:text-brand-text-dark"
        >
          <Pencil className="size-4" />
        </Button>
      </div>
      <div className="space-y-1 text-sm text-brand-text-light">
        <p className="truncate">{modelLabel}</p>
        <p>Thinking {thinkingLabel}</p>
      </div>
      {isOpen && (
        <MemoryAgentDialog
          initialSettings={settings}
          models={models}
          isSaving={isSaving}
          onCancel={() => setIsOpen(false)}
          onSave={async (nextSettings) => {
            await onSave(nextSettings);
            setIsOpen(false);
          }}
        />
      )}
    </div>
  );
}

function MemoryAgentDialog({
  initialSettings,
  models,
  isSaving,
  onCancel,
  onSave,
}: {
  initialSettings: GetProjectResponse["memoryAgentSettings"];
  models: ModelOption[];
  isSaving: boolean;
  onCancel: () => void;
  onSave: (settings: Pick<MemoryAgentSettings, "providerId" | "modelId" | "thinkingEnabled" | "thinkingEffort">) => Promise<void>;
}) {
  const initialModel = findModelForSettings(models, initialSettings) ?? models[0];
  const [selectedModelKey, setSelectedModelKey] = useState(initialModel ? modelKey(initialModel) : "");
  const selectedModel = models.find((model) => modelKey(model) === selectedModelKey);
  const initialThinkingOption =
    selectedModel && initialModel && modelKey(selectedModel) === modelKey(initialModel)
      ? findThinkingOptionForSettings(selectedModel, initialSettings) ??
        selectedModel.thinkingOptions.find((option) => option.id === selectedModel.defaultThinkingOptionId) ??
        selectedModel.thinkingOptions[0]
      : undefined;
  const [selectedThinkingOptionId, setSelectedThinkingOptionId] = useState(
    initialThinkingOption?.id ?? selectedModel?.defaultThinkingOptionId ?? selectedModel?.thinkingOptions[0]?.id ?? "",
  );
  const selectedThinkingOption = selectedModel?.thinkingOptions.find((option) => option.id === selectedThinkingOptionId);
  const [error, setError] = useState<string | null>(null);

  const canSave = Boolean(selectedModel && selectedThinkingOption) && !isSaving;

  const handleSave = async () => {
    if (!canSave || !selectedModel || !selectedThinkingOption) {
      return;
    }
    setError(null);
    try {
      await onSave({
        providerId: selectedModel.providerId,
        modelId: selectedModel.modelId,
        thinkingEnabled: selectedThinkingOption.enabled,
        ...(selectedThinkingOption.effort ? { thinkingEffort: selectedThinkingOption.effort } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save memory agent settings.");
    }
  };

  return (
    <Modal
      title="Memory Agent"
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSave} onClick={() => void handleSave()}>
            {isSaving && <Loader2 className="mr-2 size-4 animate-spin" />}
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <label className="block text-sm font-medium text-brand-text-dark">
          Model
          <select
            value={selectedModelKey}
            onChange={(event) => {
              const nextModel = models.find((model) => modelKey(model) === event.target.value);
              setSelectedModelKey(event.target.value);
              setSelectedThinkingOptionId(
                nextModel?.thinkingOptions.find((option) => option.id === nextModel.defaultThinkingOptionId)?.id ??
                  nextModel?.thinkingOptions[0]?.id ??
                  "",
              );
            }}
            disabled={models.length === 0}
            className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-brand-text-dark outline-none focus:border-brand-teal-dark disabled:bg-gray-50 disabled:text-brand-text-light"
          >
            {models.length === 0 && <option value="">No models available</option>}
            {models.map((model) => (
              <option key={modelKey(model)} value={modelKey(model)}>
                {model.label} ({model.providerLabel})
              </option>
            ))}
          </select>
        </label>

        {selectedModel && (
          <label className="block text-sm font-medium text-brand-text-dark">
            Thinking
            <select
              value={selectedThinkingOptionId}
              onChange={(event) => setSelectedThinkingOptionId(event.target.value)}
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

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

const modelKey = (model: Pick<ModelOption, "providerId" | "modelId">): string => `${model.providerId}:${model.modelId}`;

const findModelForSettings = (models: ModelOption[], settings: Pick<MemoryAgentSettings, "providerId" | "modelId">): ModelOption | undefined =>
  models.find((model) => model.providerId === settings.providerId && model.modelId === settings.modelId);

const findThinkingOptionForSettings = (
  model: ModelOption,
  settings: Pick<MemoryAgentSettings, "thinkingEnabled" | "thinkingEffort">,
): ModelThinkingOption | undefined =>
  model.thinkingOptions.find((option) => option.enabled === settings.thinkingEnabled && option.effort === settings.thinkingEffort) ??
  (!settings.thinkingEnabled ? model.thinkingOptions.find((option) => !option.enabled) : undefined) ??
  (settings.thinkingEnabled && (!settings.thinkingEffort || settings.thinkingEffort === "none")
    ? model.thinkingOptions.find((option) => option.enabled && !option.effort)
    : undefined);
