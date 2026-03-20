"use client";

import { useEffect, useRef } from "react";
import { ArrowUp, Mic, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ChatFooterProps = {
  disabled?: boolean;
  isCentered?: boolean;
  isStreaming?: boolean;
  onSubmit: () => void;
  onValueChange: (value: string) => void;
  value: string;
};

export function ChatFooter({
  disabled = false,
  isCentered = false,
  isStreaming = false,
  onSubmit,
  onValueChange,
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
        "w-full px-4 sm:px-6",
        isCentered
          ? "mx-auto max-w-4xl"
          : "shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))]"
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

          <div className="flex items-center justify-between px-1 pt-1">
            <div className="flex items-center gap-1">
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
