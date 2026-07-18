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
  value?: string;
  onValueChange?: (value: string) => void;
  voiceAvailable?: boolean;
  voiceRecording?: boolean;
  voiceBusy?: boolean;
  onModelChange: (model: ModelOption) => void;
  onThinkingChange: (option: ModelThinkingOption) => void;
  onSend: (content: string, attachments: MessageAttachment[]) => Promise<void>;
  onUploadAttachments: (files: File[]) => Promise<MessageAttachment[]>;
  onVoiceToggle?: () => void;
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
  value,
  onValueChange,
  voiceAvailable,
  voiceRecording,
  voiceBusy,
  onModelChange,
  onThinkingChange,
  onSend,
  onUploadAttachments,
  onVoiceToggle,
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
        value={value}
        onValueChange={onValueChange}
        voiceAvailable={voiceAvailable}
        voiceRecording={voiceRecording}
        voiceBusy={voiceBusy}
        onModelChange={onModelChange}
        onThinkingChange={onThinkingChange}
        onSend={onSend}
        onUploadAttachments={onUploadAttachments}
        onVoiceToggle={onVoiceToggle}
        onStop={onStop}
      />
    </div>
  );
}
