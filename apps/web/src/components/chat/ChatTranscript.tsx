"use client";

import type { Message } from "@socrates/contracts";
import { ChevronDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatTranscriptProps {
  messages: Message[];
  liveThinking?: string;
  liveAnswer?: string;
  isStreaming?: boolean;
}

export function ChatTranscript({ messages, liveThinking, liveAnswer, isStreaming }: ChatTranscriptProps) {
  const isWaitingForFirstToken = Boolean(isStreaming && !liveThinking && !liveAnswer);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-8">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        {(liveThinking || liveAnswer || isStreaming) && (
          <div className="flex justify-start">
            <div className="max-w-2xl rounded-2xl rounded-tl-sm border border-gray-200 bg-white px-4 py-3 text-sm leading-6 text-brand-text-dark shadow-sm">
              {liveThinking && (
                <ThinkingBlock content={liveThinking} defaultOpen />
              )}
              {liveAnswer ? <MarkdownContent content={liveAnswer} /> : isWaitingForFirstToken ? <FirstTokenLoader /> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function FirstTokenLoader() {
  return (
    <div className="flex h-6 items-center">
      <span className="relative flex size-3">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-teal-dark opacity-25" />
        <span className="relative inline-flex size-3 animate-pulse rounded-full bg-brand-teal-dark shadow-[0_0_18px_rgba(20,184,166,0.55)]" />
      </span>
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
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <>
            {message.reasoning ? <ThinkingBlock content={message.reasoning} /> : null}
            <MarkdownContent content={message.content} />
          </>
        )}
      </div>
    </div>
  );
}

function ThinkingBlock({ content, defaultOpen = false }: { content: string; defaultOpen?: boolean }) {
  return (
    <details className="group mb-3 rounded-xl bg-gray-50 px-3 py-2 text-brand-text-light" open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium uppercase tracking-wide text-brand-teal-dark">
        <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
        Thinking
      </summary>
      <p className="mt-2 whitespace-pre-wrap">{content}</p>
    </details>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
        code: ({ children }) => <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.9em]">{children}</code>,
        pre: ({ children }) => <pre className="mb-3 overflow-x-auto rounded-xl bg-gray-950 p-4 text-gray-100">{children}</pre>,
        strong: ({ children }) => <strong className="font-semibold text-brand-text-dark">{children}</strong>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
