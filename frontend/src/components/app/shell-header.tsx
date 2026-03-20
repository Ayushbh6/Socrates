"use client";

import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

export function ShellHeader() {
  const { state, isMobile } = useSidebar();
  const showLogoMark = state === "collapsed" || isMobile;

  return (
    <header className="bg-background/65 flex h-12 shrink-0 items-center gap-2 border-b border-border/40 px-3 backdrop-blur-xl transition-colors duration-500">
      <SidebarTrigger />
      {showLogoMark ? (
        <Link
          href="/home"
          className="flex items-center gap-2 rounded-lg py-1 pr-2 pl-1 transition-opacity duration-500 hover:opacity-90"
          aria-label="PremChat — Welcome"
        >
          <div
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-full",
              "bg-linear-to-tr from-primary to-primary-container",
              "shadow-[0_0_16px_rgb(114_220_255/0.3)]"
            )}
          >
            <Sparkles className="size-4 text-primary-foreground" />
          </div>
          <span className="font-heading text-on-surface hidden text-xs font-bold tracking-[0.14em] uppercase sm:inline">
            PremChat
          </span>
        </Link>
      ) : null}
      <Separator
        orientation="vertical"
        className="data-[orientation=vertical]:h-6 bg-border/35"
      />
    </header>
  );
}
