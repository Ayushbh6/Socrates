"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  Folder,
  Menu,
  PanelRightClose,
  PanelRightOpen,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Volume2,
  Wrench,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { LivingSphere } from "./LivingSphere";
import { V2FlowComposer, type V2FlowComposerProps } from "./V2FlowComposer";
import { V2CredentialPrompt } from "./V2CredentialPrompt";
import { V2ViewLink } from "./V2ViewLink";
import { V2TerminalActivity } from "./V2TerminalActivity";
import { V2SpeechPackManager } from "./V2SpeechPackManager";
import styles from "./seamless.module.css";
import type {
  FlowContextSummary,
  FlowApprovalView,
  FlowCredentialRequestView,
  FlowGoalView,
  FlowPresenceState,
  FlowProjectNavItem,
  FlowTimelineItemView,
  FlowTerminalActivityView,
  FlowToolActivityView,
  FlowVoiceOption,
} from "./types";

export interface FlowWorkspaceProps {
  projectId: string;
  projectName: string;
  workspaceLabel?: string;
  projects: FlowProjectNavItem[];
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
  composer: V2FlowComposerProps;
  onReadAloud?: (itemId: string) => void;
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

const goalStatusLabel: Record<FlowGoalView["status"], string> = {
  foreground: "Current",
  parked: "Paused",
  blocked: "Paused",
  completed: "Finished",
  archived: "Archived",
};

export function FlowWorkspace({
  projectId,
  projectName,
  workspaceLabel,
  projects,
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
  const [isRailCollapsed, setIsRailCollapsed] = useState(false);
  const [isMobileRailOpen, setIsMobileRailOpen] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const [isSpeechPacksOpen, setIsSpeechPacksOpen] = useState(false);
  const speechPackDialogRef = useRef<HTMLDivElement>(null);
  const speechPackCloseRef = useRef<HTMLButtonElement>(null);
  const reduceMotion = useReducedMotion();
  const activeGoal = useMemo(
    () => goals.find((goal) => goal.id === activeGoalId) ?? goals.find((goal) => goal.status === "foreground"),
    [activeGoalId, goals],
  );
  const pendingApprovals = useMemo(
    () => approvals.filter((approval) => !approval.status || approval.status === "pending"),
    [approvals],
  );
  const [isActivityOpen, setIsActivityOpen] = useState(
    pendingApprovals.length > 0 || terminalActivity.some((terminal) => terminal.awaitingInput),
  );
  const activityCount = toolActivity.length + approvals.length + terminalActivity.length;

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

  const rail = (
    <aside className={styles.projectRail} data-collapsed={isRailCollapsed || undefined} aria-label="Seamless projects">
      <div className={styles.railHeader}>
        <Link className={styles.railBrand} href="/seamless" aria-label="Socrates Seamless projects">
          <span className={styles.railMark} aria-hidden="true" />
          {!isRailCollapsed && <span>Socrates</span>}
        </Link>
        <button
          className={styles.railCollapse}
          type="button"
          onClick={() => setIsRailCollapsed((current) => !current)}
          aria-label={isRailCollapsed ? "Expand project rail" : "Collapse project rail"}
        >
          {isRailCollapsed ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
        </button>
        <button
          className={styles.mobileRailClose}
          type="button"
          onClick={() => setIsMobileRailOpen(false)}
          aria-label="Close project navigation"
        >
          <X aria-hidden="true" />
        </button>
      </div>

      {!isRailCollapsed && <p className={styles.railLabel}>Projects</p>}
      <nav className={styles.railProjects} aria-label="Project flows">
        {projects.map(({ project, workspaceLabel: projectWorkspace }) => {
          const isCurrent = project.id === projectId;
          return (
            <Link
              key={project.id}
              className={styles.railProject}
              data-current={isCurrent || undefined}
              href={`/seamless/projects/${encodeURIComponent(project.id)}`}
              aria-current={isCurrent ? "page" : undefined}
              title={isRailCollapsed ? project.name : undefined}
              onClick={() => setIsMobileRailOpen(false)}
            >
              <span className={styles.railProjectGlyph} aria-hidden="true">
                {project.name.slice(0, 1).toUpperCase()}
              </span>
              {!isRailCollapsed && (
                <span className={styles.railProjectCopy}>
                  <span>{project.name}</span>
                  <span>{projectWorkspace ?? "No workspace folder"}</span>
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className={styles.railFooter}>
        <Link href="/projects/new" className={styles.railNewProject} title={isRailCollapsed ? "Create project in Classic View" : undefined}>
          <Folder aria-hidden="true" />
          {!isRailCollapsed && <span>Create project in Classic</span>}
        </Link>
      </div>
    </aside>
  );

  return (
    <main className={styles.flowPage}>
      <div className={styles.oceanNoise} aria-hidden="true" />

      <div className={styles.desktopRail}>{rail}</div>
      <AnimatePresence>
        {isMobileRailOpen && (
          <>
            <motion.button
              type="button"
              className={styles.mobileScrim}
              aria-label="Close project navigation"
              onClick={() => setIsMobileRailOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
            <motion.div
              className={styles.mobileRail}
              initial={reduceMotion ? false : { x: -28, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { x: -28, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              {rail}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <section className={styles.flowShell} data-inspector={isInspectorOpen ? "open" : "closed"}>
        <header className={styles.flowTopbar}>
          <div className={styles.flowProjectHeading}>
            <button
              type="button"
              className={styles.mobileMenuButton}
              onClick={() => setIsMobileRailOpen(true)}
              aria-label="Open project navigation"
            >
              <Menu aria-hidden="true" />
            </button>
            <div>
              <h1>{projectName}</h1>
              <p>{workspaceLabel ?? "No workspace folder connected"}</p>
            </div>
          </div>

          <div className={styles.flowTopbarActions}>
            <button
              type="button"
              className={styles.inspectorToggle}
              onClick={() => setIsInspectorOpen((current) => !current)}
              aria-controls="v2-goal-inspector"
              aria-expanded={isInspectorOpen}
            >
              {isInspectorOpen ? <PanelRightClose aria-hidden="true" /> : <PanelRightOpen aria-hidden="true" />}
              <span>{isInspectorOpen ? "Hide context" : "View context"}</span>
            </button>
            <V2ViewLink view="classic" href={`/projects/${encodeURIComponent(projectId)}`} className={styles.classicSwitch}>
              <span>Classic View</span>
              <ArrowUpRight aria-hidden="true" />
            </V2ViewLink>
          </div>
        </header>

        <div className={styles.flowBody}>
          <section className={styles.flowCanvas} aria-label="Seamless conversation">
            <div className={styles.goalRibbon}>
              <span className={styles.goalRibbonLabel}>Current focus</span>
              <span className={styles.goalRibbonTitle}>{activeGoal?.title ?? "No current focus"}</span>
              {activeGoal && <span className={styles.goalRibbonState}>{goalStatusLabel[activeGoal.status]}</span>}
              <span className={styles.goalRibbonTaskLabel}>Current task</span>
              <span className={styles.goalRibbonTask}>{currentTaskLabel}</span>
            </div>

            <div className={styles.timelineScroller}>
              <div className={clsx(styles.timeline, timeline.length > 0 && styles.timelineHasItems)}>
                <div className={styles.presenceStage}>
                  <LivingSphere
                    state={presenceState}
                    size={timeline.length > 0 ? "compact" : "full"}
                    statusLabel={statusLabel}
                  />
                  {timeline.length === 0 && (
                    <div className={styles.emptyFlowCopy}>
                      <h2>Your project flow will live here.</h2>
                      <p>Messages remain visually continuous while goals and context are managed behind the scenes.</p>
                    </div>
                  )}
                </div>

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
                            >
                              <Volume2 aria-hidden="true" />
                              Read aloud
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

            <div className={styles.composerDock}>
              <V2FlowComposer {...composer} />
            </div>
          </section>

          <AnimatePresence initial={false}>
            {isInspectorOpen && (
              <motion.aside
                id="v2-goal-inspector"
                className={styles.goalInspector}
                aria-label="Goals and working context"
                initial={reduceMotion ? false : { opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 20 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                <div className={styles.inspectorHeader}>
                  <div>
                    <p>Current focus</p>
                    <h2>{activeGoal?.title ?? "No active goal"}</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsInspectorOpen(false)}
                    aria-label="Close context inspector"
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>

                {activeGoal?.summary && <p className={styles.activeGoalSummary}>{activeGoal.summary}</p>}
                {activeGoal && (onFocusAction || onOpenInClassic) && (
                  <div className={styles.currentFocusActions}>
                    {activeGoal.kind === "work" && onFocusAction && (
                      <>
                        <button type="button" onClick={() => onFocusAction(activeGoal.id, "pause")}>Pause</button>
                        <button type="button" onClick={() => onFocusAction(activeGoal.id, "finish")}>Finish</button>
                      </>
                    )}
                    {onOpenInClassic && <button type="button" onClick={() => onOpenInClassic(activeGoal.id)}>Open in Classic</button>}
                  </div>
                )}

                {pendingApprovals.length > 0 && (
                  <section className={styles.inspectorSection} aria-labelledby="approval-heading">
                    <div className={styles.inspectorSectionHeading}>
                      <h3 id="approval-heading">Needs approval</h3>
                      <span>{pendingApprovals.length}</span>
                    </div>
                    <div className={styles.approvalList}>
                      {pendingApprovals.map((approval) => (
                        <div key={approval.id} className={styles.approvalPrompt}>
                          <div>
                            <ShieldCheck aria-hidden="true" />
                            <span>
                              <strong>{approval.actionKind}</strong>
                              {approval.actionSummary && <small>{approval.actionSummary}</small>}
                            </span>
                          </div>
                          <div>
                            <button type="button" onClick={() => onApprovalDecision?.(approval.id, "rejected")}>Reject</button>
                            <button type="button" onClick={() => onApprovalDecision?.(approval.id, "approved")}>
                              <Check aria-hidden="true" /> Approve
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                {credentialRequests.length > 0 && onCredentialResolve && (
                  <section className={styles.inspectorSection} aria-labelledby="credential-heading">
                    <div className={styles.inspectorSectionHeading}>
                      <h3 id="credential-heading">Secure input</h3>
                      <span>{credentialRequests.length}</span>
                    </div>
                    <div className={styles.credentialList}>
                      {credentialRequests.map((request) => (
                        <V2CredentialPrompt key={request.id} request={request} onResolve={onCredentialResolve} />
                      ))}
                    </div>
                  </section>
                )}

                <details
                  className={styles.activityDisclosure}
                  open={isActivityOpen}
                  onToggle={(event) => setIsActivityOpen(event.currentTarget.open)}
                >
                  <summary>
                    <span>Runtime activity</span>
                    <span>{activityCount}</span>
                  </summary>
                  <div className={styles.activityBody}>
                    {activityCount === 0 && (
                      <p className={styles.inspectorEmpty}>Tool, approval, and Terminal activity will appear here.</p>
                    )}

                    {toolActivity.length > 0 && (
                      <div className={styles.activityGroup}>
                        <p>Tools</p>
                        {toolActivity.map((tool) => (
                          <div className={styles.activityRow} key={tool.id}>
                            <Wrench aria-hidden="true" />
                            <span>
                              <strong>{tool.name}</strong>
                              {tool.summary && <small>{tool.summary}</small>}
                              {tool.resultSummary && (
                                <small className={styles.toolResult}>Result · {tool.resultSummary}</small>
                              )}
                            </span>
                            <em>{tool.status.replaceAll("_", " ")}</em>
                          </div>
                        ))}
                      </div>
                    )}

                    {approvals.length > 0 && (
                      <div className={styles.activityGroup}>
                        <p>Approvals</p>
                        {approvals.map((approval) => (
                          <div className={styles.activityRow} key={approval.id}>
                            <ShieldCheck aria-hidden="true" />
                            <span>
                              <strong>{approval.actionKind}</strong>
                              {approval.actionSummary && <small>{approval.actionSummary}</small>}
                            </span>
                            <em>{approval.status ?? "pending"}</em>
                          </div>
                        ))}
                      </div>
                    )}

                    {terminalActivity.length > 0 && (
                      <div className={styles.activityGroup}>
                        <p>Terminals</p>
                        {terminalActivity.map((terminal) => (
                          <V2TerminalActivity
                            key={`${terminal.id}:${terminal.name}`}
                            terminal={terminal}
                            onInput={onTerminalInput}
                            onStop={onTerminalStop}
                            onRename={onTerminalRename}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </details>

                <section className={styles.inspectorSection} aria-labelledby="goal-list-heading">
                  <div className={styles.inspectorSectionHeading}>
                    <h3 id="goal-list-heading">Goals</h3>
                    <span>{goals.length}</span>
                  </div>
                  {goals.length === 0 ? (
                    <p className={styles.inspectorEmpty}>No goals have been loaded for this flow.</p>
                  ) : (
                    <div className={styles.focusLedger}>
                      {([
                        ["Current", goals.filter((goal) => goal.status === "foreground")],
                        ["Paused", goals.filter((goal) => goal.status === "parked" || goal.status === "blocked")],
                        ["Finished", goals.filter((goal) => goal.status === "completed")],
                        ["Archived", goals.filter((goal) => goal.status === "archived")],
                      ] as const).map(([label, groupedGoals]) => groupedGoals.length > 0 && (
                        <section key={label} className={styles.focusGroup} aria-label={`${label} focuses`}>
                          <p>{label}<span>{groupedGoals.length}</span></p>
                          <ul className={styles.goalList}>
                            {groupedGoals.map((goal) => (
                              <li key={goal.id} data-status={goal.status}>
                                <span className={styles.goalStatusDot} aria-hidden="true" />
                                <span className={styles.goalListCopy}>
                                  <strong>{goal.title}</strong>
                                  <small>{goal.kind === "general" ? "Always open" : goalStatusLabel[goal.status]}{goal.pinned ? " · pinned" : ""}</small>
                                </span>
                                {onFocusAction && (
                                  <span className={styles.goalListActions}>
                                    {goal.status !== "foreground" && goal.status !== "archived" && (
                                      <button type="button" onClick={() => onFocusAction(goal.id, goal.status === "completed" ? "reopen" : "switch")}>{goal.status === "completed" ? "Reopen" : "Switch"}</button>
                                    )}
                                    {goal.status === "archived" && <button type="button" onClick={() => onFocusAction(goal.id, "reopen")}>Reopen</button>}
                                    {goal.kind === "work" && goal.status !== "foreground" && goal.status !== "archived" && (
                                      <button type="button" onClick={() => onFocusAction(goal.id, "archive")}>Archive</button>
                                    )}
                                    <button type="button" onClick={() => onFocusAction(goal.id, goal.pinned ? "unpin" : "pin")}>{goal.pinned ? "Unpin" : "Pin"}</button>
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </section>
                      ))}
                    </div>
                  )}
                </section>

                <section className={styles.inspectorSection} aria-labelledby="context-heading">
                  <div className={styles.inspectorSectionHeading}>
                    <h3 id="context-heading">Working context</h3>
                  </div>
                  {!contextSummary ? (
                    <p className={styles.inspectorEmpty}>No context snapshot has been loaded.</p>
                  ) : contextSummary.unavailableReason ? (
                    <p className={styles.inspectorEmpty}>{contextSummary.unavailableReason}</p>
                  ) : (
                    <dl className={styles.contextFacts}>
                      {contextSummary.contextUsageLabel && (
                        <div>
                          <dt>Active window</dt>
                          <dd>{contextSummary.contextUsageLabel}</dd>
                        </div>
                      )}
                      {contextSummary.exactEvidenceCount !== undefined && (
                        <div>
                          <dt>Exact</dt>
                          <dd>{contextSummary.exactEvidenceCount}</dd>
                        </div>
                      )}
                      {contextSummary.distilledEvidenceCount !== undefined && (
                        <div>
                          <dt>Distilled</dt>
                          <dd>{contextSummary.distilledEvidenceCount}</dd>
                        </div>
                      )}
                      {contextSummary.unresolvedEvidenceCount !== undefined && (
                        <div>
                          <dt>Unresolved</dt>
                          <dd>{contextSummary.unresolvedEvidenceCount}</dd>
                        </div>
                      )}
                    </dl>
                  )}
                </section>

                {voiceOptions.length > 0 && (
                  <section className={styles.inspectorSection} aria-labelledby="voice-heading">
                    <div className={styles.inspectorSectionHeading}>
                      <h3 id="voice-heading">Voice input</h3>
                    </div>
                    <label className={styles.voiceOptionLabel} htmlFor="v2-transcriber">Transcriber</label>
                    <select
                      id="v2-transcriber"
                      className={styles.voiceOptionSelect}
                      value={selectedVoiceOptionId}
                      disabled={!onVoiceOptionChange}
                      onChange={(event) => onVoiceOptionChange?.(event.target.value)}
                    >
                      {voiceOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                    </select>
                    <p className={styles.voiceStatus}>{voiceStatusLabel ?? "Speech never switches from local to hosted without your selection."}</p>
                    <button
                      type="button"
                      className={styles.voicePacksControl}
                      onClick={() => setIsSpeechPacksOpen(true)}
                    >
                      Manage offline voice packs
                    </button>
                  </section>
                )}

                <footer className={styles.inspectorFooter}>
                  <CircleDashed aria-hidden="true" />
                  <span>Evidence remains preserved outside the active model context.</span>
                </footer>
              </motion.aside>
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
