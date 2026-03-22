"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronDown,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Sparkles,
  Trash2,
  UserRound,
  X,
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
  SidebarMenuSubItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import type { ConversationSummary } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

const navButtonClass =
  "transition-[background,border-color,color] duration-500 ease-in-out data-active:rounded-r-full data-active:border-l-2 data-active:border-primary data-active:bg-primary/10 data-active:text-primary data-active:shadow-[inset_12px_0_24px_-12px_rgb(114_220_255/0.12)]";

function dispatchConversationChange() {
  window.dispatchEvent(new CustomEvent("premchat:conversations-changed"));
}

function dispatchConversationMutated(conversation: {
  id: string;
  title: string;
  provider: string;
  model: string;
  thinkingEnabled: boolean;
}) {
  window.dispatchEvent(
    new CustomEvent("premchat:conversation-mutated", {
      detail: conversation,
    })
  );
}

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [threads, setThreads] = useState<ConversationSummary[]>([]);
  const [menuThreadId, setMenuThreadId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [savingThreadId, setSavingThreadId] = useState<string | null>(null);

  const loadConversations = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    void loadConversations();
    window.addEventListener("premchat:conversations-changed", loadConversations);
    window.addEventListener("focus", loadConversations);

    return () => {
      window.removeEventListener("premchat:conversations-changed", loadConversations);
      window.removeEventListener("focus", loadConversations);
    };
  }, [loadConversations, pathname]);

  useEffect(() => {
    setMenuThreadId(null);
    setConfirmDeleteId(null);
  }, [pathname]);

  const currentConversationId = useMemo(() => {
    const match = pathname.match(/^\/chat\/([^/]+)$/);
    return match?.[1] ?? null;
  }, [pathname]);

  const handleRenameStart = (thread: ConversationSummary) => {
    setRenamingThreadId(thread.id);
    setRenameValue(thread.title);
    setMenuThreadId(thread.id);
    setConfirmDeleteId(null);
  };

  const handleRenameCommit = async (thread: ConversationSummary) => {
    const nextTitle = renameValue.trim() || "New conversation";
    setRenamingThreadId(null);
    setMenuThreadId(null);

    if (nextTitle === thread.title) {
      setRenameValue("");
      return;
    }

    setSavingThreadId(thread.id);
    setThreads((current) =>
      current.map((item) =>
        item.id === thread.id ? { ...item, title: nextTitle } : item
      )
    );

    try {
      const response = await fetch(`/api/conversations/${thread.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: nextTitle }),
      });

      if (!response.ok) {
        throw new Error("Unable to rename conversation.");
      }

      const payload = (await response.json()) as {
        conversation: {
          id: string;
          title: string;
          provider: string;
          model: string;
          thinkingEnabled: boolean;
        };
      };

      dispatchConversationMutated(payload.conversation);
      dispatchConversationChange();
      void loadConversations();
    } catch {
      void loadConversations();
    } finally {
      setSavingThreadId(null);
      setRenameValue("");
    }
  };

  const handleDelete = async (thread: ConversationSummary) => {
    setSavingThreadId(thread.id);
    setThreads((current) => current.filter((item) => item.id !== thread.id));

    try {
      const response = await fetch(`/api/conversations/${thread.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status: "deleted" }),
      });

      if (!response.ok) {
        throw new Error("Unable to delete conversation.");
      }

      dispatchConversationChange();
      if (currentConversationId === thread.id) {
        router.push("/chat");
      }
      void loadConversations();
    } catch {
      void loadConversations();
    } finally {
      setSavingThreadId(null);
      setMenuThreadId(null);
      setConfirmDeleteId(null);
    }
  };

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
                    {threads.map((thread) => {
                      const isCurrent = pathname === `/chat/${thread.id}`;
                      const isRenaming = renamingThreadId === thread.id;
                      const isMenuOpen = menuThreadId === thread.id;
                      const isConfirmingDelete = confirmDeleteId === thread.id;
                      const isSaving = savingThreadId === thread.id;

                      return (
                        <SidebarMenuSubItem key={thread.id}>
                          <div
                            className={cn(
                              "group relative rounded-md transition-colors",
                              isCurrent && "bg-primary/8"
                            )}
                          >
                            {isRenaming ? (
                              <div className="flex items-center gap-2 px-2 py-2">
                                <input
                                  autoFocus
                                  value={renameValue}
                                  disabled={isSaving}
                                  className="h-8 min-w-0 flex-1 rounded-full border border-white/10 bg-[#0f1520] px-3 text-sm text-[#eef5ff] outline-none focus:border-[#83dff2]/45"
                                  onChange={(event) => setRenameValue(event.target.value)}
                                  onBlur={() => {
                                    void handleRenameCommit(thread);
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      event.preventDefault();
                                      void handleRenameCommit(thread);
                                    }
                                    if (event.key === "Escape") {
                                      event.preventDefault();
                                      setRenamingThreadId(null);
                                      setMenuThreadId(null);
                                      setRenameValue("");
                                    }
                                  }}
                                />
                                <button
                                  type="button"
                                  className="text-sidebar-foreground/55 hover:text-on-surface rounded-full p-1 transition-colors"
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => {
                                    setRenamingThreadId(null);
                                    setMenuThreadId(null);
                                    setRenameValue("");
                                  }}
                                >
                                  <X className="size-4" />
                                </button>
                              </div>
                            ) : (
                              <div className="relative">
                                <Link
                                  href={`/chat/${thread.id}`}
                                  className={cn(
                                    "hover:bg-primary/5 block rounded-md px-2 py-2.5 pr-11 transition-colors",
                                    isCurrent && "bg-transparent"
                                  )}
                                >
                                  <div className="min-w-0">
                                    <span className="block truncate">{thread.title}</span>
                                  </div>
                                </Link>
                                <button
                                  type="button"
                                  aria-label={`Conversation actions for ${thread.title}`}
                                  className={cn(
                                    "text-sidebar-foreground/55 hover:text-on-surface hover:bg-white/6 absolute top-2 right-1 rounded-full p-1 transition-all",
                                    isCurrent || isMenuOpen
                                      ? "opacity-100"
                                      : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                                  )}
                                  onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setMenuThreadId((current) =>
                                      current === thread.id ? null : thread.id
                                    );
                                    setConfirmDeleteId(null);
                                  }}
                                >
                                  <MoreHorizontal className="size-4" />
                                </button>
                              </div>
                            )}

                            {isMenuOpen && !isRenaming ? (
                              <div className="absolute top-10 right-2 z-20 w-44 rounded-2xl border border-white/8 bg-[#101722]/96 p-1.5 shadow-[0_20px_48px_rgba(0,0,0,0.35)] backdrop-blur-xl">
                                {isConfirmingDelete ? (
                                  <div className="space-y-2 p-1">
                                    <p className="px-2 text-[11px] leading-5 text-[#c3d3e8]">
                                      Delete this conversation?
                                    </p>
                                    <button
                                      type="button"
                                      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm text-[#ffd0d0] transition-colors hover:bg-[#ff5a5a]/10"
                                      onClick={() => {
                                        void handleDelete(thread);
                                      }}
                                    >
                                      <Trash2 className="size-4" />
                                      Delete conversation
                                    </button>
                                    <button
                                      type="button"
                                      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm text-[#c7d5e8] transition-colors hover:bg-white/6"
                                      onClick={() => setConfirmDeleteId(null)}
                                    >
                                      <X className="size-4" />
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <>
                                    <button
                                      type="button"
                                      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm text-[#dce8f7] transition-colors hover:bg-white/6"
                                      onClick={() => handleRenameStart(thread)}
                                    >
                                      <Pencil className="size-4" />
                                      Rename
                                    </button>
                                    <button
                                      type="button"
                                      className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm text-[#ffcbcb] transition-colors hover:bg-[#ff5a5a]/10"
                                      onClick={() => setConfirmDeleteId(thread.id)}
                                    >
                                      <Trash2 className="size-4" />
                                      Delete
                                    </button>
                                  </>
                                )}
                              </div>
                            ) : null}
                          </div>
                        </SidebarMenuSubItem>
                      );
                    })}
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
            <p className="text-on-surface truncate text-xs font-medium">You</p>
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
