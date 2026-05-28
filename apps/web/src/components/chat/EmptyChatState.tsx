"use client";

import { ChatComposer } from "./ChatComposer";
import type { MessageAttachment, ModelOption, ModelThinkingOption } from "@socrates/contracts";

interface EmptyChatStateProps {
  error?: string | null;
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

export function EmptyChatState({
  error,
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
}: EmptyChatStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      <ChatComposer
        isSending={isSending}
        isConnected={isConnected}
        models={models}
        selectedModel={selectedModel}
        selectedThinkingOption={selectedThinkingOption}
        warningResetKey={warningResetKey}
        onModelChange={onModelChange}
        onThinkingChange={onThinkingChange}
        onSend={onSend}
        onUploadAttachments={onUploadAttachments}
        onStop={onStop}
      />
    </div>
  );
}
