"use client";

import { ArrowUp, Mic, Plus, Sparkles } from "lucide-react";
import { SentientOrb } from "@/components/sentient/sentient-orb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const DEMO_USER =
  "PremChat, summarize how resonance with the workspace has shifted this week.";

const DEMO_ASSISTANT = (
  <>
    Your workspace resonance is{" "}
    <span className="text-primary font-medium">stable and high-trust</span>.
    Quiet focus blocks have lengthened; I am holding context lightly so you can
    steer without friction.
  </>
);

export function ChatView() {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[18%] -left-[12%] h-[58%] w-[58%] rounded-full bg-[radial-gradient(circle,rgb(5_78_95/0.28)_0%,transparent_68%)] blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-[12%] -bottom-[12%] h-[48%] w-[48%] rounded-full bg-[radial-gradient(circle,rgb(114_220_255/0.12)_0%,transparent_70%)] blur-[100px]"
      />

      <div className="relative z-10 flex min-h-0 flex-1 flex-col px-4 pb-6">
        <div className="flex shrink-0 flex-col items-center pt-4 pb-2 md:pt-6 md:pb-4">
          <SentientOrb variant="compact" showLabel={false} />
        </div>

        <ScrollArea className="min-h-0 w-full flex-1 px-1 pb-4">
          <div className="mx-auto flex max-w-2xl flex-col gap-6 py-2">
            <div className="flex justify-end pr-1">
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl rounded-tr-md px-4 py-3",
                  "border border-border/40 bg-surface-container-high/55 backdrop-blur-md"
                )}
              >
                <p className="text-on-surface text-sm leading-relaxed tracking-wide">
                  {DEMO_USER}
                </p>
                <p className="font-label text-on-surface-variant/70 mt-2 text-[9px] tracking-[0.12em] uppercase">
                  You · now
                </p>
              </div>
            </div>

            <div className="flex justify-start pl-1">
              <div
                className={cn(
                  "max-w-[90%] rounded-2xl rounded-tl-md border border-primary/15 px-4 py-4",
                  "bg-card/75 backdrop-blur-md",
                  "shadow-[0_12px_40px_rgb(114_220_255/0.06)]"
                )}
              >
                <div className="mb-2 flex items-center gap-2">
                  <Sparkles className="text-primary size-3.5 shrink-0" />
                  <span className="font-label text-primary text-[10px] tracking-[0.15em] uppercase">
                    Neural response
                  </span>
                </div>
                <p className="text-on-surface text-sm leading-relaxed tracking-wide">
                  {DEMO_ASSISTANT}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="font-label border-primary/25 text-primary hover:bg-primary/8 h-7 rounded-md text-[9px] tracking-[0.08em] uppercase"
                  >
                    Show context
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="font-label border-primary/25 text-primary hover:bg-primary/8 h-7 rounded-md text-[9px] tracking-[0.08em] uppercase"
                  >
                    Adjust tone
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>

        <div className="mx-auto mt-auto w-full max-w-2xl shrink-0 px-1 pt-2">
          <div
            className={cn(
              "flex items-center gap-1 rounded-full border border-primary/20 p-1.5 pl-2",
              "bg-card/80 shadow-[0_12px_48px_rgb(0_0_0/0.35)] backdrop-blur-md"
            )}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-on-surface-variant hover:text-primary shrink-0"
              aria-label="Attach"
            >
              <Plus className="size-5" />
            </Button>
            <Input
              placeholder="Speak to PremChat…"
              className="border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-on-surface-variant hover:text-primary shrink-0"
              aria-label="Voice input"
            >
              <Mic className="size-5" />
            </Button>
            <Button
              type="button"
              size="icon"
              className="size-10 shrink-0 rounded-full bg-linear-to-tr from-primary to-primary-container text-primary-foreground shadow-[0_0_20px_rgb(114_220_255/0.35)] transition-[filter] duration-500 hover:brightness-110"
              aria-label="Send message"
            >
              <ArrowUp className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
