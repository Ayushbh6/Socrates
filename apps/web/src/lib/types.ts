/** The server's API as the page sees it (architecture/server.md, "HTTP API" and "Live connection"). */

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelInUse {
  provider: string;
  model: string;
  source: "settings" | "detected";
  /** Whether the model can see images; reported for the chat model. */
  vision?: boolean;
  /** The chat model's thinking levels, weakest first, its default, and the one in use; absent when it has none to choose. */
  effort?: { levels: Effort[]; default: Effort | null; current: Effort | null };
}

/** A model a provider offers for chat. */
export interface ListedModel {
  id: string;
  name?: string;
}

/** An image attached to a message, as the server stores it (`/api/attachments/<id>` serves it). */
export interface AttachmentView {
  id: string;
  name: string;
  media_type: string;
  width: number;
  height: number;
  bytes: number;
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

/** The user's name and whether they finished onboarding. */
export interface Profile {
  name: string | null;
  onboarded: boolean;
}

export interface Status {
  home: string;
  ready: boolean;
  setup: string[];
  access: Access;
  profile: Profile;
  models: { chat: ModelInUse | null; router: ModelInUse | null; /** null: compaction uses the chat model. */ compactor: ModelInUse | null; /** Names standard-mode chats. */ titler?: ModelInUse | null };
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
  /** The chat model's thinking level; null or absent is Socrates' default for it. */
  effort?: Effort | null;
}

export interface Settings {
  chat: ModelChoice | null;
  router: ModelChoice | null;
  /** The model that writes history checkpoints when a long turn is compacted; null uses the chat model. */
  compactor: ModelChoice | null;
  /** The model that names standard-mode chats; null: qwen3-30b-a3b-instruct on OpenRouter when there is a key, else the routing model. */
  titler?: ModelChoice | null;
  embeddings: Embeddings;
  timeZone: string | null;
  workingFolder: string | null;
  access: Access;
  profile: Profile;
  /** What a model costs, in US dollars per million tokens, by model id; over the list prices Socrates looks up. */
  prices: Record<string, { input: number; cachedInput: number | null; cacheWrite: number | null; output: number }>;
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
  call?: CallView;
  status: "ok" | "error" | null;
  content: string | null;
  truncated: boolean;
  outputLost: boolean;
}

/** Standard mode's choice of where a message goes (architecture/server.md, "Live connection"): a goal (null: Chats) and its chat (null: a new one). */
export interface ChatChoice {
  goal: number | null;
  task: number | null;
}

/** What is archived (architecture/server.md, "HTTP API"). */
export interface ArchivedView {
  goals: { number: number; title: string; archivedAt: string; chats: number }[];
  tasks: { goal: { number: number; title: string }; number: number; title: string; archivedAt: string }[];
}

export interface GoalView {
  number: number;
  title: string;
  objective: string | null;
  note: string | null;
  status: string;
  general: boolean;
  /** The goal standard mode shows as its plain chats, outside any goal. */
  chats?: boolean;
  workspace: string | null;
  tasks: { number: number; title: string; chats?: number; status: string; closed?: ClosedBy | null; note: string | null; objective?: string; completionCriteria?: string | null }[];
}

/** A goal's or task's status: open, completed, or superseded (replaced by other work). */
export type LedgerStatus = "open" | "completed" | "superseded";

/** Who closed a task that is not open: the user, or Socrates with its reason. */
export interface ClosedBy {
  by: "user" | "socrates";
  reason: string | null;
  at: string;
}

/** Flow mode's "Keep my next message in this task": the task one message goes to, unrouted. */
export interface KeepChoice {
  goal: number;
  task: number;
}

export interface HistoryPart {
  turnId?: string;
  projectTurn: number;
  status: "in_progress" | "completed" | "interrupted" | "failed" | string;
  goal: { number: number; title: string };
  task: { number: number; title: string };
  chat: number;
  lane: number | null;
  handedOff: boolean;
  answer: string | null;
  interrupted: string | null;
  toolCalls: { handle: string; line: string; status: "ok" | "error" | null }[];
}

export interface HistoryItem {
  attachments?: AttachmentView[];
  throughSeq?: number;
  activities?: Activity[];
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
  seq?: number;
  items: HistoryItem[];
  next: number | null;
}

export interface Folders {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
}

/** A tool call in plain words (architecture/server.md, "Live activity"). */
export interface CallView {
  kind: "read" | "search" | "edit" | "terminal" | "memory" | "capability" | "other";
  verb: string;
  active: string;
  target: string;
  detail: string | null;
}

/** What a tool call returned, in a form to read. */
export interface ResultView {
  summary: string | null;
  preview: string;
  truncated: boolean;
  diff: string | null;
  verb: string | null;
  ms: number | null;
  /** Whether the call, or the command it ran, failed; older servers leave it out. */
  failed?: boolean;
}

/** A chat as the page names it: its goal, its task, and which chat of the task. */
export interface Place {
  goal: { number: number; title: string };
  task: { number: number; title: string };
  chat: number;
}

export type ActivityBody =
  | { kind: "message"; text: string; attachments?: AttachmentView[] }
  | { kind: "routed"; turnId: string; messageSeq?: number | null; projectTurn: number; goal: { number: number; title: string }; task: { number: number; title: string }; chat?: number; lane: number | null; redoneFrom?: Place }
  /** The turn's question was asked again in another task; the turn is set aside. */
  | { kind: "redone"; turnId: string; to: Place }
  | { kind: "question"; turnId: string; text: string }
  | { kind: "step"; turnId: string; text: string; thinking?: string | null; thinkingTruncated?: boolean }
  | { kind: "tool_started"; turnId: string; task: string; handle: string; line: string; call: CallView }
  | { kind: "tool_finished"; turnId: string; task: string; handle: string; status: "ok" | "error"; result: ResultView }
  | { kind: "answer"; turnId: string; text: string }
  | { kind: "finished"; turnId: string; status: "completed" | "interrupted"; reason: string | null; partial?: string | null }
  | { kind: "handed_off"; turnId: string; lane: number; laneId?: string; goal?: { number: number; title: string }; task?: { number: number; title: string } }
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
  settings?: Settings;
  seq: number;
  ready: boolean;
  setup: string[];
  access: Access;
  busy: boolean;
  lanes: Lane[];
  /** The tasks with a message working in them now (standard mode's busy chats). */
  working?: { goal: number; task: number }[];
  /** Waiting messages: for the main conversation, or for their standard-mode chat. */
  queue: { id: string; text: string; attachments?: AttachmentView[]; chat?: ChatChoice }[];
  approvals: PendingApproval[];
}

/** A terminal session the agent started, as the terminal panel lists it (apps/server/src/terminals.ts). */
export interface TerminalView {
  id: string;
  name: string;
  command: string;
  cwd: string;
  /** The task that started it, by title. */
  task: string | null;
  status: "running" | "exited";
  exitCode: number | null;
  signal: string | null;
  reason: string | null;
  /** A terminal the user can type into; over pipes it only shows output. */
  pty: boolean;
  background: boolean;
  ready: boolean | null;
  inputRequired: boolean;
  ports: number[];
  cols: number | null;
  rows: number | null;
  startedAt: string;
  exitedAt: string | null;
}

export type ServerMessage =
  | ({ type: "state" } & LiveState)
  | ({ type: "activity" } & Activity)
  | { type: "draft"; conversation: string; turnId: string; call: number; kind: "narration" | "answer" | "thinking" | "output"; handle?: string; text: string; length?: number }
  /** `seq`: the saved message, when it was bound at once (a standard-mode chat's), so a message queued and started later is known as this page's. */
  | { type: "accepted"; id: string; conversation: string; seq?: number }
  | ({ type: "approval" } & PendingApproval)
  | { type: "handed_off"; id: string; conversation: string; lane: number; mainReleased: boolean }
  | { type: "status"; id: string; conversation: string; text: string }
  | { type: "result"; id: string; conversation: string; result: { kind: string; text: string; notices: string[] } }
  | { type: "error"; id?: string; conversation?: string; code: string; message: string }
  | { type: "reset"; seq: number }
  | { type: "terminals"; terminals: TerminalView[] }
  | { type: "terminal_replay"; session: string; data: string; cols: number | null; rows: number | null }
  | { type: "terminal_output"; session: string; data: string }
  | { type: "terminal_restarted"; session: string; next: string };

/** What a page sends on the live connection. */
export type Command =
  | { type: "hello"; after?: number }
  | { type: "send"; id: string; text: string; to: string; attachments?: { id: string; name: string }[]; chat?: ChatChoice; keep?: KeepChoice }
  | { type: "queue"; id: string; text: string; attachments?: { id: string; name: string }[]; chat?: ChatChoice; keep?: KeepChoice }
  | { type: "redo"; id: string; turn: string; chat?: ChatChoice; general?: true }
  | { type: "queue_remove"; id: string }
  | { type: "queue_to_lane"; id: string }
  | { type: "cancel"; conversation: string; chat?: ChatChoice }
  | { type: "approve"; approval: string; granted: boolean }
  | { type: "close_lane"; lane: string }
  | { type: "terminal_open" | "terminal_shut" | "terminal_stop" | "terminal_restart" | "terminal_dismiss"; session: string }
  | { type: "terminal_input"; session: string; data: string }
  | { type: "terminal_resize"; session: string; cols: number; rows: number };

/** Lanes that may run at once beside the main conversation. */
export const MAX_RUNNING_LANES = 4;
/** Standard-mode chats that may run at once; another waits in the queue. */
export const MAX_RUNNING_CHATS = 4;
