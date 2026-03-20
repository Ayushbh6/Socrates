"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  LayoutGrid,
  MessageSquare,
  Sparkles,
  UserRound,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import type { ConversationSummary } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

const navButtonClass =
  "transition-[background,border-color,color] duration-500 ease-in-out data-active:rounded-r-full data-active:border-l-2 data-active:border-primary data-active:bg-primary/10 data-active:text-primary data-active:shadow-[inset_12px_0_24px_-12px_rgb(114_220_255/0.12)]";

export function AppSidebar() {
  const pathname = usePathname();
  const [threads, setThreads] = useState<ConversationSummary[]>([]);

  useEffect(() => {
    const loadConversations = async () => {
      const response = await fetch("/api/conversations", {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as {
        conversations: ConversationSummary[];
      };
      setThreads(payload.conversations);
    };

    void loadConversations();
    window.addEventListener("premchat:conversations-changed", loadConversations);
    window.addEventListener("focus", loadConversations);

    return () => {
      window.removeEventListener(
        "premchat:conversations-changed",
        loadConversations
      );
      window.removeEventListener("focus", loadConversations);
    };
  }, [pathname]);

  return (
    <Sidebar
      collapsible="offcanvas"
      className="border-r border-sidebar-border/40 backdrop-blur-2xl"
    >
      <SidebarHeader className="gap-3 px-3 pt-4 pb-2">
        <div className="flex items-center gap-3 px-1">
          <div
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-full",
              "bg-linear-to-tr from-primary to-primary-container",
              "shadow-[0_0_18px_rgb(114_220_255/0.35)]"
            )}
          >
            <Sparkles className="size-5 text-primary-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-on-surface font-heading text-sm font-bold tracking-[0.12em] uppercase">
              PremChat
            </p>
            <p className="font-label text-primary/55 mt-0.5 text-[10px] tracking-[0.18em] uppercase">
              Sentient presence
            </p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="font-label text-[10px] tracking-[0.14em] uppercase">
            Navigate
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname.startsWith("/chat")}
                  tooltip="Chat"
                  className={navButtonClass}
                  render={<Link href="/chat" />}
                >
                  <MessageSquare />
                  <span className="tracking-wide">Chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname.startsWith("/workspaces")}
                  tooltip="Workspaces"
                  className={navButtonClass}
                  render={<Link href="/workspaces" />}
                >
                  <LayoutGrid />
                  <span className="tracking-wide">Workspaces</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname.startsWith("/profile")}
                  tooltip="Profile"
                  className={navButtonClass}
                  render={<Link href="/profile" />}
                >
                  <UserRound />
                  <span className="tracking-wide">Profile</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator className="bg-sidebar-border/40" />

        <SidebarGroup className="min-h-0 flex-1 flex-col">
          <Collapsible defaultOpen className="flex min-h-0 flex-1 flex-col">
            <div className="px-2">
              <CollapsibleTrigger className="font-label text-sidebar-foreground/70 hover:bg-sidebar-accent/25 data-panel-open:[&_svg]:rotate-180 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[10px] tracking-[0.14em] uppercase outline-none transition-colors duration-500">
                <ChevronDown className="size-4 shrink-0 transition-transform duration-500" />
                Conversations
              </CollapsibleTrigger>
              <Link
                href="/chat"
                className="font-label text-primary/80 hover:bg-primary/8 mt-1 flex h-8 items-center rounded-full px-3 text-[10px] tracking-[0.14em] uppercase transition-colors duration-300"
              >
                New chat
              </Link>
            </div>
            <CollapsibleContent className="min-h-0 flex-1">
              <SidebarGroupContent className="mt-1 min-h-0 pr-1">
                <ScrollArea className="h-[min(220px,32vh)]">
                  <SidebarMenuSub className="mx-0 border-l-0 px-0">
                    {threads.map((thread) => (
                      <SidebarMenuSubItem key={thread.id}>
                        <SidebarMenuSubButton
                          render={<Link href={`/chat/${thread.id}`} />}
                          className={cn(
                            "hover:bg-primary/5 h-10 w-full rounded-md pl-2",
                            pathname === `/chat/${thread.id}` && "bg-primary/8"
                          )}
                        >
                          <div className="min-w-0">
                            <span className="block truncate">{thread.title}</span>
                            <span className="text-sidebar-foreground/45 block truncate text-[11px]">
                              {thread.preview}
                            </span>
                          </div>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                    {threads.length === 0 ? (
                      <SidebarMenuSubItem>
                        <div className="text-sidebar-foreground/45 px-2 py-3 text-sm">
                          No conversations yet.
                        </div>
                      </SidebarMenuSubItem>
                    ) : null}
                  </SidebarMenuSub>
                </ScrollArea>
              </SidebarGroupContent>
            </CollapsibleContent>
          </Collapsible>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border/30 p-3">
        <div className="bg-surface-container-high/40 flex items-center gap-2 rounded-xl p-2">
          <div className="bg-surface-container-high flex size-8 items-center justify-center rounded-full border border-primary/15">
            <UserRound className="text-on-surface-variant size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-on-surface truncate text-xs font-medium">
              You
            </p>
            <p className="text-on-surface-variant truncate text-[10px]">
              Standard access
            </p>
          </div>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
