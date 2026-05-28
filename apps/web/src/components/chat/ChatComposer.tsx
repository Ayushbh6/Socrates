"use client";

import { ArrowUp, Brain, ChevronDown, EyeOff, ImagePlus, Square, Sparkles, X } from "lucide-react";
import { useRef, useState } from "react";
import type { MessageAttachment, ModelOption, ModelThinkingOption } from "@socrates/contracts";
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
  const canSend = (content.trim().length > 0 || attachments.length > 0) && !isSending && !isUploading && isConnected && Boolean(selectedModel);
  const selectedModelHasNoVision = selectedModel?.capabilities?.vision === false;
  const selectedModelKey = selectedModel ? `${selectedModel.providerId}:${selectedModel.modelId}` : "none";
  const visionWarningKey = `${warningResetKey ?? "default"}:${selectedModelKey}`;
  const shouldShowVisionWarning = selectedModelHasNoVision && dismissedVisionWarningKey !== visionWarningKey;

  const uploadFiles = async (fileList: File[] | FileList) => {
    const files = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0 || isUploading) {
      return;
    }
    setIsUploading(true);
    try {
      const uploaded = await onUploadAttachments(files);
      setAttachments((current) => [...current, ...uploaded].slice(0, 12));
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
      <div className={`relative rounded-2xl border bg-white shadow-sm ${isDraggingOver ? "border-brand-teal-dark ring-2 ring-teal-100" : "border-gray-200"}`}>
        {attachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-4 pt-3">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="relative h-16 w-20 shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
                <img
                  src={attachment.url ? `${socratesApiBaseUrl()}${attachment.url}` : attachment.uri}
                  alt={attachment.fileName}
                  className="h-full w-full object-cover"
                />
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
          className="block min-h-28 w-full resize-none rounded-2xl bg-white px-5 py-4 pb-16 pr-16 text-base leading-7 text-brand-text-dark outline-none placeholder:text-brand-text-light focus:border-brand-teal-dark"
          placeholder="Write a message..."
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onPaste={(event) => {
            const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
            if (imageFiles.length > 0) {
              void uploadFiles(imageFiles);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
        />
        <div className="absolute bottom-3 left-3 flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
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
            className="inline-flex size-10 items-center justify-center rounded-full border border-gray-200 bg-gray-50 text-brand-text-light transition-colors hover:bg-gray-100 hover:text-brand-text-dark disabled:opacity-60"
            disabled={isSending || isUploading}
            aria-label="Attach image"
            title="Attach image"
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus className="size-4" />
          </button>
          <div className="relative">
            <button
              type="button"
              className="inline-flex h-10 max-w-52 items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 text-sm font-medium text-brand-text-dark transition-colors hover:bg-gray-100"
              onClick={() => {
                setIsModelMenuOpen((current) => !current);
                setIsThinkingMenuOpen(false);
              }}
            >
              <Sparkles className="size-4 text-brand-teal-dark" />
              <span className="truncate">{selectedModel?.label ?? "Model"}</span>
              <ChevronDown className="size-4 text-brand-text-light" />
            </button>
            {isModelMenuOpen && (
              <div className="absolute bottom-12 left-0 z-20 max-h-80 w-72 overflow-y-auto rounded-xl border border-gray-200 bg-white p-2 shadow-xl">
                {models.map((model) => (
                  <button
                    key={`${model.providerId}:${model.modelId}`}
                    type="button"
                    className={`flex w-full flex-col rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      selectedModel?.modelId === model.modelId && selectedModel.providerId === model.providerId
                        ? "bg-gray-100 text-brand-text-dark"
                        : "text-brand-text-light hover:bg-gray-50 hover:text-brand-text-dark"
                    }`}
                    onClick={() => {
                      onModelChange(model);
                      setIsModelMenuOpen(false);
                    }}
                  >
                    <span className="font-medium">{model.label}</span>
                    <span className="text-xs">
                      {model.providerLabel}
                      {model.capabilities?.vision === false ? " · no vision" : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative">
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-full border border-gray-200 bg-gray-50 px-3 text-sm font-medium text-brand-text-dark transition-colors hover:bg-gray-100"
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
          className="absolute bottom-3 right-3 flex size-10 items-center justify-center rounded-full bg-brand-button text-white transition-colors hover:bg-opacity-90 disabled:bg-gray-200 disabled:text-gray-500"
        >
          {isSending ? <Square className="size-4 fill-current" /> : <ArrowUp className="size-5" />}
        </button>
      </div>
    </form>
  );
}
