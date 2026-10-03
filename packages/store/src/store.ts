import { DatabaseSync } from "node:sqlite";
import type { EventPayloads, EventRefs, EventType, StoredEvent, TurnStop } from "@socrates/contracts";
import { type Clock, newId, systemClock, truncateToTokens } from "@socrates/shared";
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

export type LedgerStatus = "open" | "completed" | "superseded";

export interface Workspace {
  id: string;
  name: string;
  rootPath: string | null;
  createdAt: string;
}

export interface Goal {
  id: string;
  number: number;
  workspaceId: string | null;
  title: string;
  status: LedgerStatus;
  general: boolean;
  /** The durable outcome the goal works toward; null for goals created before objectives existed. */
  objective: string | null;
  note: string | null;
  noteRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  goalId: string;
  number: number;
  title: string;
  objective: string;
  /** How the task's outcome is known to be done; null when it was never proposed. */
  completionCriteria: string | null;
  status: LedgerStatus;
  general: boolean;
  continuationNote: string | null;
  revision: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface Chat {
  id: string;
  taskId: string;
  ordinal: number;
  continuationOf: string | null;
  handoverRef: string | null;
  compactionCount: number;
  openedAt: string;
  closedAt: string | null;
}

export interface Turn {
  id: string;
  projectTurn: number;
  kind: "task" | "clarification";
  goalId: string | null;
  taskId: string | null;
  chatId: string | null;
  partOrder: number | null;
  userEventId: string;
  responseEventId: string | null;
  workspaceConfidence: "high" | "low" | null;
  gateArmed: boolean;
  status: "in_progress" | "completed" | "interrupted";
  createdAt: string;
  completedAt: string | null;
}

export interface Anchor {
  id: string;
  goalId: string;
  path: string;
  role: string;
  status: "provisional" | "active" | "superseded";
  summary: string;
}

/** One stored user message with its visible response and every turn it was bound to. */
export interface Exchange {
  userEventId: string;
  userMessage: string;
  response: string;
  at: string;
  projectTurns: number[];
  kind: "task" | "clarification";
  bindings: { goalId: string; taskId: string }[];
}

export interface CurrentBinding {
  goal: Goal;
  task: Task;
  chat: Chat;
}

export interface FtsHit {
  entity: "goal" | "task";
  entityId: string;
  goalId: string;
  /** SQLite bm25(): lower (more negative) is better. */
  bm25: number;
}

/** Event references of work bound to a task. */
export interface TaskRefs extends EventRefs {
  goal_id: string;
  task_id: string;
}

/** One persisted tool call and its result, addressed by its permanent task-local handle. */
export interface Evidence {
  taskId: string;
  number: number;
  handle: string;
  callId: string;
  tool: string;
  turnId: string | null;
  input: unknown;
  status: "ok" | "error" | null;
  result: EventPayloads["tool_completed"] | null;
  createdAt: string;
}

/** One completed Q&A pair as `context_retrieve search` returns it. */
export interface ExchangeHit {
  turnId: string;
  projectTurn: number;
  taskId: string;
  goalId: string;
  at: string;
  userMessage: string;
  response: string;
}

export interface ActiveCapability {
  goalId: string;
  kind: "skill" | "mcp";
  name: string;
  version: string;
  digest: string;
  activatedAt: string;
}

export interface TaskFact {
  kind: "file_changed" | "command" | "test" | "capability";
  value: string;
  createdAt: string;
}

/** A history checkpoint or handover capsule of a task, addressed as `hc-N`. */
export interface HistoryRecord {
  taskId: string;
  number: number;
  handle: string;
  kind: "checkpoint" | "handover";
  chatId: string;
  turnId: string | null;
  /** Covered project-turn range; 0/0 when the record covers no turns. */
  from: number;
  to: number;
  content: unknown;
  mechanical: boolean;
  createdAt: string;
}

export interface TaskWithGoal {
  task: Task;
  goal: Goal;
  workspace: Workspace | null;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v);

function toGoal(r: Row): Goal {
  return {
    id: str(r.id),
    number: num(r.goal_number),
    workspaceId: strOrNull(r.workspace_id),
    title: str(r.title),
    status: str(r.status) as LedgerStatus,
    general: num(r.is_general) === 1,
    objective: strOrNull(r.objective),
    note: strOrNull(r.note),
    noteRevision: num(r.note_revision),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function toTask(r: Row): Task {
  return {
    id: str(r.id),
    goalId: str(r.goal_id),
    number: num(r.task_number),
    title: str(r.title),
    objective: str(r.objective),
    completionCriteria: strOrNull(r.completion_criteria),
    status: str(r.status) as LedgerStatus,
    general: num(r.is_general) === 1,
    continuationNote: strOrNull(r.continuation_note),
    revision: num(r.revision),
    startedAt: str(r.started_at),
    updatedAt: str(r.updated_at),
    completedAt: strOrNull(r.completed_at),
  };
}

function toChat(r: Row): Chat {
  return {
    id: str(r.id),
    taskId: str(r.task_id),
    ordinal: num(r.ordinal),
    continuationOf: strOrNull(r.continuation_of),
    handoverRef: strOrNull(r.handover_ref),
    compactionCount: num(r.compaction_count),
    openedAt: str(r.opened_at),
    closedAt: strOrNull(r.closed_at),
  };
}

function toTurn(r: Row): Turn {
  return {
    id: str(r.id),
    projectTurn: num(r.project_turn),
    kind: str(r.kind) as Turn["kind"],
    goalId: strOrNull(r.goal_id),
    taskId: strOrNull(r.task_id),
    chatId: strOrNull(r.chat_id),
    partOrder: r.part_order === null ? null : num(r.part_order),
    userEventId: str(r.user_event_id),
    responseEventId: strOrNull(r.response_event_id),
    workspaceConfidence: strOrNull(r.workspace_confidence) as Turn["workspaceConfidence"],
    gateArmed: num(r.gate_armed) === 1,
    status: str(r.status) as Turn["status"],
    createdAt: str(r.created_at),
    completedAt: strOrNull(r.completed_at),
  };
}

function toHistoryRecord(r: Row): HistoryRecord {
  return {
    taskId: str(r.task_id),
    number: num(r.number),
    handle: `hc-${num(r.number)}`,
    kind: str(r.kind) as HistoryRecord["kind"],
    chatId: str(r.chat_id),
    turnId: strOrNull(r.turn_id),
    from: num(r.from_turn),
    to: num(r.to_turn),
    content: JSON.parse(str(r.content)),
    mechanical: num(r.mechanical) === 1,
    createdAt: str(r.created_at),
  };
}

function toWorkspace(r: Row): Workspace {
  return { id: str(r.id), name: str(r.name), rootPath: strOrNull(r.root_path), createdAt: str(r.created_at) };
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export const GENERAL_GOAL_TITLE = "General conversation";
export const GENERAL_TASK_TITLE = "General";

export interface OpenStoreOptions {
  /** File path, or ":memory:" for an ephemeral store. */
  path: string;
  clock?: Clock;
}

/**
 * The event log and ledger. Every mutation runs in a transaction that appends
 * its event first and then advances the projections, so the projections can
 * always be explained by the log.
 */
export class LedgerStore {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  private txDepth = 0;

  private constructor(db: DatabaseSync, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  static open(options: OpenStoreOptions): LedgerStore {
    const db = new DatabaseSync(options.path);
    db.exec("PRAGMA foreign_keys = ON;");
    if (options.path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA_SQL);
    const store = new LedgerStore(db, options.clock ?? systemClock);
    const version = store.getMeta("schema_version");
    if (version === null) store.setMeta("schema_version", String(SCHEMA_VERSION));
    else {
      let current = Number(version);
      const from = current;
      if (current > SCHEMA_VERSION) throw new StoreError(`Unsupported store schema version ${version}; expected ${SCHEMA_VERSION}.`);
      store.transaction(() => {
        while (current < SCHEMA_VERSION) {
          const migration = MIGRATIONS[current];
          if (migration === undefined) throw new StoreError(`No migration from store schema version ${current}.`);
          db.exec(migration);
          current++;
          store.setMeta("schema_version", String(current));
        }
        if (from < 3) store.rebuildExchangeIndex();
      });
    }
    return store;
  }

  close(): void {
    this.db.close();
  }

  now(): string {
    return this.clock.now().toISOString();
  }

  /** Run `fn` atomically. Nested calls use savepoints. */
  transaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    const savepoint = `sp_${depth}`;
    this.db.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.txDepth++;
    try {
      const result = fn();
      this.db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    } finally {
      this.txDepth--;
    }
  }

  private all(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private get(sql: string, ...params: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  private run(sql: string, ...params: (string | number | null)[]): void {
    this.db.prepare(sql).run(...params);
  }

  getMeta(key: string): string | null {
    const row = this.get("SELECT value FROM meta WHERE key = ?", key);
    return row ? str(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  // ── Event log ────────────────────────────────────────────────────────────

  appendEvent<T extends EventType>(type: T, payload: EventPayloads[T], refs: EventRefs = {}): StoredEvent<T> {
    const id = newId("evt");
    const at = this.now();
    this.run(
      "INSERT INTO events (id, type, at, goal_id, task_id, chat_id, turn_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      type,
      at,
      refs.goal_id ?? null,
      refs.task_id ?? null,
      refs.chat_id ?? null,
      refs.turn_id ?? null,
      JSON.stringify(payload),
    );
    const row = this.get("SELECT seq FROM events WHERE id = ?", id);
    return {
      seq: num(row?.seq),
      id,
      type,
      at,
      goal_id: refs.goal_id ?? null,
      task_id: refs.task_id ?? null,
      chat_id: refs.chat_id ?? null,
      turn_id: refs.turn_id ?? null,
      payload,
    };
  }

  getEvent(id: string): StoredEvent | null {
    const r = this.get("SELECT * FROM events WHERE id = ?", id);
    return r ? this.toEvent(r) : null;
  }

  listEvents(filter: { type?: EventType; turnId?: string; taskId?: string; goalId?: string } = {}): StoredEvent[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.type) (where.push("type = ?"), params.push(filter.type));
    if (filter.turnId) (where.push("turn_id = ?"), params.push(filter.turnId));
    if (filter.taskId) (where.push("task_id = ?"), params.push(filter.taskId));
    if (filter.goalId) (where.push("goal_id = ?"), params.push(filter.goalId));
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq`;
    return this.all(sql, ...params).map((r) => this.toEvent(r));
  }

  private toEvent(r: Row): StoredEvent {
    return {
      seq: num(r.seq),
      id: str(r.id),
      type: str(r.type) as EventType,
      at: str(r.at),
      goal_id: strOrNull(r.goal_id),
      task_id: strOrNull(r.task_id),
      chat_id: strOrNull(r.chat_id),
      turn_id: strOrNull(r.turn_id),
      payload: JSON.parse(str(r.payload)),
    };
  }

  /** Persist the exact user message before anything else happens to it. */
  recordUserMessage(text: string): StoredEvent<"user_message"> {
    return this.appendEvent("user_message", { text });
  }

  /** The latest turn, independent of the bounded router-history window. */
  pendingClarification(): Turn | null {
    const r = this.get("SELECT * FROM turns ORDER BY project_turn DESC LIMIT 1");
    return r && r.kind === "clarification" ? toTurn(r) : null;
  }

  /** Exact request and clarification records for the worker handoff. */
  requestForTurn(turnId: string): { request: string; clarification: { requestEventId: string; questionEventId: string; answerEventId: string; question: string; answer: string } | null } {
    const turn = this.requireTurn(turnId);
    const bound = this.listEvents({ turnId, type: "turn_bound" })[0];
    const p = bound?.payload as EventPayloads["turn_bound"] | undefined;
    const requestEventId = p?.request_event_id ?? turn.userEventId;
    const request = this.getEvent(requestEventId)?.payload as EventPayloads["user_message"] | undefined;
    if (!request || typeof request.text !== "string") throw new StoreError("Request event is missing.");
    const text = p?.request_range ? request.text.slice(...p.request_range) : request.text;
    if (!p?.clarification_turn_id) return { request: text, clarification: null };
    const clarification = this.requireTurn(p.clarification_turn_id);
    const question = this.getEvent(clarification.responseEventId!)!.payload as EventPayloads["assistant_response"];
    const answer = this.getEvent(turn.userEventId)!.payload as EventPayloads["user_message"];
    return { request: text, clarification: { requestEventId, questionEventId: clarification.responseEventId!, answerEventId: turn.userEventId, question: question.text, answer: answer.text } };
  }

  /** Restore into an empty store using only the append-only log. No IDs or
   * timestamps are regenerated; malformed/legacy incomplete logs fail atomically. */
  restoreEvents(events: StoredEvent[]): void {
    if (this.listEvents().length || this.listGoals().length || this.all("SELECT id FROM workspaces LIMIT 1").length) {
      throw new StoreError("Event restoration requires an empty store.");
    }
    this.transaction(() => {
      let previous = 0;
      for (const e of events) {
        if (e.seq <= previous) throw new StoreError("Events must be in ascending sequence order.");
        previous = e.seq;
        this.run("INSERT INTO events (seq, id, type, at, goal_id, task_id, chat_id, turn_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", e.seq, e.id, e.type, e.at, e.goal_id, e.task_id, e.chat_id, e.turn_id, JSON.stringify(e.payload));
        this.projectEvent(e);
      }
      for (const g of this.listGoals()) this.indexGoal(g.id);
      for (const t of this.allTasks()) this.indexTask(t.task.id);
      this.rebuildExchangeIndex();
    });
  }

  private projectEvent(e: StoredEvent): void {
    switch (e.type) {
      case "workspace_created": {
        const p = e.payload as EventPayloads["workspace_created"];
        if (!p.workspace_id) throw new StoreError("Legacy workspace event has no identity.");
        this.run("INSERT INTO workspaces (id, name, root_path, created_at) VALUES (?, ?, ?, ?)", p.workspace_id, p.name, p.root_path, e.at); break;
      }
      case "goal_created": {
        const p = e.payload as EventPayloads["goal_created"];
        this.run("INSERT INTO goals (id, goal_number, workspace_id, title, status, is_general, objective, note_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, 0, ?, ?)", e.goal_id, p.goal_number, p.workspace_id, p.title, p.general ? 1 : 0, p.objective ?? null, e.at, e.at); break;
      }
      case "goal_workspace_bound": {
        const p = e.payload as EventPayloads["goal_workspace_bound"];
        this.run("UPDATE goals SET workspace_id = ?, updated_at = ? WHERE id = ?", p.workspace_id, e.at, e.goal_id); break;
      }
      case "goal_note_revised": {
        const p = e.payload as EventPayloads["goal_note_revised"];
        this.run("INSERT INTO goal_note_revisions (goal_id, revision, note, event_id, created_at) VALUES (?, ?, ?, ?, ?)", e.goal_id, p.revision, p.note, e.id, e.at);
        this.run("UPDATE goals SET note = ?, note_revision = ?, updated_at = ? WHERE id = ?", p.note, p.revision, e.at, e.goal_id); break;
      }
      case "task_created": {
        const p = e.payload as EventPayloads["task_created"];
        this.run("INSERT INTO tasks (id, goal_id, task_number, title, objective, completion_criteria, status, is_general, revision, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?)", e.task_id, e.goal_id, p.task_number, p.title, p.objective, p.completion_criteria ?? null, p.general ? 1 : 0, e.at, e.at);
        this.run("INSERT INTO task_revisions (task_id, revision, title, objective, completion_criteria, status, event_id, created_at) VALUES (?, 1, ?, ?, ?, 'open', ?, ?)", e.task_id, p.title, p.objective, p.completion_criteria ?? null, e.id, e.at);
        this.run("UPDATE goals SET updated_at = ? WHERE id = ?", e.at, e.goal_id); break;
      }
      case "task_revised": {
        const p = e.payload as EventPayloads["task_revised"];
        const task = this.requireTask(e.task_id!);
        const completed = p.status === "completed" ? task.completedAt ?? e.at : null;
        const criteria = p.completion_criteria === undefined ? task.completionCriteria : p.completion_criteria;
        this.run("INSERT INTO task_revisions (task_id, revision, title, objective, completion_criteria, status, continuation_note, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", e.task_id, p.revision, p.title, p.objective, criteria, p.status, p.continuation_note, e.id, e.at);
        this.run("UPDATE tasks SET title = ?, objective = ?, completion_criteria = ?, status = ?, continuation_note = ?, revision = ?, updated_at = ?, completed_at = ? WHERE id = ?", p.title, p.objective, criteria, p.status, p.continuation_note, p.revision, e.at, completed, e.task_id);
        this.run("UPDATE goals SET updated_at = ? WHERE id = ?", e.at, e.goal_id); break;
      }
      case "chat_opened": {
        const p = e.payload as EventPayloads["chat_opened"];
        this.run("INSERT INTO chats (id, task_id, ordinal, continuation_of, handover_ref, compaction_count, opened_at) VALUES (?, ?, ?, ?, ?, 0, ?)", e.chat_id, e.task_id, p.ordinal, p.continuation_of, p.handover_ref ?? null, e.at); break;
      }
      case "turn_bound": {
        const p = e.payload as EventPayloads["turn_bound"];
        if (!p.user_event_id) throw new StoreError("Legacy turn event has no user-message linkage.");
        this.run("INSERT INTO turns (id, project_turn, kind, goal_id, task_id, chat_id, part_order, user_event_id, workspace_confidence, gate_armed, status, created_at) VALUES (?, ?, 'task', ?, ?, ?, ?, ?, ?, ?, 'in_progress', ?)", e.turn_id, p.project_turn, e.goal_id, e.task_id, e.chat_id, p.part_order, p.user_event_id, p.workspace_confidence, p.first_mutation_gate_armed ? 1 : 0, e.at); break;
      }
      case "clarification_bound": {
        const p = e.payload as EventPayloads["clarification_bound"];
        this.run("INSERT INTO turns (id, project_turn, kind, user_event_id, gate_armed, status, created_at) VALUES (?, ?, 'clarification', ?, 0, 'in_progress', ?)", e.turn_id, p.project_turn, p.user_event_id, e.at); break;
      }
      case "turn_completed": {
        const p = e.payload as EventPayloads["turn_completed"];
        if (this.getEvent(p.response_event_id)?.type !== "assistant_response") throw new StoreError("Completion response is missing.");
        this.run("UPDATE turns SET response_event_id = ?, status = 'completed', completed_at = ? WHERE id = ?", p.response_event_id, e.at, e.turn_id); break;
      }
      case "history_record_created": {
        const p = e.payload as EventPayloads["history_record_created"];
        this.insertHistoryRecord(e as StoredEvent<"history_record_created">, p);
        break;
      }
      case "compaction_recorded": {
        const p = e.payload as EventPayloads["compaction_recorded"];
        this.run("UPDATE chats SET compaction_count = ? WHERE id = ?", p.count, e.chat_id);
        break;
      }
      case "chat_closed":
        this.run("UPDATE chats SET closed_at = ? WHERE id = ?", e.at, e.chat_id); break;
      case "turn_interrupted":
        this.run("UPDATE turns SET status = 'interrupted', completed_at = ? WHERE id = ?", e.at, e.turn_id); break;
      case "anchor_revised": {
        const p = e.payload as EventPayloads["anchor_revised"];
        this.run("INSERT INTO anchors (id, goal_id, path, role, status, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, summary = excluded.summary, updated_at = excluded.updated_at", p.anchor_id, e.goal_id, p.path, p.role, p.status, p.summary, e.at, e.at); break;
      }
      case "tool_called": {
        const p = e.payload as EventPayloads["tool_called"];
        this.insertEvidence(e as StoredEvent<"tool_called">, handleNumber(p.handle)); break;
      }
      case "tool_completed":
        this.projectToolResult(e as StoredEvent<"tool_completed">); break;
      case "capability_activated": {
        const p = e.payload as EventPayloads["capability_activated"];
        this.run("INSERT INTO active_capabilities (goal_id, kind, name, version, digest, activated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(goal_id, name) DO UPDATE SET kind = excluded.kind, version = excluded.version, digest = excluded.digest, activated_at = excluded.activated_at", e.goal_id, p.kind, p.name, p.version, p.digest, e.at); break;
      }
      case "capability_deactivated": {
        const p = e.payload as EventPayloads["capability_deactivated"];
        this.run("DELETE FROM active_capabilities WHERE goal_id = ? AND name = ?", e.goal_id, p.name); break;
      }
      case "user_message": case "assistant_response": case "clarification_asked": case "routing_completed":
      case "terminal_exited": {
        const p = e.payload as EventPayloads["terminal_exited"];
        if (e.task_id && p.facts?.length) {
          for (const [index, f] of p.facts.entries()) this.run("INSERT INTO task_facts (id, task_id, kind, value, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", `fact_${e.id}_${index}`, e.task_id, f.kind, f.value, e.id, e.at);
          this.indexTask(e.task_id);
        }
        break;
      }
      case "file_changed": case "terminal_started": case "approval_decided": case "history_omitted": case "agent_warning": case "agent_message": case "anchor_question": case "anchor_decided":
      case "mcp_tools_listed": case "skill_shelf_frozen": break;
      default: throw new StoreError(`Unsupported event type: ${e.type}`);
    }
  }

  // ── Workspaces ───────────────────────────────────────────────────────────

  createWorkspace(name: string, rootPath: string | null = null): Workspace {
    return this.transaction(() => {
      const id = newId("ws");
      const event = this.appendEvent("workspace_created", { workspace_id: id, name, root_path: rootPath });
      const createdAt = event.at;
      this.run("INSERT INTO workspaces (id, name, root_path, created_at) VALUES (?, ?, ?, ?)", id, name, rootPath, createdAt);
      return { id, name, rootPath, createdAt };
    });
  }

  getWorkspace(id: string): Workspace | null {
    const r = this.get("SELECT * FROM workspaces WHERE id = ?", id);
    return r ? toWorkspace(r) : null;
  }

  findWorkspaceByName(name: string): Workspace | null {
    const r = this.get("SELECT * FROM workspaces WHERE name = ? COLLATE NOCASE", name);
    return r ? toWorkspace(r) : null;
  }

  // ── Goals ────────────────────────────────────────────────────────────────

  createGoal(input: { title: string; objective?: string | null; workspaceId?: string | null; general?: boolean }): Goal {
    input = { ...input, title: truncateToTokens(input.title, 15).text };
    const objective = input.objective ? truncateToTokens(input.objective, 40).text : null;
    return this.transaction(() => {
      const id = newId("goal");
      const next = num(this.get("SELECT COALESCE(MAX(goal_number), 0) + 1 AS n FROM goals")?.n);
      const workspaceId = input.workspaceId ?? null;
      const general = input.general ?? false;
      const event = this.appendEvent(
        "goal_created",
        { goal_number: next, title: input.title, workspace_id: workspaceId, general, objective },
        { goal_id: id },
      );
      const at = event.at;
      this.run(
        `INSERT INTO goals (id, goal_number, workspace_id, title, status, is_general, objective, note, note_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, NULL, 0, ?, ?)`,
        id,
        next,
        workspaceId,
        input.title,
        general ? 1 : 0,
        objective,
        at,
        at,
      );
      this.indexGoal(id);
      return this.requireGoal(id);
    });
  }

  getGoal(id: string): Goal | null {
    const r = this.get("SELECT * FROM goals WHERE id = ?", id);
    return r ? toGoal(r) : null;
  }

  requireGoal(id: string): Goal {
    const goal = this.getGoal(id);
    if (!goal) throw new StoreError(`Goal ${id} does not exist.`);
    return goal;
  }

  getGoalByNumber(goalNumber: number): Goal | null {
    const r = this.get("SELECT * FROM goals WHERE goal_number = ?", goalNumber);
    return r ? toGoal(r) : null;
  }

  getGeneralGoal(): Goal | null {
    const r = this.get("SELECT * FROM goals WHERE is_general = 1");
    return r ? toGoal(r) : null;
  }

  listGoals(): Goal[] {
    return this.all("SELECT * FROM goals ORDER BY goal_number").map(toGoal);
  }

  /** A goal's workspace binding is permanent once set (Goal-router.md, rule 11). */
  bindGoalWorkspace(goalId: string, workspaceId: string): Goal {
    return this.transaction(() => {
      const goal = this.requireGoal(goalId);
      if (goal.workspaceId === workspaceId) return goal;
      if (goal.workspaceId !== null) throw new StoreError(`Goal g${goal.number} is already bound to a workspace.`);
      if (goal.general) throw new StoreError("The general goal has no workspace.");
      const event = this.appendEvent("goal_workspace_bound", { workspace_id: workspaceId }, { goal_id: goalId });
      this.run("UPDATE goals SET workspace_id = ?, updated_at = ? WHERE id = ?", workspaceId, event.at, goalId);
      this.indexGoal(goalId);
      for (const task of this.listTasks(goalId)) this.indexTask(task.id);
      return this.requireGoal(goalId);
    });
  }

  /** Append a goal-note revision and advance the goal projection. */
  reviseGoalNote(goalId: string, note: string): Goal {
    note = truncateToTokens(note, 150).text;
    return this.transaction(() => {
      const goal = this.requireGoal(goalId);
      const revision = goal.noteRevision + 1;
      const event = this.appendEvent("goal_note_revised", { revision, note }, { goal_id: goalId });
      const at = event.at;
      this.run(
        "INSERT INTO goal_note_revisions (goal_id, revision, note, event_id, created_at) VALUES (?, ?, ?, ?, ?)",
        goalId,
        revision,
        note,
        event.id,
        at,
      );
      this.run("UPDATE goals SET note = ?, note_revision = ?, updated_at = ? WHERE id = ?", note, revision, at, goalId);
      this.indexGoal(goalId);
      return this.requireGoal(goalId);
    });
  }

  listGoalNoteRevisions(goalId: string): { revision: number; note: string; createdAt: string }[] {
    return this.all("SELECT revision, note, created_at FROM goal_note_revisions WHERE goal_id = ? ORDER BY revision", goalId).map(
      (r) => ({ revision: num(r.revision), note: str(r.note), createdAt: str(r.created_at) }),
    );
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  createTask(goalId: string, input: { title: string; objective?: string; completionCriteria?: string | null; general?: boolean }): Task {
    return this.transaction(() => {
      this.requireGoal(goalId);
      const id = newId("task");
      const next = num(this.get("SELECT COALESCE(MAX(task_number), 0) + 1 AS n FROM tasks WHERE goal_id = ?", goalId)?.n);
      const title = truncateToTokens(input.title, 15).text;
      const objective = truncateToTokens(input.objective ?? title, 25).text;
      const completionCriteria = input.completionCriteria ? truncateToTokens(input.completionCriteria, 35).text : null;
      const general = input.general ?? false;
      const event = this.appendEvent(
        "task_created",
        { task_number: next, title, objective, general, completion_criteria: completionCriteria },
        { goal_id: goalId, task_id: id },
      );
      const at = event.at;
      this.run(
        `INSERT INTO tasks (id, goal_id, task_number, title, objective, completion_criteria, status, is_general, continuation_note, revision, started_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL, 1, ?, ?, NULL)`,
        id,
        goalId,
        next,
        title,
        objective,
        completionCriteria,
        general ? 1 : 0,
        at,
        at,
      );
      this.run(
        `INSERT INTO task_revisions (task_id, revision, title, objective, completion_criteria, status, continuation_note, event_id, created_at)
         VALUES (?, 1, ?, ?, ?, 'open', NULL, ?, ?)`,
        id,
        title,
        objective,
        completionCriteria,
        event.id,
        at,
      );
      this.run("UPDATE goals SET updated_at = ? WHERE id = ?", at, goalId);
      this.indexTask(id);
      return this.requireTask(id);
    });
  }

  getTask(id: string): Task | null {
    const r = this.get("SELECT * FROM tasks WHERE id = ?", id);
    return r ? toTask(r) : null;
  }

  requireTask(id: string): Task {
    const task = this.getTask(id);
    if (!task) throw new StoreError(`Task ${id} does not exist.`);
    return task;
  }

  getTaskByNumber(goalId: string, taskNumber: number): Task | null {
    const r = this.get("SELECT * FROM tasks WHERE goal_id = ? AND task_number = ?", goalId, taskNumber);
    return r ? toTask(r) : null;
  }

  /** Tasks of a goal, most recently updated first. */
  listTasks(goalId: string, options: { status?: LedgerStatus } = {}): Task[] {
    const rows = options.status
      ? this.all("SELECT * FROM tasks WHERE goal_id = ? AND status = ? ORDER BY updated_at DESC, task_number DESC", goalId, options.status)
      : this.all("SELECT * FROM tasks WHERE goal_id = ? ORDER BY updated_at DESC, task_number DESC", goalId);
    return rows.map(toTask);
  }

  /**
   * Append a ledger revision for a task and advance its current projection.
   * Every completed turn calls this, even when no field changed, so the
   * revision history records each turn.
   */
  reviseTask(
    taskId: string,
    changes: { status?: LedgerStatus; continuationNote?: string | null; title?: string; objective?: string; completionCriteria?: string | null },
  ): Task {
    return this.transaction(() => {
      const task = this.requireTask(taskId);
      const revision = task.revision + 1;
      const next = {
        title: truncateToTokens(changes.title ?? task.title, 15).text,
        objective: truncateToTokens(changes.objective ?? task.objective, 25).text,
        completionCriteria:
          changes.completionCriteria === undefined
            ? task.completionCriteria
            : changes.completionCriteria === null
              ? null
              : truncateToTokens(changes.completionCriteria, 35).text,
        status: changes.status ?? task.status,
        continuationNote: changes.continuationNote === undefined ? task.continuationNote : changes.continuationNote === null ? null : truncateToTokens(changes.continuationNote, 100).text,
      };
      const event = this.appendEvent(
        "task_revised",
        {
          revision,
          status: next.status,
          continuation_note: next.continuationNote,
          title: next.title,
          objective: next.objective,
          completion_criteria: next.completionCriteria,
        },
        { goal_id: task.goalId, task_id: taskId },
      );
      const at = event.at;
      this.run(
        `INSERT INTO task_revisions (task_id, revision, title, objective, completion_criteria, status, continuation_note, event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        taskId,
        revision,
        next.title,
        next.objective,
        next.completionCriteria,
        next.status,
        next.continuationNote,
        event.id,
        at,
      );
      const completedAt = next.status === "completed" ? (task.completedAt ?? at) : null;
      this.run(
        `UPDATE tasks SET title = ?, objective = ?, completion_criteria = ?, status = ?, continuation_note = ?, revision = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
        next.title,
        next.objective,
        next.completionCriteria,
        next.status,
        next.continuationNote,
        revision,
        at,
        completedAt,
        taskId,
      );
      this.run("UPDATE goals SET updated_at = ? WHERE id = ?", at, task.goalId);
      this.indexTask(taskId);
      return this.requireTask(taskId);
    });
  }

  listTaskRevisions(taskId: string): { revision: number; status: string; continuationNote: string | null }[] {
    return this.all("SELECT revision, status, continuation_note FROM task_revisions WHERE task_id = ? ORDER BY revision", taskId).map(
      (r) => ({ revision: num(r.revision), status: str(r.status), continuationNote: strOrNull(r.continuation_note) }),
    );
  }

  /** The single general goal and its single general task, created on first use. */
  ensureGeneral(): { goal: Goal; task: Task } {
    return this.transaction(() => {
      const goal =
        this.getGeneralGoal() ??
        this.createGoal({
          title: GENERAL_GOAL_TITLE,
          objective: "Greetings, small talk, and quick questions that belong to no project.",
          general: true,
        });
      const existing = this.get("SELECT * FROM tasks WHERE goal_id = ? AND is_general = 1", goal.id);
      const task = existing
        ? toTask(existing)
        : this.createTask(goal.id, {
            title: GENERAL_TASK_TITLE,
            objective: "Conversation and quick questions without a task anchor.",
            general: true,
          });
      return { goal: this.requireGoal(goal.id), task };
    });
  }

  // ── Chats ────────────────────────────────────────────────────────────────

  openChat(taskId: string, options: { continuationOf?: string | null; handoverRef?: string | null } = {}): Chat {
    return this.transaction(() => {
      const task = this.requireTask(taskId);
      const id = newId("chat");
      const ordinal = num(this.get("SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM chats WHERE task_id = ?", taskId)?.n);
      const continuationOf = options.continuationOf ?? null;
      const event = this.appendEvent(
        "chat_opened",
        { ordinal, continuation_of: continuationOf, handover_ref: options.handoverRef ?? null },
        { goal_id: task.goalId, task_id: taskId, chat_id: id },
      );
      this.run(
        "INSERT INTO chats (id, task_id, ordinal, continuation_of, handover_ref, compaction_count, opened_at, closed_at) VALUES (?, ?, ?, ?, ?, 0, ?, NULL)",
        id,
        taskId,
        ordinal,
        continuationOf,
        options.handoverRef ?? null,
        event.at,
      );
      return this.requireChat(id);
    });
  }

  requireChat(id: string): Chat {
    const r = this.get("SELECT * FROM chats WHERE id = ?", id);
    if (!r) throw new StoreError(`Chat ${id} does not exist.`);
    return toChat(r);
  }

  /** The open chat of a task, opening the first one if none exists. */
  currentChat(taskId: string): Chat {
    const r = this.get("SELECT * FROM chats WHERE task_id = ? AND closed_at IS NULL ORDER BY ordinal DESC LIMIT 1", taskId);
    return r ? toChat(r) : this.openChat(taskId);
  }

  // ── History checkpoints and rollover ─────────────────────────────────────

  /** Store a checkpoint or handover capsule under the task's next handle `hc-N`. */
  recordHistoryRecord(refs: TaskRefs & { chat_id: string }, input: { kind: HistoryRecord["kind"]; from: number; to: number; content: unknown; mechanical?: boolean }): HistoryRecord {
    return this.transaction(() => {
      const number = num(this.get("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM history_records WHERE task_id = ?", refs.task_id)?.n);
      const payload: EventPayloads["history_record_created"] = { number, kind: input.kind, from: input.from, to: input.to, content: input.content, mechanical: input.mechanical ?? false };
      const event = this.appendEvent("history_record_created", payload, refs);
      this.insertHistoryRecord(event, payload);
      return this.historyRecord(refs.task_id, number)!;
    });
  }

  private insertHistoryRecord(event: StoredEvent, p: EventPayloads["history_record_created"]): void {
    if (!event.task_id || !event.chat_id) throw new StoreError("History records must be bound to a task chat.");
    this.run(
      "INSERT INTO history_records (task_id, number, kind, chat_id, turn_id, from_turn, to_turn, content, mechanical, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      event.task_id, p.number, p.kind, event.chat_id, event.turn_id, p.from, p.to, JSON.stringify(p.content), p.mechanical ? 1 : 0, event.id, event.at,
    );
  }

  historyRecord(taskId: string, number: number): HistoryRecord | null {
    const r = this.get("SELECT * FROM history_records WHERE task_id = ? AND number = ?", taskId, number);
    return r ? toHistoryRecord(r) : null;
  }

  /** The task's newest checkpoint or capsule: the one in the prompt. Older ones are superseded. */
  latestHistoryRecord(taskId: string): HistoryRecord | null {
    const r = this.get("SELECT * FROM history_records WHERE task_id = ? ORDER BY number DESC LIMIT 1", taskId);
    return r ? toHistoryRecord(r) : null;
  }

  historyRecordCount(taskId: string): number {
    return num(this.get("SELECT COUNT(*) AS n FROM history_records WHERE task_id = ?", taskId)?.n);
  }

  /** Record one compaction of a chat and advance its count. */
  recordCompaction(refs: TaskRefs & { chat_id: string }, payload: Omit<EventPayloads["compaction_recorded"], "count">): Chat {
    return this.transaction(() => {
      const chat = this.requireChat(refs.chat_id);
      const full = { ...payload, count: chat.compactionCount + 1 };
      this.appendEvent("compaction_recorded", full, refs);
      this.run("UPDATE chats SET compaction_count = ? WHERE id = ?", full.count, chat.id);
      return this.requireChat(chat.id);
    });
  }

  /** Record turns a failed checkpoint leaves out of the prompt. */
  recordOmission(refs: TaskRefs & { chat_id: string }, range: EventPayloads["history_omitted"]): void {
    this.appendEvent("history_omitted", range, refs);
  }

  /**
   * Turns omitted by a failed checkpoint that no later checkpoint or capsule
   * has absorbed yet. The next successful one covers them again.
   */
  pendingOmission(taskId: string): { from: number; to: number } | null {
    const latest = this.latestHistoryRecord(taskId);
    const omitted = this.listEvents({ taskId, type: "history_omitted" }).at(-1)?.payload as EventPayloads["history_omitted"] | undefined;
    return omitted && omitted.to > (latest?.to ?? 0) ? omitted : null;
  }

  /**
   * Automatic rollover (Goal-router.md, "Task rollover"): close the chat and
   * open its continuation, linked to the old chat and its handover capsule.
   */
  rolloverChat(chatId: string, handover: HistoryRecord): Chat {
    return this.transaction(() => {
      const chat = this.requireChat(chatId);
      if (chat.closedAt) throw new StoreError("The chat is already closed.");
      const task = this.requireTask(chat.taskId);
      const event = this.appendEvent("chat_closed", { reason: "rollover", handover: handover.handle }, { goal_id: task.goalId, task_id: task.id, chat_id: chat.id });
      this.run("UPDATE chats SET closed_at = ? WHERE id = ?", event.at, chat.id);
      return this.openChat(task.id, { continuationOf: chat.id, handoverRef: handover.handle });
    });
  }

  // ── Turns ────────────────────────────────────────────────────────────────

  private nextProjectTurn(): number {
    return num(this.get("SELECT COALESCE(MAX(project_turn), 0) + 1 AS n FROM turns")?.n);
  }

  /** Bind a stored user message to one task (one part of it, for compound messages). */
  bindTurn(input: {
    userEventId: string;
    taskId: string;
    partOrder?: number | null;
    workspaceConfidence?: "high" | "low" | null;
    gateArmed?: boolean;
    route: string;
    requestEventId?: string;
    requestRange?: [number, number] | null;
    clarificationTurnId?: string | null;
    dependsOn?: number[];
  }): Turn {
    return this.transaction(() => {
      const task = this.requireTask(input.taskId);
      const chat = this.currentChat(task.id);
      const id = newId("turn");
      const projectTurn = this.nextProjectTurn();
      const gateArmed = input.gateArmed ?? false;
      const event = this.appendEvent(
        "turn_bound",
        {
          project_turn: projectTurn,
          part_order: input.partOrder ?? null,
          workspace_confidence: input.workspaceConfidence ?? null,
          first_mutation_gate_armed: gateArmed,
          route: input.route,
          user_event_id: input.userEventId,
          request_event_id: input.requestEventId ?? input.userEventId,
          request_range: input.requestRange ?? null,
          clarification_turn_id: input.clarificationTurnId ?? null,
          depends_on: input.dependsOn ?? [],
        },
        { goal_id: task.goalId, task_id: task.id, chat_id: chat.id, turn_id: id },
      );
      this.run(
        `INSERT INTO turns (id, project_turn, kind, goal_id, task_id, chat_id, part_order, user_event_id, response_event_id,
                            workspace_confidence, gate_armed, status, created_at, completed_at)
         VALUES (?, ?, 'task', ?, ?, ?, ?, ?, NULL, ?, ?, 'in_progress', ?, NULL)`,
        id,
        projectTurn,
        task.goalId,
        task.id,
        chat.id,
        input.partOrder ?? null,
        input.userEventId,
        input.workspaceConfidence ?? null,
        gateArmed ? 1 : 0,
        event.at,
      );
      return this.requireTurn(id);
    });
  }

  /**
   * Store a routing clarification as a completed exchange that belongs to no
   * task. It appears in router history so the user's answer resolves against
   * the enumerated candidates, but never in any task's chat history.
   */
  recordClarification(userEventId: string, questionText: string): Turn {
    return this.transaction(() => {
      const id = newId("turn");
      const projectTurn = this.nextProjectTurn();
      const bound = this.appendEvent("clarification_bound", { project_turn: projectTurn, user_event_id: userEventId }, { turn_id: id });
      const response = this.appendEvent("assistant_response", { text: questionText }, { turn_id: id });
      const completed = this.appendEvent("turn_completed", { project_turn: projectTurn, response_event_id: response.id }, { turn_id: id });
      this.run(
        `INSERT INTO turns (id, project_turn, kind, goal_id, task_id, chat_id, part_order, user_event_id, response_event_id,
                            workspace_confidence, gate_armed, status, created_at, completed_at)
         VALUES (?, ?, 'clarification', NULL, NULL, NULL, NULL, ?, ?, NULL, 0, 'completed', ?, ?)`,
        id,
        projectTurn,
        userEventId,
        response.id,
        bound.at,
        completed.at,
      );
      return this.requireTurn(id);
    });
  }

  getTurn(id: string): Turn | null {
    const r = this.get("SELECT * FROM turns WHERE id = ?", id);
    return r ? toTurn(r) : null;
  }

  requireTurn(id: string): Turn {
    const turn = this.getTurn(id);
    if (!turn) throw new StoreError(`Turn ${id} does not exist.`);
    return turn;
  }

  getTurnByNumber(projectTurn: number): Turn | null {
    const r = this.get("SELECT * FROM turns WHERE project_turn = ?", projectTurn);
    return r ? toTurn(r) : null;
  }

  turnsForUserEvent(userEventId: string): Turn[] {
    return this.all("SELECT * FROM turns WHERE user_event_id = ? ORDER BY project_turn", userEventId).map(toTurn);
  }

  /** Store a visible answer. Each compound part records its own, shown together in part order. */
  recordResponse(text: string, refs: EventRefs = {}): StoredEvent<"assistant_response"> {
    return this.appendEvent("assistant_response", { text }, refs);
  }

  /**
   * Finish one bound turn: link its visible response, append the task's ledger
   * revision with the agent's continuation note, record an optional goal-note
   * update, and record an optional task-completion proposal.
   */
  completeTurn(
    turnId: string,
    input: { responseEventId: string; continuationNote?: string | null; goalNote?: string | null; taskComplete?: boolean; taskCompleteReason?: string | null; stop?: TurnStop },
  ): Turn {
    return this.transaction(() => {
      const turn = this.requireInProgressTurn(turnId);
      if (this.getEvent(input.responseEventId)?.type !== "assistant_response") throw new StoreError("Expected an assistant response event.");
      this.reviseTask(turn.taskId!, {
        ...(input.continuationNote !== undefined && input.continuationNote !== null ? { continuationNote: input.continuationNote } : {}),
        ...(input.taskComplete !== undefined ? { status: input.taskComplete ? "completed" as const : "open" as const } : {}),
      });
      if (input.goalNote) this.reviseGoalNote(turn.goalId!, input.goalNote);
      const completed = this.appendEvent(
        "turn_completed",
        {
          project_turn: turn.projectTurn,
          response_event_id: input.responseEventId,
          ...(input.stop ? { stop: input.stop } : {}),
          ...(input.taskCompleteReason !== undefined ? { task_complete_reason: input.taskCompleteReason } : {}),
        },
        { goal_id: turn.goalId, task_id: turn.taskId, chat_id: turn.chatId, turn_id: turn.id },
      );
      this.run("UPDATE turns SET response_event_id = ?, status = 'completed', completed_at = ? WHERE id = ?", input.responseEventId, completed.at, turnId);
      this.indexExchange(turnId);
      return this.requireTurn(turnId);
    });
  }

  /**
   * End a bound turn that produced no final answer (agent-harness.md, "Safety
   * and long-running work"): record why, and keep the task's ledger entry
   * truthful with a mechanical continuation note.
   */
  interruptTurn(turnId: string, input: { reason: "cancelled" | "failed"; toolCalls: number; continuationNote: string }): Turn {
    return this.transaction(() => {
      const turn = this.requireInProgressTurn(turnId);
      const task = this.reviseTask(turn.taskId!, { continuationNote: input.continuationNote });
      const event = this.appendEvent(
        "turn_interrupted",
        { project_turn: turn.projectTurn, reason: input.reason, tool_calls: input.toolCalls, continuation_note: task.continuationNote ?? input.continuationNote },
        { goal_id: turn.goalId, task_id: turn.taskId, chat_id: turn.chatId, turn_id: turn.id },
      );
      this.run("UPDATE turns SET status = 'interrupted', completed_at = ? WHERE id = ?", event.at, turnId);
      return this.requireTurn(turnId);
    });
  }

  /** Record an operational warning about a turn. It never changes the ledger. */
  recordWarning(refs: EventRefs, payload: EventPayloads["agent_warning"]): void {
    this.appendEvent("agent_warning", payload, refs);
  }

  /** The interruption record of a turn, when it ended without an answer. */
  interruption(turnId: string): EventPayloads["turn_interrupted"] | null {
    const event = this.listEvents({ turnId, type: "turn_interrupted" })[0];
    return event ? (event.payload as EventPayloads["turn_interrupted"]) : null;
  }

  private requireInProgressTurn(turnId: string): Turn {
    const turn = this.requireTurn(turnId);
    if (turn.kind !== "task" || !turn.taskId || !turn.goalId) throw new StoreError("Only task turns can be completed.");
    if (turn.status !== "in_progress") throw new StoreError(`Turn ${turn.projectTurn} is already ${turn.status}.`);
    return turn;
  }

  /** The goal, task, and chat of the most recent task turn. "Current" is global across workspaces. */
  currentBinding(): CurrentBinding | null {
    const r = this.get("SELECT * FROM turns WHERE kind = 'task' ORDER BY project_turn DESC LIMIT 1");
    if (!r) return null;
    const turn = toTurn(r);
    const goal = this.requireGoal(turn.goalId!);
    const task = this.requireTask(turn.taskId!);
    return { goal, task, chat: this.currentChat(task.id) };
  }

  /**
   * Completed exchanges, newest first. Each user message appears once even
   * when a compound route bound it to several tasks.
   */
  *recentExchanges(): Generator<Exchange> {
    const batch = 50;
    let before = Number.MAX_SAFE_INTEGER;
    const seen = new Set<string>();
    while (true) {
      const rows = this.all(
        `SELECT t.*, ue.payload AS user_payload, ue.at AS user_at, re.payload AS response_payload
           FROM turns t
           JOIN events ue ON ue.id = t.user_event_id
           JOIN events re ON re.id = t.response_event_id
          WHERE t.response_event_id IS NOT NULL AND t.project_turn < ?
          ORDER BY t.project_turn DESC
          LIMIT ?`,
        before,
        batch,
      );
      if (rows.length === 0) return;
      for (const r of rows) {
        before = Math.min(before, num(r.project_turn));
        const userEventId = str(r.user_event_id);
        if (seen.has(userEventId)) continue;
        seen.add(userEventId);
        const turns = this.turnsForUserEvent(userEventId);
        // Compound parts may each have their own answer; the exchange shows them in part order.
        const responseIds = [...new Set(turns.map((t) => t.responseEventId).filter((id): id is string => id !== null))];
        const response = responseIds.length > 1
          ? responseIds.map((id) => (this.getEvent(id)!.payload as EventPayloads["assistant_response"]).text).join("\n\n")
          : (JSON.parse(str(r.response_payload)) as { text: string }).text;
        yield {
          userEventId,
          userMessage: (JSON.parse(str(r.user_payload)) as { text: string }).text,
          response,
          at: str(r.user_at),
          projectTurns: turns.map((t) => t.projectTurn),
          kind: str(r.kind) as Exchange["kind"],
          bindings: turns.filter((t) => t.kind === "task").map((t) => ({ goalId: t.goalId!, taskId: t.taskId! })),
        };
      }
    }
  }

  // ── Anchors ──────────────────────────────────────────────────────────────

  upsertAnchor(input: { goalId: string; path: string; role: string; summary: string; status?: Anchor["status"] }, refs: EventRefs = {}): Anchor {
    return this.transaction(() => {
      const existing = this.get("SELECT id FROM anchors WHERE goal_id = ? AND path = ? AND role = ?", input.goalId, input.path, input.role);
      const id = existing ? str(existing.id) : newId("anchor");
      const status = input.status ?? "provisional";
      input = { ...input, summary: truncateToTokens(input.summary, 100).text };
      const event = this.appendEvent("anchor_revised", { anchor_id: id, path: input.path, role: input.role, status, summary: input.summary }, { ...refs, goal_id: input.goalId });
      const at = event.at;
      if (existing) {
        this.run("UPDATE anchors SET summary = ?, status = ?, updated_at = ? WHERE id = ?", input.summary, status, at, id);
      } else {
        this.run(
          "INSERT INTO anchors (id, goal_id, path, role, status, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          id,
          input.goalId,
          input.path,
          input.role,
          status,
          input.summary,
          at,
          at,
        );
      }
      this.indexGoal(input.goalId);
      return { id, goalId: input.goalId, path: input.path, role: input.role, status, summary: input.summary };
    });
  }

  listAnchors(goalId: string): Anchor[] {
    return this.all("SELECT * FROM anchors WHERE goal_id = ? AND status != 'superseded' ORDER BY path", goalId).map((r) => ({
      id: str(r.id),
      goalId: str(r.goal_id),
      path: str(r.path),
      role: str(r.role),
      status: str(r.status) as Anchor["status"],
      summary: str(r.summary),
    }));
  }

  // ── Tool evidence ────────────────────────────────────────────────────────

  /**
   * Persist one tool call as the model emitted it and assign its permanent
   * task-local evidence handle (`e1`, `e2`, ...).
   */
  recordToolCall(refs: TaskRefs, input: { callId: string; tool: string; input: unknown }): Evidence {
    return this.transaction(() => {
      const row = this.get("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM evidence WHERE task_id = ?", refs.task_id);
      const number = num(row?.next);
      const event = this.appendEvent("tool_called", { call_id: input.callId, tool: input.tool, input: input.input, handle: `e${number}` }, refs);
      this.insertEvidence(event, number);
      return this.requireEvidence(refs.task_id, number);
    });
  }

  /** Persist the complete result of a recorded call, its observed file hashes, and its derived task facts. */
  recordToolResult(refs: TaskRefs, payload: EventPayloads["tool_completed"]): Evidence {
    return this.transaction(() => {
      const event = this.appendEvent("tool_completed", payload, refs);
      this.projectToolResult(event);
      return this.requireEvidence(refs.task_id, handleNumber(payload.handle));
    });
  }

  recordFileChange(refs: EventRefs, payload: EventPayloads["file_changed"]): void {
    this.appendEvent("file_changed", payload, refs);
  }

  recordTerminalStarted(refs: EventRefs, payload: EventPayloads["terminal_started"]): void {
    this.appendEvent("terminal_started", payload, refs);
  }

  /** Record a session's exit and the facts derived from it, attributed to the launching task. */
  recordTerminalExited(refs: EventRefs, payload: EventPayloads["terminal_exited"]): void {
    this.transaction(() => this.projectEvent(this.appendEvent("terminal_exited", payload, refs)));
  }

  recordApproval(refs: EventRefs, payload: EventPayloads["approval_decided"]): void {
    this.appendEvent("approval_decided", payload, refs);
  }

  /**
   * Whether the first-mutation gate (Goal-router.md, "Workspace resolution")
   * still applies to this task: some turn of the task was bound with low
   * workspace confidence, and the user has not yet confirmed a mutation.
   */
  firstMutationGatePending(taskId: string): boolean {
    if (!this.get("SELECT 1 AS x FROM turns WHERE task_id = ? AND gate_armed = 1 LIMIT 1", taskId)) return false;
    return !this.all("SELECT payload FROM events WHERE task_id = ? AND type = 'approval_decided'", taskId).some((r) => {
      const p = JSON.parse(str(r.payload)) as EventPayloads["approval_decided"];
      return p.kind === "first_mutation" && p.granted;
    });
  }

  private insertEvidence(event: StoredEvent<"tool_called">, number: number): void {
    if (!event.task_id) throw new StoreError("Tool calls must be bound to a task.");
    this.run(
      "INSERT INTO evidence (task_id, number, call_id, tool, turn_id, call_event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      event.task_id,
      number,
      event.payload.call_id,
      event.payload.tool,
      event.turn_id,
      event.id,
      event.at,
    );
  }

  private projectToolResult(event: StoredEvent<"tool_completed">): void {
    const p = event.payload;
    const taskId = event.task_id;
    if (!taskId) throw new StoreError("Tool results must be bound to a task.");
    const number = handleNumber(p.handle);
    const existing = this.get("SELECT result_event_id FROM evidence WHERE task_id = ? AND number = ?", taskId, number);
    if (!existing) throw new StoreError(`Tool result ${p.handle} has no recorded call.`);
    if (existing.result_event_id !== null) throw new StoreError(`Tool result ${p.handle} is already recorded.`);
    this.run("UPDATE evidence SET result_event_id = ?, status = ? WHERE task_id = ? AND number = ?", event.id, p.status, taskId, number);
    for (const o of p.observed) {
      this.run(
        "INSERT INTO file_observations (task_id, path, hash, event_id, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, path) DO UPDATE SET hash = excluded.hash, event_id = excluded.event_id, updated_at = excluded.updated_at",
        taskId,
        o.path,
        o.hash,
        event.id,
        event.at,
      );
    }
    for (const [index, f] of p.facts.entries()) {
      this.run("INSERT INTO task_facts (id, task_id, kind, value, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", `fact_${event.id}_${index}`, taskId, f.kind, f.value, event.id, event.at);
    }
    if (p.facts.length) this.indexTask(taskId);
  }

  private requireEvidence(taskId: string, number: number): Evidence {
    const evidence = this.getEvidence(taskId, number);
    if (!evidence) throw new StoreError(`Evidence e${number} does not exist for this task.`);
    return evidence;
  }

  /** One tool call of a task by its permanent handle number, with its result when recorded. */
  getEvidence(taskId: string, number: number): Evidence | null {
    const r = this.get("SELECT * FROM evidence WHERE task_id = ? AND number = ?", taskId, number);
    return r ? this.toEvidence(r) : null;
  }

  /** Every tool call of one turn, in call order. */
  evidenceForTurn(turnId: string): Evidence[] {
    return this.all("SELECT * FROM evidence WHERE turn_id = ? ORDER BY number", turnId).map((r) => this.toEvidence(r));
  }

  /** The number of tool calls recorded for a task, which is also its newest handle number. */
  evidenceCount(taskId: string): number {
    return num(this.get("SELECT COUNT(*) AS n FROM evidence WHERE task_id = ?", taskId)?.n);
  }

  private toEvidence(r: Row): Evidence {
    const call = this.getEvent(str(r.call_event_id)) as StoredEvent<"tool_called">;
    const result = r.result_event_id === null ? null : (this.getEvent(str(r.result_event_id)) as StoredEvent<"tool_completed">);
    return {
      taskId: str(r.task_id),
      number: num(r.number),
      handle: `e${num(r.number)}`,
      callId: str(r.call_id),
      tool: str(r.tool),
      turnId: strOrNull(r.turn_id),
      input: call.payload.input,
      status: strOrNull(r.status) as Evidence["status"],
      result: result?.payload ?? null,
      createdAt: str(r.created_at),
    };
  }

  /** The content hash this task last observed for a workspace-relative path, if any. */
  observedHash(taskId: string, path: string): { hash: string | null } | null {
    const r = this.get("SELECT hash FROM file_observations WHERE task_id = ? AND path = ?", taskId, path);
    return r ? { hash: strOrNull(r.hash) } : null;
  }

  /** Mechanically derived facts of a task, newest first. */
  taskFacts(taskId: string, limit = 200): TaskFact[] {
    return this.all("SELECT kind, value, created_at FROM task_facts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", taskId, limit).map((r) => ({
      kind: str(r.kind) as TaskFact["kind"],
      value: str(r.value),
      createdAt: str(r.created_at),
    }));
  }

  // ── Capabilities ─────────────────────────────────────────────────────────

  activateCapability(goalId: string, input: { kind: "skill" | "mcp"; name: string; version: string; digest: string }, refs: EventRefs = {}): ActiveCapability {
    return this.transaction(() => {
      const event = this.appendEvent("capability_activated", input, { ...refs, goal_id: goalId });
      this.projectEvent(event);
      return this.listActiveCapabilities(goalId).find((c) => c.name === input.name)!;
    });
  }

  deactivateCapability(goalId: string, name: string, refs: EventRefs = {}): boolean {
    return this.transaction(() => {
      const active = this.listActiveCapabilities(goalId).find((c) => c.name === name);
      if (!active) return false;
      const event = this.appendEvent("capability_deactivated", { kind: active.kind, name }, { ...refs, goal_id: goalId });
      this.projectEvent(event);
      return true;
    });
  }

  /** Whether the user approved this MCP tool for the goal; approval is asked once per tool per goal. */
  mcpToolApproved(goalId: string, name: string): boolean {
    return this.all("SELECT payload FROM events WHERE goal_id = ? AND type = 'approval_decided'", goalId).some((r) => {
      const p = JSON.parse(str(r.payload)) as EventPayloads["approval_decided"];
      return p.kind === "mcp_tool" && p.subject === name && p.granted;
    });
  }

  /** How often each Skill was activated, across all goals, for the Skill shelf. */
  skillActivationCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const r of this.all("SELECT payload FROM events WHERE type = 'capability_activated'")) {
      const p = JSON.parse(str(r.payload)) as EventPayloads["capability_activated"];
      if (p.kind === "skill") counts.set(p.name, (counts.get(p.name) ?? 0) + 1);
    }
    return counts;
  }

  /** The goal's frozen Skill shelf, or null when none has been resolved yet. */
  skillShelf(goalId: string): EventPayloads["skill_shelf_frozen"]["skills"] | null {
    const event = this.listEvents({ goalId, type: "skill_shelf_frozen" }).at(-1);
    return event ? (event.payload as EventPayloads["skill_shelf_frozen"]).skills : null;
  }

  freezeSkillShelf(goalId: string, skills: EventPayloads["skill_shelf_frozen"]["skills"]): void {
    this.appendEvent("skill_shelf_frozen", { skills }, { goal_id: goalId });
  }

  /** The latest tools/list snapshot of each MCP server. */
  mcpToolSnapshots(): Map<string, EventPayloads["mcp_tools_listed"]> {
    const latest = new Map<string, EventPayloads["mcp_tools_listed"]>();
    for (const e of this.listEvents({ type: "mcp_tools_listed" })) {
      const p = e.payload as EventPayloads["mcp_tools_listed"];
      latest.set(p.server, p);
    }
    return latest;
  }

  /** Record a server's tools/list when it differs from its latest snapshot. */
  recordMcpToolSnapshot(payload: EventPayloads["mcp_tools_listed"]): boolean {
    if (this.mcpToolSnapshots().get(payload.server)?.digest === payload.digest) return false;
    this.appendEvent("mcp_tools_listed", payload);
    return true;
  }

  listActiveCapabilities(goalId: string): ActiveCapability[] {
    return this.all("SELECT * FROM active_capabilities WHERE goal_id = ? ORDER BY name", goalId).map((r) => ({
      goalId: str(r.goal_id),
      kind: str(r.kind) as ActiveCapability["kind"],
      name: str(r.name),
      version: str(r.version),
      digest: str(r.digest),
      activatedAt: str(r.activated_at),
    }));
  }

  // ── Exchange index ───────────────────────────────────────────────────────

  private indexExchange(turnId: string): void {
    const turn = this.requireTurn(turnId);
    if (turn.kind !== "task" || !turn.responseEventId) return;
    const response = this.getEvent(turn.responseEventId)?.payload as EventPayloads["assistant_response"] | undefined;
    this.run("DELETE FROM exchange_fts WHERE turn_id = ?", turnId);
    this.run(
      "INSERT INTO exchange_fts (turn_id, task_id, goal_id, user_text, response_text) VALUES (?, ?, ?, ?, ?)",
      turnId,
      turn.taskId,
      turn.goalId,
      this.requestForTurn(turnId).request,
      response?.text ?? "",
    );
  }

  /** Rebuild the derived Q&A index from completed turns. */
  rebuildExchangeIndex(): void {
    this.run("DELETE FROM exchange_fts");
    for (const r of this.all("SELECT id FROM turns WHERE kind = 'task' AND status = 'completed' ORDER BY project_turn")) this.indexExchange(str(r.id));
  }

  /**
   * Completed Q&A pairs, filtered by task or goal and by completion time
   * (`fromIso` inclusive, `beforeIso` exclusive) before any limit applies.
   * With an FTS expression results are ranked by BM25 and then recency; with
   * `exact` they are case-insensitive literal matches after the same Unicode
   * normalization on both sides; with neither they are the newest pairs.
   */
  searchExchanges(input: {
    fts?: string;
    exact?: string;
    taskIds?: string[];
    goalIds?: string[];
    fromIso?: string;
    beforeIso?: string;
    /** Exclude exchanges still attached to history before ranking and limiting. */
    throughTurn?: number;
    limit: number;
  }): ExchangeHit[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (input.fts) (where.push("exchange_fts MATCH ?"), params.push(input.fts));
    if (input.taskIds) (where.push(`x.task_id IN (${input.taskIds.map(() => "?").join(", ") || "NULL"})`), params.push(...input.taskIds));
    if (input.goalIds) (where.push(`x.goal_id IN (${input.goalIds.map(() => "?").join(", ") || "NULL"})`), params.push(...input.goalIds));
    if (input.fromIso) (where.push("t.completed_at >= ?"), params.push(input.fromIso));
    if (input.beforeIso) (where.push("t.completed_at < ?"), params.push(input.beforeIso));
    if (input.throughTurn !== undefined) (where.push("t.project_turn <= ?"), params.push(input.throughTurn));
    const order = input.fts ? "bm25(exchange_fts, 0.0, 0.0, 0.0, 1.0, 1.0), t.completed_at DESC" : "t.completed_at DESC";
    const sql = `SELECT x.turn_id, x.task_id, x.goal_id, x.user_text, x.response_text, t.project_turn, t.completed_at
         FROM exchange_fts x JOIN turns t ON t.id = x.turn_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY ${order}, t.project_turn DESC`;
    const toHit = (r: Row): ExchangeHit => ({
      turnId: str(r.turn_id),
      projectTurn: num(r.project_turn),
      taskId: str(r.task_id),
      goalId: str(r.goal_id),
      at: str(r.completed_at),
      userMessage: str(r.user_text),
      response: str(r.response_text),
    });
    if (!input.exact) return this.all(`${sql} LIMIT ?`, ...params, input.limit).map(toHit);
    const needle = foldText(input.exact);
    const hits: ExchangeHit[] = [];
    for (const r of this.db.prepare(sql).iterate(...params) as Iterable<Row>) {
      if (!foldText(str(r.user_text)).includes(needle) && !foldText(str(r.response_text)).includes(needle)) continue;
      hits.push(toHit(r));
      if (hits.length >= input.limit) break;
    }
    return hits;
  }

  /** The newest permanent project turn number, or 0 when there are none. */
  latestProjectTurn(): number {
    return num(this.get("SELECT COALESCE(MAX(project_turn), 0) AS n FROM turns")?.n);
  }

  /** Turns bound to one task, oldest first. */
  turnsForTask(taskId: string): Turn[] {
    return this.all("SELECT * FROM turns WHERE task_id = ? ORDER BY project_turn", taskId).map(toTurn);
  }

  // ── Ledger index and queries ─────────────────────────────────────────────

  private workspaceName(goal: Goal): string {
    return goal.workspaceId ? (this.getWorkspace(goal.workspaceId)?.name ?? "") : "";
  }

  private indexGoal(goalId: string): void {
    const goal = this.requireGoal(goalId);
    const anchors = this.listAnchors(goalId)
      .map((a) => `${a.path} ${a.role} ${a.summary}`)
      .join("\n");
    this.run("DELETE FROM ledger_fts WHERE entity = 'goal' AND entity_id = ?", goalId);
    this.run(
      "INSERT INTO ledger_fts (entity, entity_id, goal_id, title, body) VALUES ('goal', ?, ?, ?, ?)",
      goalId,
      goalId,
      goal.title,
      [goal.objective ?? "", goal.note ?? "", this.workspaceName(goal), anchors].filter(Boolean).join("\n"),
    );
  }

  /** Index a task's metadata, including the mechanically derived files, commands, tests, and capabilities. */
  private indexTask(taskId: string): void {
    const task = this.requireTask(taskId);
    this.run("DELETE FROM ledger_fts WHERE entity = 'task' AND entity_id = ?", taskId);
    this.run(
      "INSERT INTO ledger_fts (entity, entity_id, goal_id, title, body) VALUES ('task', ?, ?, ?, ?)",
      taskId,
      task.goalId,
      task.title,
      [task.objective, task.completionCriteria ?? "", task.continuationNote ?? "", this.workspaceName(this.requireGoal(task.goalId)), ...this.distinctFacts(taskId)].filter(Boolean).join("\n"),
    );
  }

  /** Distinct derived fact values of a task, newest first and capped, for indexing and matching. */
  distinctFacts(taskId: string, limit = 200): string[] {
    return this.all("SELECT value FROM task_facts WHERE task_id = ? GROUP BY value ORDER BY MAX(created_at) DESC LIMIT ?", taskId, limit).map((r) => str(r.value));
  }

  /** Full-text search over goal and task metadata. `query` must already be an FTS5 expression. */
  searchLedger(ftsQuery: string, limit = 50, offset = 0): FtsHit[] {
    if (!ftsQuery.trim()) return [];
    return this.all(
      `SELECT entity, entity_id, goal_id, bm25(ledger_fts, 0.0, 0.0, 0.0, 2.0, 1.0) AS score
         FROM ledger_fts WHERE ledger_fts MATCH ? ORDER BY score, entity, entity_id LIMIT ? OFFSET ?`,
      ftsQuery,
      limit,
      offset,
    ).map((r) => ({
      entity: str(r.entity) as FtsHit["entity"],
      entityId: str(r.entity_id),
      goalId: str(r.goal_id),
      bm25: num(r.score),
    }));
  }

  /** Tasks updated at or after `sinceIso`, most recent first, with their goal and workspace. */
  tasksUpdatedSince(sinceIso: string): TaskWithGoal[] {
    return this.all("SELECT id FROM tasks WHERE updated_at >= ? ORDER BY updated_at DESC", sinceIso).map((r) =>
      this.taskWithGoal(str(r.id)),
    );
  }

  /** Every task with its goal and workspace, most recently updated first. */
  allTasks(): TaskWithGoal[] {
    return this.all("SELECT id FROM tasks ORDER BY updated_at DESC").map((r) => this.taskWithGoal(str(r.id)));
  }

  taskWithGoal(taskId: string): TaskWithGoal {
    const task = this.requireTask(taskId);
    const goal = this.requireGoal(task.goalId);
    return { task, goal, workspace: goal.workspaceId ? this.getWorkspace(goal.workspaceId) : null };
  }

  hasAnyActivity(): boolean {
    return this.get("SELECT 1 AS x FROM turns LIMIT 1") !== undefined;
  }
}

/** The number of a permanent evidence handle such as "e12". */
export function handleNumber(handle: string): number {
  const m = /^e(\d+)$/.exec(handle);
  if (!m) throw new StoreError(`Invalid evidence handle: ${handle}`);
  return Number(m[1]);
}

/** Case-insensitive comparison form that treats composed and decomposed characters alike. */
export function foldText(text: string): string {
  return text.normalize("NFC").toLowerCase();
}
