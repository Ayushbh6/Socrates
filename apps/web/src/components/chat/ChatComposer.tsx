"use client";

import { ArrowUp, Loader2 } from "lucide-react";
import { useState } from "react";

interface ChatComposerProps {
  isSending: boolean;
  onSend: (content: string) => Promise<void>;
}

export function ChatComposer({ isSending, onSend }: ChatComposerProps) {
  const [content, setContent] = useState("");
  const canSend = content.trim().length > 0 && !isSending;

  const handleSend = async () => {
    const nextContent = content.trim();
    if (!nextContent || isSending) {
      return;
    }
    try {
      await onSend(nextContent);
      setContent("");
    } catch {
      // The parent owns the user-facing error state.
    }
  };

  return (
    <form
      className="w-full max-w-3xl"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSend();
      }}
    >
      <div className="relative rounded-2xl border border-gray-200 bg-white shadow-sm">
        <textarea
          className="block min-h-28 w-full resize-none rounded-2xl bg-white px-5 py-4 pr-16 text-base leading-7 text-brand-text-dark outline-none placeholder:text-brand-text-light focus:border-brand-teal-dark"
          placeholder="Write a message..."
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          className="absolute bottom-3 right-3 flex size-10 items-center justify-center rounded-full bg-brand-button text-white transition-colors hover:bg-opacity-90 disabled:bg-gray-200 disabled:text-gray-500"
        >
          {isSending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-5" />}
        </button>
      </div>
    </form>
  );
}
