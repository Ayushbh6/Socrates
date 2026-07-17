import type { Project } from "@socrates/contracts";

export type FlowPresenceState =
  | "offline"
  | "idle"
  | "listening"
  | "routing"
  | "thinking"
  | "working"
  | "awaiting_input"
  | "complete"
  | "error";

export type FlowGoalStatus =
  | "foreground"
  | "parked"
  | "blocked"
  | "completed"
  | "archived";

export interface FlowGoalView {
  id: string;
  title: string;
  kind: "general" | "work";
  status: FlowGoalStatus;
  summary?: string;
  pinned: boolean;
  updatedAt?: string;
}

export interface FlowTimelineItemView {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  attachments?: Array<{
    id: string;
    fileName: string;
    kind: "image" | "text" | "skill_zip" | "audio";
    url?: string;
  }>;
  status?: "streaming" | "completed" | "failed" | "cancelled";
  createdAt?: string;
  goalId?: string;
  readAloudAvailable?: boolean;
}

export interface FlowApprovalView {
  id: string;
  actionKind: string;
  actionSummary?: string;
  status?: "pending" | "approved" | "rejected" | "expired" | "cancelled";
}

export interface FlowToolActivityView {
  id: string;
  name: string;
  status: "pending" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled";
  summary?: string;
  resultSummary?: string;
}

export interface FlowTerminalActivityView {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: "starting" | "running" | "awaiting_input" | "detached" | "exited" | "stopped" | "stale" | "missing";
  awaitingInput: boolean;
  output: string;
}

export interface FlowCredentialRequestView {
  id: string;
  turnId: string;
  serverLabel: string;
  envKey: string;
}

export interface FlowVoiceOption {
  id: string;
  label: string;
}

export interface FlowProjectNavItem {
  project: Project;
  workspaceLabel?: string;
  lastActivityAt?: string;
}

export interface FlowModelOption {
  id: string;
  label: string;
  providerLabel?: string;
}

export interface FlowThinkingOption {
  id: string;
  label: string;
  enabled: boolean;
}

export interface FlowDraftAttachment {
  id: string;
  fileName: string;
  kind: "image" | "text" | "skill_zip" | "other";
  sizeBytes?: number;
  previewUrl?: string;
}

export interface FlowContextSummary {
  exactEvidenceCount?: number;
  distilledEvidenceCount?: number;
  unresolvedEvidenceCount?: number;
  contextUsageLabel?: string;
  lastCompactedAt?: string;
  unavailableReason?: string;
}
