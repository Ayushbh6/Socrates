"use client";

import Link from "next/link";
import { Share2, SquarePen } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ChatHeaderProps = {
  conversationId?: string;
  title: string;
};

export function ChatHeader({ conversationId, title }: ChatHeaderProps) {
  const handleShare = async () => {
    if (!conversationId) {
      return;
    }

    await navigator.clipboard.writeText(window.location.href);
  };

  return (
    <header className="flex h-16 shrink-0 items-center justify-between px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <SidebarTrigger className="text-on-surface-variant hover:bg-white/5 hover:text-on-surface" />
        <div className="min-w-0">
          <p className="text-on-surface truncate text-sm font-medium tracking-tight sm:text-base">
            {title}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Link
          href="/chat"
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "text-on-surface-variant hover:bg-white/5 hover:text-on-surface rounded-full px-3"
          )}
        >
          <SquarePen className="size-4" />
          New chat
        </Link>
        {conversationId ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleShare}
            className="text-on-surface-variant hover:bg-white/5 hover:text-on-surface rounded-full px-3"
          >
            <Share2 className="size-4" />
            Share
          </Button>
        ) : null}
      </div>
    </header>
  );
}
