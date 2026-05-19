"use client";

import type { Message } from "@socrates/contracts";

interface ChatTranscriptProps {
  messages: Message[];
}

export function ChatTranscript({ messages }: ChatTranscriptProps) {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-8">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          isUser
            ? "max-w-2xl rounded-2xl rounded-tr-sm bg-brand-button px-4 py-3 text-sm leading-6 text-white"
            : "max-w-2xl rounded-2xl rounded-tl-sm border border-gray-200 bg-white px-4 py-3 text-sm leading-6 text-brand-text-dark shadow-sm"
        }
      >
        <p className="whitespace-pre-wrap">{message.content}</p>
      </div>
    </div>
  );
}
