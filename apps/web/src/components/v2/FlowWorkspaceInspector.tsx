"use client";

import {
  Activity,
  AudioLines,
  Check,
  CircleDashed,
  CircleHelp,
  FileText,
  Layers3,
  ListTodo,
  LockKeyhole,
  Paperclip,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { V2CredentialPrompt } from "./V2CredentialPrompt";
import { V2TerminalActivity } from "./V2TerminalActivity";
import type {
  FlowApprovalView,
  FlowContextItemView,
  FlowContextSummary,
  FlowCredentialRequestView,
  FlowGoalView,
  FlowTerminalActivityView,
  FlowToolActivityView,
  FlowVoiceOption,
} from "./types";
import styles from "./seamless.module.css";

export type FlowInspectorView = "context" | "focuses" | "activity";

interface FlowWorkspaceInspectorProps {
  view: FlowInspectorView;
  isPinned: boolean;
  activeGoal?: FlowGoalView;
  currentTaskLabel: string;
  goals: FlowGoalView[];
  contextSummary?: FlowContextSummary;
  approvals: FlowApprovalView[];
  toolActivity: FlowToolActivityView[];
  terminalActivity: FlowTerminalActivityView[];
  credentialRequests: FlowCredentialRequestView[];
  voiceOptions: FlowVoiceOption[];
  selectedVoiceOptionId?: string;
  voiceStatusLabel?: string;
  onViewChange: (view: FlowInspectorView) => void;
  onPinnedChange: (pinned: boolean) => void;
  onClose: () => void;
  onApprovalDecision?: (approvalId: string, decision: "approved" | "rejected") => void;
  onCredentialResolve?: (request: FlowCredentialRequestView, decision: "submitted" | "cancelled", value?: string) => void;
  onVoiceOptionChange?: (optionId: string) => void;
  onOpenVoiceSettings: () => void;
  onTerminalInput?: (terminalId: string, text: string) => void;
  onTerminalStop?: (terminalId: string) => void;
  onTerminalRename?: (terminalId: string, name: string) => void;
  onFocusAction?: (goalId: string, action: "switch" | "pause" | "finish" | "reopen" | "archive" | "pin" | "unpin") => void;
  onOpenInClassic?: (goalId: string) => void;
}

const goalStatusLabel: Record<FlowGoalView["status"], string> = {
  foreground: "Current",
  parked: "Paused",
  blocked: "Paused",
  completed: "Finished",
  discarded: "Discarded",
  archived: "Archived",
};

const contextItemIcon = (item: FlowContextItemView) => {
  if (item.disposition === "distill") return <Sparkles aria-hidden="true" />;
  if (item.disposition === "unresolved") return <CircleHelp aria-hidden="true" />;
  return <FileText aria-hidden="true" />;
};

const contextItemState = (item: FlowContextItemView): string => {
  if (item.disposition === "distill") return "Distilled";
  if (item.disposition === "unresolved") return "Unresolved";
  return "Exact";
};

export function FlowWorkspaceInspector({
  view,
  isPinned,
  activeGoal,
  currentTaskLabel,
  goals,
  contextSummary,
  approvals,
  toolActivity,
  terminalActivity,
  credentialRequests,
  voiceOptions,
  selectedVoiceOptionId,
  voiceStatusLabel,
  onViewChange,
  onPinnedChange,
  onClose,
  onApprovalDecision,
  onCredentialResolve,
  onVoiceOptionChange,
  onOpenVoiceSettings,
  onTerminalInput,
  onTerminalStop,
  onTerminalRename,
  onFocusAction,
  onOpenInClassic,
}: FlowWorkspaceInspectorProps) {
  const pendingApprovals = approvals.filter((approval) => !approval.status || approval.status === "pending");
  const activityCount = toolActivity.length + approvals.length + terminalActivity.length;
  const contextItems = contextSummary?.items ?? [];

  return (
    <aside
      id="v2-goal-inspector"
      className={styles.goalInspector}
      data-pinned={isPinned || undefined}
      aria-label="Socrates working notes"
    >
      <header className={styles.inspectorHeader}>
        <div>
          <p>Working notes</p>
          <h2>{activeGoal?.title ?? "No active focus"}</h2>
          <span>{currentTaskLabel}</span>
        </div>
        <div className={styles.inspectorHeaderActions}>
          <button
            type="button"
            data-active={isPinned || undefined}
            aria-pressed={isPinned}
            aria-label={isPinned ? "Let the working notes close when the workspace is selected" : "Keep working notes open"}
            title={isPinned ? "Unpin working notes" : "Pin working notes"}
            onClick={() => onPinnedChange(!isPinned)}
          >
            <Paperclip aria-hidden="true" />
          </button>
          <button type="button" onClick={onClose} aria-label="Close working notes">
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      <nav className={styles.inspectorTabs} aria-label="Working note views">
        <button type="button" data-active={view === "context" || undefined} onClick={() => onViewChange("context")}>
          <Layers3 aria-hidden="true" /> Context
        </button>
        <button type="button" data-active={view === "focuses" || undefined} onClick={() => onViewChange("focuses")}>
          <ListTodo aria-hidden="true" /> Focuses
        </button>
        <button type="button" data-active={view === "activity" || undefined} onClick={() => onViewChange("activity")}>
          <Activity aria-hidden="true" /> Activity
          {activityCount > 0 && <span>{activityCount}</span>}
        </button>
      </nav>

      <div className={styles.inspectorContent}>
        {view === "context" && (
          <div className={styles.inspectorPane}>
            <section className={styles.contextOverview} aria-labelledby="working-context-title">
              <div>
                <p id="working-context-title">Active for this focus</p>
                <strong>{contextItems.length}</strong>
              </div>
              <div>
                <p>Preserved in this Flow</p>
                <strong>{contextSummary?.preservedEvidenceCount ?? 0}</strong>
              </div>
            </section>

            {contextSummary?.unavailableReason ? (
              <p className={styles.inspectorEmpty}>{contextSummary.unavailableReason}</p>
            ) : contextItems.length === 0 ? (
              <div className={styles.contextEmptyState}>
                <Layers3 aria-hidden="true" />
                <div>
                  <strong>No retrieved evidence is active yet.</strong>
                  <p>When Socrates reads files, tools, or retrieved traces, the foreground focus’s working evidence will appear here.</p>
                </div>
              </div>
            ) : (
              <section className={styles.contextItemSection} aria-labelledby="context-item-heading">
                <div className={styles.inspectorSectionHeading}>
                  <h3 id="context-item-heading">In the working set</h3>
                  <span>{contextSummary?.contextUsageLabel}</span>
                </div>
                <ul className={styles.contextItemList}>
                  {contextItems.map((item) => (
                    <li key={item.id} data-disposition={item.disposition}>
                      <span className={styles.contextItemIcon}>{contextItemIcon(item)}</span>
                      <span className={styles.contextItemCopy}>
                        <strong>{item.label}</strong>
                        <small>{item.sourceType}{item.tokenEstimate !== undefined ? ` · about ${item.tokenEstimate.toLocaleString()} tokens` : ""}</small>
                        {item.distilledText && <p>{item.distilledText}</p>}
                      </span>
                      <span className={styles.contextItemState}>{contextItemState(item)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className={styles.preservedContextStrip}>
              <CircleDashed aria-hidden="true" />
              <div>
                <strong>{contextSummary?.releasedItemCount ?? 0} set aside from active context</strong>
                <p>Exact evidence remains stored and can be retrieved again. It is never deleted by pruning.</p>
              </div>
            </section>
          </div>
        )}

        {view === "focuses" && (
          <div className={styles.inspectorPane}>
            {activeGoal && (
              <section className={styles.currentFocusSheet}>
                <span>Current focus</span>
                <h3>{activeGoal.title}</h3>
                {activeGoal.summary && <p>{activeGoal.summary}</p>}
                <small>Current task · {currentTaskLabel}</small>
                <div className={styles.currentFocusActions}>
                  {activeGoal.kind === "work" && onFocusAction && (
                    <>
                      <button type="button" onClick={() => onFocusAction(activeGoal.id, "pause")}>Pause</button>
                      <button type="button" onClick={() => onFocusAction(activeGoal.id, "finish")}>Finish</button>
                    </>
                  )}
                  {onOpenInClassic && <button type="button" onClick={() => onOpenInClassic(activeGoal.id)}>Open in Classic</button>}
                </div>
              </section>
            )}

            <section aria-labelledby="goal-list-heading">
              <div className={styles.inspectorSectionHeading}>
                <h3 id="goal-list-heading">Focus ledger</h3>
                <span>{goals.length}</span>
              </div>
              <div className={styles.focusLedger}>
                {([
                  ["Current", goals.filter((goal) => goal.status === "foreground")],
                  ["Paused", goals.filter((goal) => goal.status === "parked" || goal.status === "blocked")],
                  ["Finished", goals.filter((goal) => goal.status === "completed")],
                  ["Discarded", goals.filter((goal) => goal.status === "discarded")],
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
                            <small>{goal.kind === "general" ? "Always available" : goalStatusLabel[goal.status]}{goal.pinned && goal.kind === "work" ? " · kept close" : ""}</small>
                          </span>
                          <span className={styles.goalListActions}>
                            {onFocusAction && goal.status !== "foreground" && goal.status !== "archived" && (
                              <button type="button" onClick={() => onFocusAction(goal.id, goal.status === "completed" || goal.status === "discarded" ? "reopen" : "switch")}>{goal.status === "completed" || goal.status === "discarded" ? "Reopen" : "Switch"}</button>
                            )}
                            {onFocusAction && goal.status === "archived" && <button type="button" onClick={() => onFocusAction(goal.id, "reopen")}>Reopen</button>}
                            {onFocusAction && goal.kind === "work" && goal.status !== "foreground" && goal.status !== "archived" && (
                              <button type="button" onClick={() => onFocusAction(goal.id, "archive")}>Archive</button>
                            )}
                            {goal.kind === "general" ? (
                              <span className={styles.protectedFocus} title="General Conversation is always available"><LockKeyhole aria-hidden="true" /></span>
                            ) : onFocusAction ? (
                              <button
                                type="button"
                                className={styles.goalPinAction}
                                data-active={goal.pinned || undefined}
                                aria-pressed={goal.pinned}
                                aria-label={goal.pinned ? `Allow ${goal.title} to archive normally` : `Keep ${goal.title} close`}
                                title={goal.pinned ? "Unclip focus" : "Keep focus close"}
                                onClick={() => onFocusAction(goal.id, goal.pinned ? "unpin" : "pin")}
                              >
                                <Paperclip aria-hidden="true" />
                              </button>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </section>
          </div>
        )}

        {view === "activity" && (
          <div className={styles.inspectorPane}>
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
                        <span><strong>{approval.actionKind}</strong>{approval.actionSummary && <small>{approval.actionSummary}</small>}</span>
                      </div>
                      <div>
                        <button type="button" onClick={() => onApprovalDecision?.(approval.id, "rejected")}>Reject</button>
                        <button type="button" onClick={() => onApprovalDecision?.(approval.id, "approved")}><Check aria-hidden="true" /> Approve</button>
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
                  {credentialRequests.map((request) => <V2CredentialPrompt key={request.id} request={request} onResolve={onCredentialResolve} />)}
                </div>
              </section>
            )}

            {activityCount === 0 && credentialRequests.length === 0 ? (
              <div className={styles.contextEmptyState}>
                <Activity aria-hidden="true" />
                <div><strong>The workspace is quiet.</strong><p>Tool, approval, and Terminal activity will appear here when Socrates begins working.</p></div>
              </div>
            ) : (
              <div className={styles.activityBody}>
                {toolActivity.length > 0 && (
                  <div className={styles.activityGroup}>
                    <p>Tools</p>
                    {toolActivity.map((tool) => (
                      <div className={styles.activityRow} key={tool.id}>
                        <Wrench aria-hidden="true" />
                        <span><strong>{tool.name}</strong>{tool.summary && <small>{tool.summary}</small>}{tool.resultSummary && <small className={styles.toolResult}>Result · {tool.resultSummary}</small>}</span>
                        <em>{tool.status.replaceAll("_", " ")}</em>
                      </div>
                    ))}
                  </div>
                )}
                {terminalActivity.length > 0 && (
                  <div className={styles.activityGroup}>
                    <p>Terminals</p>
                    {terminalActivity.map((terminal) => (
                      <V2TerminalActivity key={`${terminal.id}:${terminal.name}`} terminal={terminal} onInput={onTerminalInput} onStop={onTerminalStop} onRename={onTerminalRename} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <footer className={styles.inspectorFooter}>
        {voiceOptions.length > 0 && (
          <div className={styles.voiceFooterControl}>
            <AudioLines aria-hidden="true" />
            <label htmlFor="v2-transcriber">Voice</label>
            <select id="v2-transcriber" value={selectedVoiceOptionId} disabled={!onVoiceOptionChange} onChange={(event) => onVoiceOptionChange?.(event.target.value)}>
              {voiceOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            <button type="button" onClick={onOpenVoiceSettings}>Manage</button>
          </div>
        )}
        {voiceStatusLabel && <span className={styles.voiceStatus}>{voiceStatusLabel}</span>}
      </footer>
    </aside>
  );
}
