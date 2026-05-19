"use client";

import { ChatComposer } from "./ChatComposer";

interface EmptyChatStateProps {
  error?: string | null;
  isSending: boolean;
  onSend: (content: string) => Promise<void>;
}

export function EmptyChatState({ error, isSending, onSend }: EmptyChatStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6">
      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
      <ChatComposer isSending={isSending} onSend={onSend} />
    </div>
  );
}
