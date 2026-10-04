/** The server's API as the page sees it (architecture/server.md, "HTTP API" and "Live connection"). */

export interface ModelInUse {
  provider: string;
  model: string;
  source: "settings" | "detected";
}

export interface Lane {
  id: string;
  number: number;
  openedAt: string;
  closedAt: string | null;
  running: boolean;
  waitingForApproval: boolean;
}

export interface Embeddings {
  provider: "ollama" | "openrouter" | "openai" | "custom";
  model: string | null;
  url: string | null;
}

export interface Status {
  home: string;
  ready: boolean;
  setup: string[];
  access: Access;
  models: { chat: ModelInUse | null; router: ModelInUse | null };
  embeddings: Embeddings & { state: "ready" | "unavailable"; detail: string | null; index: { documents: number } | null };
  timeZone: string;
  busy: boolean;
  lanes: Lane[];
  workingFolder: { id: string; name: string; path: string } | null;
  seq: number;
}

export interface Access {
  scope: "folders" | "full";
  folders: string[];
  approvals: "ask" | "auto";
}

export interface ModelChoice {
  provider: string;
  model: string;
}

export interface Settings {
  chat: ModelChoice | null;
  router: ModelChoice | null;
  embeddings: Embeddings;
  timeZone: string | null;
  workingFolder: string | null;
  access: Access;
}

/** A model provider, its default models and the keys it reads. */
export interface Provider {
  name: string;
  main: string;
  router: string;
  keys: string[];
}

export interface Evidence {
  task: string;
  handle: string;
  tool: string;
  line: string;
  status: "ok" | "error" | null;
  content: string | null;
  truncated: boolean;
  outputLost: boolean;
}

export interface GoalView {
  number: number;
  title: string;
  objective: string | null;
  note: string | null;
  status: string;
  general: boolean;
  workspace: string | null;
  tasks: { number: number; title: string; status: string; note: string | null }[];
}

export interface HistoryPart {
  projectTurn: number;
  status: "in_progress" | "completed" | "interrupted" | "failed" | string;
  goal: { number: number; title: string };
  task: { number: number; title: string };
  lane: number | null;
  handedOff: boolean;
  answer: string | null;
  interrupted: string | null;
  toolCalls: { handle: string; line: string; status: "ok" | "error" | null }[];
}

export interface HistoryItem {
  id: string;
  /** The message event's sequence number. */
  seq: number;
  at: string;
  message: string;
  unrouted: boolean;
  question: string | null;
  parts: HistoryPart[];
}

export interface History {
  items: HistoryItem[];
  next: number | null;
}

export interface Folders {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
}

export type ActivityBody =
  | { kind: "message"; text: string }
  | { kind: "routed"; turnId: string; projectTurn: number; goal: { number: number; title: string }; task: { number: number; title: string }; lane: number | null }
  | { kind: "question"; turnId: string; text: string }
  | { kind: "step"; turnId: string; text: string }
  | { kind: "tool_started"; turnId: string; task: string; handle: string; line: string }
  | { kind: "tool_finished"; turnId: string; task: string; handle: string; status: "ok" | "error"; preview: string; truncated: boolean }
  | { kind: "answer"; turnId: string; text: string }
  | { kind: "finished"; turnId: string; status: "completed" | "interrupted"; reason: string | null }
  | { kind: "handed_off"; turnId: string; lane: number }
  | { kind: "lane"; laneId: string; number: number; state: "opened" | "closed" }
  | { kind: "approval_decided"; turnId: string | null; granted: boolean; detail: string }
  | { kind: "warning"; turnId: string | null; detail: string }
  | { kind: "ledger" };

export type Activity = { seq: number; at: string; conversation: string } & ActivityBody;

export interface PendingApproval {
  id: string;
  conversation: string;
  lane: number | null;
  turnId: string | null;
  task: string | null;
  kind: string;
  tool: string;
  detail: string;
  preview: string | null;
}

export interface LiveState {
  seq: number;
  ready: boolean;
  setup: string[];
  access: Access;
  busy: boolean;
  lanes: Lane[];
  queue: { id: string; text: string }[];
  approvals: PendingApproval[];
}

export type ServerMessage =
  | ({ type: "state" } & LiveState)
  | ({ type: "activity" } & Activity)
  | { type: "draft"; conversation: string; turnId: string; call: number; kind: "narration" | "answer"; text: string }
  | { type: "accepted"; id: string; conversation: string }
  | ({ type: "approval" } & PendingApproval)
  | { type: "handed_off"; id: string; conversation: string; lane: number; mainReleased: boolean }
  | { type: "status"; id: string; conversation: string; text: string }
  | { type: "result"; id: string; conversation: string; result: { kind: string; text: string; notices: string[] } }
  | { type: "error"; id?: string; conversation?: string; code: string; message: string }
  | { type: "reset"; seq: number };

/** What a page sends on the live connection. */
export type Command =
  | { type: "hello"; after?: number }
  | { type: "send"; id: string; text: string; to: string }
  | { type: "queue"; id: string; text: string }
  | { type: "queue_remove"; id: string }
  | { type: "queue_to_lane"; id: string }
  | { type: "cancel"; conversation: string }
  | { type: "approve"; approval: string; granted: boolean }
  | { type: "close_lane"; lane: string };

/** Lanes that may run at once beside the main conversation. */
export const MAX_RUNNING_LANES = 4;
