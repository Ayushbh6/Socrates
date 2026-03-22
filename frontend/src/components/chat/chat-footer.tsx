"use client";

import { useEffect, useRef } from "react";
import { ArrowUp, Mic, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ModelOption } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

type ChatFooterProps = {
  disabled?: boolean;
  isCentered?: boolean;
  isStreaming?: boolean;
  models?: ModelOption[];
  onSubmit: () => void;
  onModelChange: (value: string) => void;
  onThinkingEnabledChange: (value: boolean) => void;
  onValueChange: (value: string) => void;
  selectedModel: string;
  thinkingEnabled: boolean;
  value: string;
};

export function ChatFooter({
  disabled = false,
  isCentered = false,
  isStreaming = false,
  models = [],
  onSubmit,
  onModelChange,
  onThinkingEnabledChange,
  onValueChange,
  selectedModel,
  thinkingEnabled,
  value,
}: ChatFooterProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;

    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [value]);

  return (
    <div
      className={cn(
        "sticky bottom-0 z-30 w-full bg-[#0a111a]/88 px-4 backdrop-blur-xl sm:px-6",
        isCentered
          ? "mx-auto max-w-4xl"
          : "shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3"
      )}
    >
      <form
        className={cn(
          "mx-auto w-full max-w-4xl",
          isCentered ? "" : "pb-2"
        )}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div
          className={cn(
            "rounded-[1.75rem] bg-[#171c25]/92 p-2 shadow-[0_20px_80px_rgba(0,0,0,0.28)] backdrop-blur-2xl",
            isCentered ? "border border-white/8" : "border border-white/6"
          )}
        >
          <textarea
            ref={textareaRef}
            value={value}
            placeholder="Message PremChat…"
            disabled={disabled}
            rows={1}
            className="max-h-[180px] min-h-[72px] w-full resize-none border-0 bg-transparent px-4 py-3 text-base leading-7 text-[#eef5ff] outline-none placeholder:text-[#8b96a8] disabled:cursor-not-allowed disabled:opacity-70 sm:min-h-[88px]"
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onSubmit();
              }
            }}
          />

          <div className="flex items-center justify-between gap-3 px-1 pt-1">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-[#8f9aad] hover:bg-white/5 hover:text-[#d9ecff]"
                aria-label="Attach"
              >
                <Plus className="size-4.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-[#8f9aad] hover:bg-white/5 hover:text-[#d9ecff]"
                aria-label="Voice input"
              >
                <Mic className="size-4.5" />
              </Button>
              <label className="min-w-0">
                <span className="sr-only">Model</span>
                <select
                  value={selectedModel}
                  disabled={disabled}
                  className="h-9 max-w-[14rem] rounded-full border border-white/8 bg-[#0f1520] px-3 text-xs tracking-[0.04em] text-[#dce8f7] outline-none transition-colors focus:border-[#83dff2]/45 disabled:cursor-not-allowed disabled:opacity-60"
                  onChange={(event) => onModelChange(event.target.value)}
                >
                  {models.length === 0 ? (
                    <option value={selectedModel}>{selectedModel}</option>
                  ) : null}
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={disabled}
                className={cn(
                  "h-9 rounded-full border px-3 text-[11px] tracking-[0.14em] uppercase transition-colors",
                  thinkingEnabled
                    ? "border-[#83dff2]/35 bg-[#123242]/70 text-[#d6f5ff]"
                    : "border-white/8 bg-[#0f1520] text-[#9aa6b8]",
                  disabled && "cursor-not-allowed opacity-60"
                )}
                onClick={() => onThinkingEnabledChange(!thinkingEnabled)}
              >
                Think {thinkingEnabled ? "On" : "Off"}
              </button>
            </div>

            <Button
              type="submit"
              size="icon"
              disabled={disabled || !value.trim()}
              className="size-10 rounded-full bg-linear-to-tr from-primary to-primary-container text-primary-foreground shadow-[0_0_24px_rgb(114_220_255/0.3)] transition-[filter,transform] duration-300 hover:brightness-110 disabled:opacity-50"
              aria-label={isStreaming ? "Streaming response" : "Send message"}
            >
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
