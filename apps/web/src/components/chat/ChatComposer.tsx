"use client";

import { ArrowUp, Brain, ChevronDown, EyeOff, FileText, ImagePlus, Square, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  MAX_INLINE_MESSAGE_CHARS,
  MAX_MESSAGE_ATTACHMENTS,
  type MessageAttachment,
  type ModelOption,
  type ModelThinkingOption,
} from "@socrates/contracts";
import { socratesApiBaseUrl } from "@/lib/api";

interface ChatComposerProps {
  isSending: boolean;
  isConnected: boolean;
  models: ModelOption[];
  selectedModel: ModelOption | null;
  selectedThinkingOption: ModelThinkingOption | null;
  warningResetKey?: string;
  onModelChange: (model: ModelOption) => void;
  onThinkingChange: (option: ModelThinkingOption) => void;
  onSend: (content: string, attachments: MessageAttachment[]) => Promise<void>;
  onUploadAttachments: (files: File[]) => Promise<MessageAttachment[]>;
  onStop: () => void;
}

export function ChatComposer({
  isSending,
  isConnected,
  models,
  selectedModel,
  selectedThinkingOption,
  warningResetKey,
  onModelChange,
  onThinkingChange,
  onSend,
  onUploadAttachments,
  onStop,
}: ChatComposerProps) {
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [isThinkingMenuOpen, setIsThinkingMenuOpen] = useState(false);
  const [dismissedVisionWarningKey, setDismissedVisionWarningKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const thinkingMenuRef = useRef<HTMLDivElement | null>(null);
  const canSend = (content.trim().length > 0 || attachments.length > 0) && !isSending && !isUploading && isConnected && Boolean(selectedModel);
  const selectedModelHasNoVision = selectedModel?.capabilities?.vision === false;
  const selectedModelKey = selectedModel ? modelKey(selectedModel) : "none";
  const selectedModelLabel = selectedModel ? `${selectedModel.label} · ${selectedModel.providerLabel}` : models.length === 0 ? "Connect provider" : "Model";
  const visionWarningKey = `${warningResetKey ?? "default"}:${selectedModelKey}`;
  const shouldShowVisionWarning = selectedModelHasNoVision && dismissedVisionWarningKey !== visionWarningKey;
  const modelGroups = groupModels(models);

  useEffect(() => {
    if (!isModelMenuOpen && !isThinkingMenuOpen) {
      return;
    }

    const closeMenus = () => {
      setIsModelMenuOpen(false);
      setIsThinkingMenuOpen(false);
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (modelMenuRef.current?.contains(target) || thinkingMenuRef.current?.contains(target))) {
        return;
      }
      closeMenus();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isModelMenuOpen, isThinkingMenuOpen]);

  const uploadFiles = async (fileList: File[] | FileList) => {
    const availableSlots = Math.max(0, MAX_MESSAGE_ATTACHMENTS - attachments.length);
    const files = Array.from(fileList)
      .filter((file) => file.type.startsWith("image/") || file.type === "text/plain")
      .slice(0, availableSlots);
    if (files.length === 0 || isUploading) {
      return;
    }
    setIsUploading(true);
    try {
      const uploaded = await onUploadAttachments(files);
      setAttachments((current) => [...current, ...uploaded].slice(0, MAX_MESSAGE_ATTACHMENTS));
    } finally {
      setIsUploading(false);
    }
  };

  const handleSend = async () => {
    const nextContent = content.trim();
    if ((!nextContent && attachments.length === 0) || isSending || isUploading) {
      return;
    }
    try {
      await onSend(nextContent, attachments);
      setContent("");
      setAttachments([]);
    } catch {
      // The parent owns the user-facing error state.
    }
  };

  return (
    <form
      className="w-full max-w-3xl"
      onDragOver={(event) => {
        event.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDraggingOver(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDraggingOver(false);
        void uploadFiles(event.dataTransfer.files);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSend();
      }}
    >
      {shouldShowVisionWarning && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
          <EyeOff className="mt-0.5 size-4 shrink-0" />
          <span>{selectedModel.label} does not support vision. Attached images will stay in the chat, but image pixels will not be sent to the model.</span>
          <button
            type="button"
            aria-label="Dismiss vision warning"
            onClick={() => setDismissedVisionWarningKey(visionWarningKey)}
            className="-mr-1 ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-full text-amber-700 transition-colors hover:bg-amber-100 hover:text-amber-900"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
      <div className={`relative rounded-xl border bg-white shadow-sm ${isDraggingOver ? "border-brand-teal-dark ring-2 ring-teal-100" : "border-gray-200"}`}>
        {attachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-4 pt-3">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="relative h-16 w-24 shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
                {attachment.kind === "image" ? (
                  <img
                    src={attachment.url ? `${socratesApiBaseUrl()}${attachment.url}` : attachment.uri}
                    alt={attachment.fileName}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-gray-600">
                    <FileText className="size-5" />
                    <span className="w-full truncate text-center text-[10px]">{attachment.fileName}</span>
                  </div>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${attachment.fileName}`}
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          className="block min-h-20 w-full resize-none rounded-xl bg-white px-4 py-3 pb-14 pr-14 text-sm leading-6 text-brand-text-dark outline-none placeholder:text-brand-text-light focus:border-brand-teal-dark"
          placeholder="Write a message..."
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onPaste={(event) => {
            const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (imageFiles.length > 0) {
              void uploadFiles(imageFiles);
              return;
            }
            const pastedText = event.clipboardData.getData("text/plain");
            if (pastedText.length > MAX_INLINE_MESSAGE_CHARS) {
              event.preventDefault();
              const file = new File(
                [pastedText],
                `pasted-text-${crypto.randomUUID().slice(0, 8)}.txt`,
                { type: "text/plain" },
              );
              void uploadFiles([file]);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
        />
        <div className="absolute bottom-2.5 left-3 flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,text/plain,.txt"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) {
                void uploadFiles(event.target.files);
              }
              event.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            className="inline-flex size-9 items-center justify-center rounded-full border border-gray-200 bg-gray-50 text-brand-text-light transition-colors hover:bg-gray-100 hover:text-brand-text-dark disabled:opacity-60"
            disabled={isSending || isUploading}
            aria-label="Attach image or text file"
            title="Attach image or text file"
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus className="size-4" />
          </button>
          <div ref={modelMenuRef} className="relative">
            <button
              type="button"
              className="inline-flex h-9 max-w-72 items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 text-sm font-medium text-brand-text-dark transition-colors hover:bg-gray-100"
              title={selectedModelLabel}
              onClick={() => {
                setIsModelMenuOpen((current) => !current);
                setIsThinkingMenuOpen(false);
              }}
            >
              <Sparkles className="size-4 text-brand-teal-dark" />
              <span className="truncate">{selectedModelLabel}</span>
              <ChevronDown className="size-4 text-brand-text-light" />
            </button>
            {isModelMenuOpen && (
              <div className="absolute bottom-12 left-0 z-20 max-h-80 w-72 overflow-y-auto rounded-xl border border-gray-200 bg-white p-2 shadow-xl">
                {models.length === 0 && (
                  <div className="px-3 py-2 text-sm text-brand-text-light">Connect a provider in Settings.</div>
                )}
                {modelGroups.map((group) => (
                  <div key={group.label} className="py-1">
                    <div className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase text-brand-text-light">
                      {group.label}
                    </div>
                    {group.models.map((model) => (
                      <button
                        key={modelKey(model)}
                        type="button"
                        className={`flex w-full flex-col rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                          selectedModel && modelKey(selectedModel) === modelKey(model)
                            ? "bg-gray-100 text-brand-text-dark"
                            : "text-brand-text-light hover:bg-gray-50 hover:text-brand-text-dark"
                        }`}
                        onClick={() => {
                          onModelChange(model);
                          setIsModelMenuOpen(false);
                        }}
                      >
                        <span className="font-medium">{model.label}</span>
                        <span className="text-xs">{model.providerLabel} · {model.capabilities?.vision === false ? "No vision" : "Vision"}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div ref={thinkingMenuRef} className="relative">
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 text-sm font-medium text-brand-text-dark transition-colors hover:bg-gray-100"
              disabled={!selectedModel}
              onClick={() => {
                setIsThinkingMenuOpen((current) => !current);
                setIsModelMenuOpen(false);
              }}
            >
              <Brain className="size-4 text-brand-teal-dark" />
              <span>{selectedThinkingOption?.label ?? "Thinking"}</span>
              <ChevronDown className="size-4 text-brand-text-light" />
            </button>
            {isThinkingMenuOpen && selectedModel && (
              <div className="absolute bottom-12 left-0 z-20 w-48 rounded-xl border border-gray-200 bg-white p-2 shadow-xl">
                {selectedModel.thinkingOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      selectedThinkingOption?.id === option.id
                        ? "bg-gray-100 text-brand-text-dark"
                        : "text-brand-text-light hover:bg-gray-50 hover:text-brand-text-dark"
                    }`}
                    onClick={() => {
                      onThinkingChange(option);
                      setIsThinkingMenuOpen(false);
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <button
          type={isSending ? "button" : "submit"}
          disabled={isSending ? false : !canSend}
          aria-label={isSending ? "Stop response" : "Send message"}
          onClick={isSending ? onStop : undefined}
          className="absolute bottom-2.5 right-3 flex size-9 items-center justify-center rounded-full bg-brand-button text-white transition-colors hover:bg-opacity-90 disabled:bg-gray-200 disabled:text-gray-500"
        >
          {isSending ? <Square className="size-4 fill-current" /> : <ArrowUp className="size-5" />}
        </button>
      </div>
    </form>
  );
}

const modelKey = (model: Pick<ModelOption, "providerId" | "authMode" | "modelId">): string =>
  `${model.providerId}:${model.authMode ?? "api_key"}:${model.modelId}`;

const groupModels = (models: ModelOption[]): Array<{ label: string; models: ModelOption[] }> => {
  const groups: Array<{ label: string; models: ModelOption[] }> = [];
  for (const model of models) {
    const existing = groups.find((group) => group.label === model.providerLabel);
    if (existing) {
      existing.models.push(model);
    } else {
      groups.push({ label: model.providerLabel, models: [model] });
    }
  }
  return groups;
};
