"use client";

import {
  AudioLines,
  CircleDashed,
  CircleHelp,
  FileText,
  Layers3,
  ListTodo,
  LockKeyhole,
  Paperclip,
  Sparkles,
  X,
} from "lucide-react";
import type {
  FlowContextItemView,
  FlowContextSummary,
  FlowGoalView,
  FlowVoiceOption,
} from "./types";
import styles from "./seamless.module.css";

export type FlowInspectorView = "context" | "focuses";

interface FlowWorkspaceInspectorProps {
  view: FlowInspectorView;
  isPinned: boolean;
  activeGoal?: FlowGoalView;
  currentTaskLabel: string;
  goals: FlowGoalView[];
  contextSummary?: FlowContextSummary;
  voiceOptions: FlowVoiceOption[];
  selectedVoiceOptionId?: string;
  voiceStatusLabel?: string;
  onViewChange: (view: FlowInspectorView) => void;
  onPinnedChange: (pinned: boolean) => void;
  onClose: () => void;
  onVoiceOptionChange?: (optionId: string) => void;
  onOpenVoiceSettings: () => void;
  onFocusAction?: (goalId: string, action: "switch" | "pause" | "finish" | "reopen" | "archive" | "pin" | "unpin") => void;
  onDeleteGoal?: (goalId: string) => void;
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
  voiceOptions,
  selectedVoiceOptionId,
  voiceStatusLabel,
  onViewChange,
  onPinnedChange,
  onClose,
  onVoiceOptionChange,
  onOpenVoiceSettings,
  onFocusAction,
  onDeleteGoal,
  onOpenInClassic,
}: FlowWorkspaceInspectorProps) {
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
                  {activeGoal.kind === "work" && onDeleteGoal && <button type="button" onClick={() => onDeleteGoal(activeGoal.id)}>Delete</button>}
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
                            {goal.kind === "work" && onDeleteGoal && goal.status !== "foreground" && (
                              <button type="button" onClick={() => onDeleteGoal(goal.id)}>Delete</button>
                            )}
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
