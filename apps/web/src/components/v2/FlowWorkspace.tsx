"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowUpRight,
  LayoutDashboard,
  PanelRightClose,
  PanelRightOpen,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { V2MessageAttachment } from "@socrates/contracts";
import { ChatComposer, type ChatComposerProps } from "@/components/chat/ChatComposer";
import { ProjectChatSidebar, type SidebarProject } from "@/components/chat/ProjectChatSidebar";
import { WorkspaceTopbar } from "@/components/chat/WorkspaceTopbar";
import { LivingSphere } from "./LivingSphere";
import { V2ViewLink } from "./V2ViewLink";
import { V2SpeechPackManager } from "./V2SpeechPackManager";
import { FlowWorkspaceNotes } from "./FlowWorkspaceNotes";
import { FlowWorkspaceInspector, type FlowInspectorView } from "./FlowWorkspaceInspector";
import styles from "./seamless.module.css";
import type {
  FlowContextSummary,
  FlowApprovalView,
  FlowCredentialRequestView,
  FlowGoalView,
  FlowPresenceState,
  FlowTimelineItemView,
  FlowTerminalActivityView,
  FlowToolActivityView,
  FlowVoiceOption,
} from "./types";

export interface FlowWorkspaceProps {
  projectId: string;
  projectName: string;
  sidebarProjects: SidebarProject[];
  timeline?: FlowTimelineItemView[];
  goals?: FlowGoalView[];
  activeGoalId?: string;
  currentTaskLabel?: string;
  presenceState?: FlowPresenceState;
  statusLabel?: string;
  contextSummary?: FlowContextSummary;
  approvals?: FlowApprovalView[];
  toolActivity?: FlowToolActivityView[];
  terminalActivity?: FlowTerminalActivityView[];
  credentialRequests?: FlowCredentialRequestView[];
  feedbackByMessageId?: Record<string, "thumbs_up" | "thumbs_down">;
  voiceOptions?: FlowVoiceOption[];
  selectedVoiceOptionId?: string;
  voiceStatusLabel?: string;
  hasEarlierMessages?: boolean;
  isLoadingEarlierMessages?: boolean;
  earlierMessagesError?: string;
  composer: ChatComposerProps<V2MessageAttachment>;
  onReadAloud?: (itemId: string) => void;
  activeReadAloudMessageId?: string | undefined;
  readAloudStatus?: "synthesizing" | "speaking" | undefined;
  onApprovalDecision?: (approvalId: string, decision: "approved" | "rejected") => void;
  onCredentialResolve?: (request: FlowCredentialRequestView, decision: "submitted" | "cancelled", value?: string) => void;
  onFeedback?: (messageId: string, rating: "thumbs_up" | "thumbs_down") => void;
  onVoiceOptionChange?: (optionId: string) => void;
  onTerminalInput?: (terminalId: string, text: string) => void;
  onTerminalStop?: (terminalId: string) => void;
  onTerminalRename?: (terminalId: string, name: string) => void;
  onLoadEarlierMessages?: () => void;
  onFocusAction?: (goalId: string, action: "switch" | "pause" | "finish" | "reopen" | "archive" | "pin" | "unpin") => void;
  onOpenInClassic?: (goalId: string) => void;
}

export function FlowWorkspace({
  projectId,
  projectName,
  sidebarProjects,
  timeline = [],
  goals = [],
  activeGoalId,
  currentTaskLabel = "Ready for your next thought",
  presenceState = "offline",
  statusLabel = "Seamless runtime disconnected",
  contextSummary,
  approvals = [],
  toolActivity = [],
  terminalActivity = [],
  credentialRequests = [],
  feedbackByMessageId = {},
  voiceOptions = [],
  selectedVoiceOptionId,
  voiceStatusLabel,
  hasEarlierMessages = false,
  isLoadingEarlierMessages = false,
  earlierMessagesError,
  composer,
  onReadAloud,
  activeReadAloudMessageId,
  readAloudStatus,
  onApprovalDecision,
  onCredentialResolve,
  onFeedback,
  onVoiceOptionChange,
  onTerminalInput,
  onTerminalStop,
  onTerminalRename,
  onLoadEarlierMessages,
  onFocusAction,
  onOpenInClassic,
}: FlowWorkspaceProps) {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(true);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [isInspectorPinned, setIsInspectorPinned] = useState(false);
  const [inspectorView, setInspectorView] = useState<FlowInspectorView>("context");
  const [isSpeechPacksOpen, setIsSpeechPacksOpen] = useState(false);
  const speechPackDialogRef = useRef<HTMLDivElement>(null);
  const speechPackCloseRef = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();
  const activeGoal = useMemo(
    () => goals.find((goal) => goal.id === activeGoalId) ?? goals.find((goal) => goal.status === "foreground"),
    [activeGoalId, goals],
  );
  const pausedGoalCount = useMemo(
    () => goals.filter((goal) => goal.status === "parked" || goal.status === "blocked").length,
    [goals],
  );

  const openInspector = (view: FlowInspectorView) => {
    setInspectorView(view);
    setIsInspectorOpen(true);
  };

  useEffect(() => {
    if (!isSpeechPacksOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    speechPackCloseRef.current?.focus();
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsSpeechPacksOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = speechPackDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.removeEventListener("keydown", handleDialogKeys);
      document.body.style.overflow = previousBodyOverflow;
      previouslyFocused?.focus();
    };
  }, [isSpeechPacksOpen]);

  useEffect(() => {
    if (!isInspectorOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSpeechPacksOpen) setIsInspectorOpen(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isInspectorOpen, isSpeechPacksOpen]);

  return (
    <main className={styles.flowPage}>
      <div className={styles.oceanNoise} aria-hidden="true" />

      <ProjectChatSidebar
        projects={sidebarProjects}
        currentProjectId={projectId}
        isCollapsed={isSidebarCollapsed}
        onCollapse={() => setIsSidebarCollapsed(true)}
        onExpand={() => setIsSidebarCollapsed(false)}
        mode="projects"
        overlay
        projectHref={(targetProjectId) => `/seamless/projects/${encodeURIComponent(targetProjectId)}`}
      />

      <section className={styles.flowShell} data-inspector={isInspectorOpen ? "open" : "closed"}>
        <WorkspaceTopbar isSidebarCollapsed={isSidebarCollapsed}>
          <V2ViewLink
            view="classic"
            href={`/projects/${encodeURIComponent(projectId)}`}
            className="mr-4 inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-brand-text-light shadow-sm hover:bg-gray-50 hover:text-brand-text-dark"
            title="Project dashboard"
            aria-label="Project dashboard"
          >
            <LayoutDashboard className="size-4" />
            <span className="hidden sm:inline">Dashboard</span>
          </V2ViewLink>
          <h1 className="min-w-0 truncate text-sm font-medium text-brand-text-dark">{projectName}</h1>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-brand-text-light shadow-sm hover:bg-gray-50 hover:text-brand-text-dark"
              onClick={() => isInspectorOpen ? setIsInspectorOpen(false) : openInspector("context")}
              aria-controls="v2-goal-inspector"
              aria-expanded={isInspectorOpen}
            >
              {isInspectorOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
              <span>{isInspectorOpen ? "Hide notes" : "Working notes"}</span>
            </button>
            <button
              type="button"
              className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-brand-text-light shadow-sm hover:bg-gray-50 hover:text-brand-text-dark disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!activeGoal || !onOpenInClassic}
              onClick={() => {
                if (activeGoal) onOpenInClassic?.(activeGoal.id);
              }}
            >
              <span>Classic View</span>
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </button>
          </div>
        </WorkspaceTopbar>

        <div className={styles.flowBody}>
          <section
            className={styles.flowCanvas}
            aria-label="Seamless conversation"
            onPointerDown={() => {
              if (isInspectorOpen && !isInspectorPinned) setIsInspectorOpen(false);
            }}
          >
            <div className={styles.flowConversation} data-has-items={timeline.length > 0 || undefined}>
              <div className={styles.presenceStage}>
                <div className={styles.assistantDesk}>
                  <FlowWorkspaceNotes
                    projectId={projectId}
                    activeGoal={activeGoal}
                    currentTaskLabel={currentTaskLabel}
                    contextSummary={contextSummary}
                    pausedGoalCount={pausedGoalCount}
                    compact={timeline.length > 0}
                    onOpenContext={() => openInspector("context")}
                    onOpenFocuses={() => openInspector("focuses")}
                  />
                  <div className={styles.deskSphere}>
                    <LivingSphere
                      state={presenceState}
                      size={timeline.length > 0 ? "compact" : "full"}
                      statusLabel={statusLabel}
                    />
                  </div>
                </div>
              </div>

              {(timeline.length > 0 || hasEarlierMessages || earlierMessagesError) && (
                <div className={styles.timelineScroller}>
                  <div className={styles.timeline}>
                {(hasEarlierMessages || earlierMessagesError) && (
                  <div className={styles.earlierMessagesControl}>
                    {hasEarlierMessages && onLoadEarlierMessages && (
                      <button
                        type="button"
                        onClick={onLoadEarlierMessages}
                        disabled={isLoadingEarlierMessages}
                      >
                        {isLoadingEarlierMessages ? "Loading earlier messages…" : "Load earlier messages"}
                      </button>
                    )}
                    {earlierMessagesError && <p role="alert">{earlierMessagesError}</p>}
                  </div>
                )}

                {timeline.length > 0 && (
                  <ol className={styles.timelineList} aria-label="Flow timeline">
                    {timeline.map((item, index) => (
                      <motion.li
                        key={item.id}
                        className={styles.timelineItem}
                        data-role={item.role}
                        initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.24, delay: Math.min(index, 4) * 0.035 }}
                      >
                        <div className={styles.timelineItemMeta}>
                          <span>{item.role === "assistant" ? "Socrates" : item.role === "user" ? "You" : "Flow"}</span>
                          {item.status === "streaming" && <span>Writing…</span>}
                        </div>
                        {item.reasoning && (
                          <details className={styles.messageReasoning}>
                            <summary>Thinking</summary>
                            <p>{item.reasoning}</p>
                          </details>
                        )}
                        <div className={styles.messageMarkdown}>
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown>
                        </div>
                        {item.attachments && item.attachments.length > 0 && (
                          <ul className={styles.messageAttachments} aria-label="Message attachments">
                            {item.attachments.map((attachment) => (
                              <li key={attachment.id}>
                                {attachment.url ? (
                                  <a href={attachment.url} target="_blank" rel="noreferrer">
                                    {attachment.fileName}
                                  </a>
                                ) : (
                                  <span>{attachment.fileName}</span>
                                )}
                                <small>{attachment.kind.replaceAll("_", " ")}</small>
                              </li>
                            ))}
                          </ul>
                        )}
                        {item.role === "assistant" && item.readAloudAvailable && onReadAloud && (
                          <div className={styles.messageActions}>
                            <button
                              type="button"
                              className={styles.readAloudControl}
                              onClick={() => onReadAloud(item.id)}
                              disabled={Boolean(activeReadAloudMessageId && activeReadAloudMessageId !== item.id)}
                              data-active={activeReadAloudMessageId === item.id || undefined}
                              aria-label={activeReadAloudMessageId === item.id ? "Stop reading response" : "Read response aloud"}
                              title={activeReadAloudMessageId === item.id
                                ? readAloudStatus === "synthesizing" ? "Preparing speech — click to stop" : "Stop reading"
                                : "Read aloud"}
                            >
                              {activeReadAloudMessageId === item.id
                                ? <Square aria-hidden="true" />
                                : <Volume2 aria-hidden="true" />}
                            </button>
                            {onFeedback && (
                              <>
                                <button
                                  type="button"
                                  data-selected={feedbackByMessageId[item.id] === "thumbs_up" || undefined}
                                  onClick={() => onFeedback(item.id, "thumbs_up")}
                                  aria-label="Helpful response"
                                >
                                  <ThumbsUp aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  data-selected={feedbackByMessageId[item.id] === "thumbs_down" || undefined}
                                  onClick={() => onFeedback(item.id, "thumbs_down")}
                                  aria-label="Unhelpful response"
                                >
                                  <ThumbsDown aria-hidden="true" />
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </motion.li>
                    ))}
                  </ol>
                )}
                  </div>
                </div>
              )}
            </div>

            <div className={styles.composerDock}>
              <div className={styles.sharedComposerFrame}>
                <ChatComposer {...composer} />
              </div>
            </div>
          </section>

          <AnimatePresence initial={false}>
            {isInspectorOpen && (
              <motion.div
                className={styles.inspectorMotionShell}
                initial={reduceMotion ? false : { opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 20 }}
                transition={{ duration: 0.24, ease: "easeOut" }}
              >
                <FlowWorkspaceInspector
                  view={inspectorView}
                  isPinned={isInspectorPinned}
                  activeGoal={activeGoal}
                  currentTaskLabel={currentTaskLabel}
                  goals={goals}
                  contextSummary={contextSummary}
                  approvals={approvals}
                  toolActivity={toolActivity}
                  terminalActivity={terminalActivity}
                  credentialRequests={credentialRequests}
                  voiceOptions={voiceOptions}
                  selectedVoiceOptionId={selectedVoiceOptionId}
                  voiceStatusLabel={voiceStatusLabel}
                  onViewChange={setInspectorView}
                  onPinnedChange={setIsInspectorPinned}
                  onClose={() => setIsInspectorOpen(false)}
                  onApprovalDecision={onApprovalDecision}
                  onCredentialResolve={onCredentialResolve}
                  onVoiceOptionChange={onVoiceOptionChange}
                  onOpenVoiceSettings={() => setIsSpeechPacksOpen(true)}
                  onTerminalInput={onTerminalInput}
                  onTerminalStop={onTerminalStop}
                  onTerminalRename={onTerminalRename}
                  onFocusAction={onFocusAction}
                  onOpenInClassic={onOpenInClassic}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      <AnimatePresence>
        {isSpeechPacksOpen && (
          <motion.div
            className={styles.speechPackOverlay}
            role="presentation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <button
              type="button"
              className={styles.speechPackScrim}
              aria-label="Close offline voice packs"
              onClick={() => setIsSpeechPacksOpen(false)}
            />
            <motion.div
              ref={speechPackDialogRef}
              className={styles.speechPackDialog}
              role="dialog"
              aria-modal="true"
              aria-labelledby="v2-voice-packs-title"
              initial={reduceMotion ? false : { opacity: 0, y: 18, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.99 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              <div className={styles.speechPackDialogBar}>
                <span>Voice settings</span>
                <button
                  ref={speechPackCloseRef}
                  type="button"
                  onClick={() => setIsSpeechPacksOpen(false)}
                  aria-label="Close offline voice packs"
                >
                  <X aria-hidden="true" />
                </button>
              </div>
              <V2SpeechPackManager headingId="v2-voice-packs-title" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}
