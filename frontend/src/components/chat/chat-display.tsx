"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { SentientOrb } from "@/components/sentient/sentient-orb";
import type { ChatMessage } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

type ChatDisplayProps = {
  isEmptyState: boolean;
  isStreaming: boolean;
  messages: ChatMessage[];
};

function EmptyStateOrb() {
  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="flex flex-col items-center gap-8 sm:gap-10">
        <SentientOrb variant="hero" showLabel={false} />
      </div>
    </div>
  );
}

function extractReasoningLines(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractReasoningLines(item));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferredKeys = ["text", "summary", "content", "title", "description"];
    for (const key of preferredKeys) {
      if (typeof record[key] === "string" && record[key]?.trim()) {
        return [String(record[key]).trim()];
      }
    }

    const nestedKeys = ["summary", "content", "details", "steps"];
    for (const key of nestedKeys) {
      if (record[key] !== undefined) {
        const nested = extractReasoningLines(record[key]);
        if (nested.length > 0) {
          return nested;
        }
      }
    }
  }

  return [];
}

function formatReasoningMarkdown(message: ChatMessage): string {
  const blocks: string[] = [];
  const text = message.reasoning?.text?.trim();
  if (text) {
    blocks.push(text);
  }

  const detailLines = extractReasoningLines(message.reasoning?.details ?? []);
  if (detailLines.length > 0) {
    const normalized = detailLines
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (normalized.length > 0) {
      blocks.push(normalized.map((line) => `- ${line}`).join("\n"));
    }
  }

  return blocks.join("\n\n").trim();
}

function ThinkingPanel({ message }: { message: ChatMessage }) {
  const [isOpen, setIsOpen] = useState(false);
  const markdown = useMemo(() => formatReasoningMarkdown(message), [message]);
  const isStreaming = message.reasoning?.status === "streaming";

  if (!message.reasoning) {
    return null;
  }

  return (
    <div className="max-w-[min(92%,40rem)] rounded-[1.4rem] border border-[#83dff2]/18 bg-[#0d1620]/82 px-4 py-3 text-[#cfe7f4] shadow-[0_10px_30px_rgba(0,0,0,0.22)] backdrop-blur-xl">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={() => setIsOpen((current) => !current)}
      >
        <div className="flex items-center gap-3">
          <span className="font-label text-[10px] tracking-[0.18em] uppercase text-[#8ad7eb]">
            Thinking
          </span>
          {message.reasoning?.status === "streaming" ? (
            <span className="flex items-center gap-1 text-[#89aabc]">
              <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:-0.2s]" />
              <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:-0.05s]" />
              <span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:0.1s]" />
            </span>
          ) : null}
        </div>
        <ChevronDown
          className={cn(
            "size-4 text-[#8fb8c8] transition-transform duration-300",
            isOpen && "rotate-180"
          )}
        />
      </button>

      {isOpen ? (
        <div className="mt-3 border-t border-white/6 pt-3">
          {markdown ? (
            <div className="text-[14px]">
              <ChatMarkdown content={markdown} />
            </div>
          ) : isStreaming ? (
            <p className="text-sm leading-6 text-[#a9bfd0]">
              Working through the reasoning…
            </p>
          ) : (
            <p className="text-sm leading-6 text-[#a9bfd0]">
              No reasoning details were returned for this step.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ChatDisplay({
  isEmptyState,
  isStreaming,
  messages,
}: ChatDisplayProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottom = useEffectEvent((behavior: ScrollBehavior) => {
    const container = scrollContainerRef.current;

    if (!container) {
      return;
    }

    container.scrollTo({
      top: container.scrollHeight,
      behavior,
    });
  });

  useEffect(() => {
    scrollToBottom(isStreaming ? "auto" : "smooth");
  }, [isStreaming, messages]);

  if (isEmptyState) {
    return <EmptyStateOrb />;
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden px-4 sm:px-6">
      <div className="pointer-events-none absolute inset-x-0 top-[6%] flex justify-center">
        <div className="opacity-28 blur-[1px] transition-opacity duration-700">
          <SentientOrb variant="hero" showLabel={false} className="scale-[1.18]" />
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className="relative z-10 mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col overflow-y-auto overscroll-contain pb-8 pt-4 sm:pb-10 sm:pt-6"
      >
        <div className="flex flex-col gap-5">
          {messages.map((message) => {
            const isUser = message.role === "user";
            const showThinkingPanel = !isUser && Boolean(message.reasoning);
            const showAssistantBubble =
              isUser || Boolean(message.content) || message.status === "error";

            return (
              <div
                key={message.id}
                className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
              >
                <div className={cn("flex w-full flex-col gap-3", isUser && "items-end")}>
                  {showThinkingPanel ? <ThinkingPanel message={message} /> : null}
                  {showAssistantBubble ? (
                    <div
                      className={cn(
                        "max-w-[min(92%,46rem)] rounded-[1.75rem] px-4 py-3 sm:px-5 sm:py-4",
                        isUser
                          ? "rounded-tr-md bg-[#151a24]/92 text-[#f3f7ff] shadow-[0_14px_40px_rgba(0,0,0,0.28)]"
                          : "rounded-tl-md border border-white/6 bg-[#111723]/88 text-[#eef5ff] shadow-[0_16px_44px_rgba(0,0,0,0.34)] backdrop-blur-xl"
                      )}
                    >
                      {!isUser ? (
                        <div className="mb-2 flex items-center gap-2 text-[#83dff2]/80">
                          <Sparkles className="size-3.5 shrink-0" />
                          <span className="font-label text-[10px] tracking-[0.18em] uppercase">
                            Prem
                          </span>
                          {message.model ? (
                            <span className="font-label text-[10px] tracking-[0.12em] uppercase text-[#9cb5d0]">
                              {message.model}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {isUser ? (
                        <p className="text-sm leading-7 tracking-[0.01em] sm:text-[15px]">
                          {message.content || (message.status === "streaming" ? "…" : "")}
                        </p>
                      ) : (
                        <ChatMarkdown
                          content={message.content || (message.status === "streaming" ? "…" : "")}
                        />
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
