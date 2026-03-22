"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { Sparkles } from "lucide-react";
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
    <div className="relative min-h-0 flex-1 overflow-hidden px-4 pb-2 sm:px-6">
      <div className="pointer-events-none absolute inset-x-0 top-[6%] flex justify-center">
        <div className="opacity-28 blur-[1px] transition-opacity duration-700">
          <SentientOrb variant="hero" showLabel={false} className="scale-[1.18]" />
        </div>
      </div>

      <div
        ref={scrollContainerRef}
        className="relative z-10 mx-auto flex h-full w-full max-w-4xl flex-col overflow-y-auto overscroll-contain pb-6 pt-4 sm:pb-8 sm:pt-6"
      >
        <div className="flex flex-col gap-5">
          {messages.map((message) => {
            const isUser = message.role === "user";

            return (
              <div
                key={message.id}
                className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
              >
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
                  {!isUser && message.reasoning ? (
                    <details className="mt-3 rounded-2xl border border-white/8 bg-black/10 p-3">
                      <summary className="cursor-pointer list-none text-[10px] tracking-[0.16em] text-[#8acfe1] uppercase">
                        Thinking
                      </summary>
                      {message.reasoning.text ? (
                        <p className="mt-2 text-xs leading-6 text-[#b9c7da]">
                          {message.reasoning.text}
                        </p>
                      ) : null}
                      {Array.isArray(message.reasoning.details) &&
                      message.reasoning.details.length > 0 ? (
                        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-[#91a2b9]">
                          {JSON.stringify(message.reasoning.details, null, 2)}
                        </pre>
                      ) : null}
                    </details>
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
