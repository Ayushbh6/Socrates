"use client";

import { Activity, Check, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Notification as SocratesNotification } from "@socrates/contracts";

type SkillProposalStatus = "pending" | "approved" | "rejected" | "deleted" | "missing";

interface ActivityCenterProps {
  notifications: SocratesNotification[];
  unreadCount: number;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onRead: (notificationId: string) => void;
  onReadAll: () => void;
  onApproveSkillProposal: (notification: SocratesNotification) => void;
  onRejectSkillProposal: (notification: SocratesNotification) => void;
  approvingSkillActionId: string | null;
  rejectingSkillActionId: string | null;
}

const skillProposalStatusLabel = (status: SkillProposalStatus): string => {
  switch (status) {
    case "pending":
      return "Pending";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "deleted":
      return "Skill deleted";
    case "missing":
      return "Unavailable";
  }
};

const skillProposalStatusClass = (status: SkillProposalStatus): string => {
  switch (status) {
    case "pending":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "approved":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "rejected":
      return "border-gray-200 bg-gray-50 text-brand-text-light";
    case "deleted":
    case "missing":
      return "border-rose-200 bg-rose-50 text-rose-700";
  }
};

const skillProposalStatusFromPayload = (payload: Record<string, unknown>): SkillProposalStatus => {
  const status = payload.proposalStatus;
  return status === "approved" || status === "rejected" || status === "deleted" || status === "missing" ? status : "pending";
};

const payloadRecord = (notification: SocratesNotification): Record<string, unknown> =>
  notification.payload && typeof notification.payload === "object" ? (notification.payload as Record<string, unknown>) : {};

const payloadString = (payload: Record<string, unknown>, key: string): string | undefined => {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

const payloadNumber = (payload: Record<string, unknown>, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
};

const humanizeIdentifier = (value: string): string =>
  value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

const formatActivityTime = (createdAt: string): string =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(createdAt));

const activityTitle = (notification: SocratesNotification, payload: Record<string, unknown>, status?: SkillProposalStatus): string => {
  if (notification.type === "memory.skill.proposed") {
    if (status === "pending") {
      return "Skill proposal";
    }
    return `Skill proposal ${status ? skillProposalStatusLabel(status).toLowerCase() : "updated"}`;
  }
  if (notification.type === "memory.soul.updated") {
    const document = payloadString(payload, "document");
    return `${document ? humanizeIdentifier(document) : "Identity"} updated`;
  }
  if (notification.type === "memory.user_profile.updated") {
    return "User Profile updated";
  }
  if (notification.type.startsWith("memory.note.")) {
    return "Memory note processed";
  }
  if (notification.type.startsWith("memory.agent.")) {
    return "Memory run completed";
  }
  return notification.title;
};

const activitySubtitle = (notification: SocratesNotification, payload: Record<string, unknown>): string | undefined => {
  if (notification.type === "memory.skill.proposed") {
    const skillTitle = payloadString(payload, "skillTitle") ?? payloadString(payload, "skillName");
    const scope = payloadString(payload, "scope");
    const operation = payloadString(payload, "operation");
    const projectName = payloadString(payload, "projectName");
    const parts = [skillTitle ? humanizeIdentifier(skillTitle) : undefined, scope ? `${scope} skill` : undefined, operation, projectName].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : notification.body;
  }
  const document = payloadString(payload, "document");
  if (document && notification.body) {
    return notification.body;
  }
  return notification.body;
};

const noteOutcomeStats = (payload: Record<string, unknown>): Array<{ label: string; value: number }> => {
  const stats = [
    { label: "Sent", value: payloadNumber(payload, "memoryNotesSent", "notesSent", "sent") },
    { label: "Already recorded", value: payloadNumber(payload, "memoryNotesAlreadyRecorded", "notesAlreadyRecorded", "alreadyRecorded") },
    { label: "Processed", value: payloadNumber(payload, "memoryNotesProcessed", "notesProcessed", "processed") },
    { label: "Applied", value: payloadNumber(payload, "applied", "memoryNotesApplied") },
    { label: "Already represented", value: payloadNumber(payload, "alreadyRepresented", "already_represented", "memoryNotesAlreadyRepresented") },
    { label: "Skipped", value: payloadNumber(payload, "skipped", "memoryNotesSkipped") },
    { label: "Skill proposals", value: payloadNumber(payload, "proposedSkill", "proposed_skill", "skillProposals") },
  ];
  return stats.filter((item): item is { label: string; value: number } => item.value !== undefined);
};

const isPendingSkillProposalNotification = (notification: SocratesNotification): boolean => {
  const payload = payloadRecord(notification);
  const actionId = payloadString(payload, "actionId");
  return notification.type === "memory.skill.proposed" && Boolean(actionId) && skillProposalStatusFromPayload(payload) === "pending";
};

export function ActivityCenter({
  notifications,
  unreadCount,
  isOpen,
  onToggle,
  onClose,
  onRead,
  onReadAll,
  onApproveSkillProposal,
  onRejectSkillProposal,
  approvingSkillActionId,
  rejectingSkillActionId,
}: ActivityCenterProps) {
  const pendingSkillProposals = notifications.filter(isPendingSkillProposalNotification);
  const recentActivity = notifications.filter((notification) => !isPendingSkillProposalNotification(notification));
  const actionNeededCount = pendingSkillProposals.length;
  const hasUnreadRoutineActivity = recentActivity.some((notification) => !notification.readAt);

  return (
    <div className="relative ml-auto shrink-0">
      <button
        type="button"
        className="relative inline-flex h-9 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-brand-text-light shadow-sm hover:bg-gray-50 hover:text-brand-text-dark"
        title="Memory Activity"
        aria-label={actionNeededCount > 0 ? `Memory Activity, ${actionNeededCount} item${actionNeededCount === 1 ? "" : "s"} need review` : "Memory Activity"}
        onClick={onToggle}
      >
        <Activity className="size-4" />
        <span className="hidden sm:inline">Activity</span>
        {actionNeededCount > 0 ? (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-amber-500 px-1.5 py-0.5 text-center text-[10px] font-semibold text-white shadow-sm">
            {actionNeededCount}
          </span>
        ) : null}
      </button>
      {isOpen ? (
        <div className="absolute right-0 top-11 z-30 w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl shadow-slate-200/70">
          <div className="flex items-start justify-between border-b border-gray-100 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-brand-text-dark">Memory Activity</p>
              <p className="mt-0.5 text-xs text-brand-text-light">
                {actionNeededCount > 0
                  ? `${actionNeededCount} need${actionNeededCount === 1 ? "s" : ""} review`
                  : hasUnreadRoutineActivity
                    ? `${unreadCount} unread activity ${unreadCount === 1 ? "item" : "items"}`
                    : "Quiet log of memory changes"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {unreadCount > 0 ? (
                <button type="button" className="rounded-md px-2 py-1 text-xs font-medium text-brand-teal-dark hover:bg-teal-50" onClick={onReadAll}>
                  Mark all read
                </button>
              ) : null}
              <button type="button" className="rounded-md p-1 text-brand-text-light hover:bg-gray-50" title="Close" onClick={onClose}>
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="max-h-[30rem] space-y-4 overflow-auto bg-slate-50/60 px-4 py-4">
            {notifications.length === 0 ? (
              <div className="rounded-md border border-dashed border-gray-200 bg-white px-4 py-8 text-center text-sm text-brand-text-light">No activity yet.</div>
            ) : (
              <>
                {pendingSkillProposals.length > 0 ? (
                  <ActivitySection title="Needs Review">
                    {pendingSkillProposals.map((notification) => (
                      <ActivityItem
                        key={notification.id}
                        notification={notification}
                        actionMode="review"
                        approvingSkillActionId={approvingSkillActionId}
                        rejectingSkillActionId={rejectingSkillActionId}
                        onRead={onRead}
                        onApproveSkillProposal={onApproveSkillProposal}
                        onRejectSkillProposal={onRejectSkillProposal}
                      />
                    ))}
                  </ActivitySection>
                ) : null}
                <ActivitySection title="Recent Activity">
                  {recentActivity.length === 0 ? (
                    <div className="rounded-md border border-gray-200 bg-white px-3 py-4 text-sm text-brand-text-light">
                      Skill proposals that need your review will appear here first.
                    </div>
                  ) : (
                    recentActivity.map((notification) => (
                      <ActivityItem
                        key={notification.id}
                        notification={notification}
                        actionMode="log"
                        approvingSkillActionId={approvingSkillActionId}
                        rejectingSkillActionId={rejectingSkillActionId}
                        onRead={onRead}
                        onApproveSkillProposal={onApproveSkillProposal}
                        onRejectSkillProposal={onRejectSkillProposal}
                      />
                    ))
                  )}
                </ActivitySection>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ActivitySection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold text-brand-text-dark">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function ActivityItem({
  notification,
  actionMode,
  approvingSkillActionId,
  rejectingSkillActionId,
  onRead,
  onApproveSkillProposal,
  onRejectSkillProposal,
}: {
  notification: SocratesNotification;
  actionMode: "review" | "log";
  approvingSkillActionId: string | null;
  rejectingSkillActionId: string | null;
  onRead: (notificationId: string) => void;
  onApproveSkillProposal: (notification: SocratesNotification) => void;
  onRejectSkillProposal: (notification: SocratesNotification) => void;
}) {
  const payload = payloadRecord(notification);
  const actionId = payloadString(payload, "actionId");
  const diff = payloadString(payload, "diff");
  const rationale = payloadString(payload, "rationale");
  const request = payloadString(payload, "request");
  const isSkillProposal = notification.type === "memory.skill.proposed" && Boolean(actionId);
  const proposalStatus = isSkillProposal ? skillProposalStatusFromPayload(payload) : undefined;
  const isPendingSkillProposal = proposalStatus === "pending";
  const isApproving = Boolean(actionId && approvingSkillActionId === actionId);
  const isRejecting = Boolean(actionId && rejectingSkillActionId === actionId);
  const stats = noteOutcomeStats(payload);
  const hasDetails = Boolean(diff || request);
  const title = activityTitle(notification, payload, proposalStatus);
  const subtitle = activitySubtitle(notification, payload);

  return (
    <article
      className={`rounded-md border bg-white p-3 shadow-sm ${
        actionMode === "review" ? "border-amber-200 shadow-amber-100/60" : notification.readAt ? "border-gray-200" : "border-teal-100"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-brand-text-dark">{title}</p>
            {isSkillProposal && proposalStatus ? (
              <span className={`inline-flex h-6 items-center rounded-md border px-2 text-[11px] font-medium ${skillProposalStatusClass(proposalStatus)}`}>
                {skillProposalStatusLabel(proposalStatus)}
              </span>
            ) : null}
          </div>
          {subtitle ? <p className="mt-1 text-xs leading-5 text-brand-text-light">{subtitle}</p> : null}
        </div>
        {!notification.readAt && actionMode !== "review" ? <span className="mt-1 size-2 shrink-0 rounded-full bg-brand-teal" /> : null}
      </div>

      {rationale ? <p className="mt-2 text-xs leading-5 text-brand-text-dark">{rationale}</p> : null}

      {stats.length > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-md border border-gray-100 bg-gray-50 px-2 py-1.5">
              <p className="text-[11px] text-brand-text-light">{stat.label}</p>
              <p className="font-mono text-sm font-semibold text-brand-text-dark">{stat.value}</p>
            </div>
          ))}
        </div>
      ) : null}

      {hasDetails ? (
        <details className="mt-3 rounded-md border border-gray-100 bg-gray-50 px-2 py-1.5 text-xs text-brand-text-light">
          <summary className="cursor-pointer font-medium text-brand-text-dark">View details</summary>
          {request ? <p className="mt-2 whitespace-pre-wrap leading-5 text-brand-text-dark">{request}</p> : null}
          {diff ? <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-white p-2 font-mono text-[11px] leading-4 text-brand-text-dark">{diff}</pre> : null}
        </details>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[10px] text-brand-text-light">{formatActivityTime(notification.createdAt)}</p>
        <div className="flex shrink-0 items-center gap-2">
          {isPendingSkillProposal ? (
            <button
              type="button"
              className="h-8 rounded-md border border-gray-200 px-2.5 text-xs font-medium text-brand-text-light hover:bg-gray-50 hover:text-brand-text-dark disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isApproving || isRejecting}
              onClick={() => onRejectSkillProposal(notification)}
            >
              {isRejecting ? "Rejecting" : "Reject"}
            </button>
          ) : null}
          {isPendingSkillProposal ? (
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-button px-2.5 text-xs font-medium text-white hover:bg-brand-button-hover disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isApproving || isRejecting}
              onClick={() => onApproveSkillProposal(notification)}
            >
              <Check className="size-3.5" />
              {isApproving ? "Creating" : "Approve"}
            </button>
          ) : null}
          {!notification.readAt ? (
            <button
              type="button"
              className="h-8 rounded-md border border-gray-200 px-2.5 text-xs font-medium text-brand-text-light hover:bg-gray-50 hover:text-brand-text-dark"
              onClick={() => onRead(notification.id)}
            >
              Mark read
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
