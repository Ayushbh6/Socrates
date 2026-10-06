import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import type { CallRecord, CallRole, ModelMessage, ToolCall, ToolDefinition } from "@socrates/contracts";

/**
 * Every model call, kept apart from the ledger (architecture/observability.md).
 * The ledger is the append-only record of the work; this file is a log of how
 * the models were used, and may be pruned or deleted without touching it.
 *
 * A call stores its request as references: the system prompt, the tools and
 * each message are saved once by content hash, compressed, so the dozens of
 * steps of a long turn (each sending the whole conversation again) share
 * almost all of what they store.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,
  started_at        TEXT NOT NULL,
  role              TEXT NOT NULL,
  model             TEXT NOT NULL,
  served_by         TEXT,
  user_event_id     TEXT,
  turn_id           TEXT,
  lane_id           TEXT,
  goal_id           TEXT,
  task_id           TEXT,
  chat_id           TEXT,
  step              INTEGER,
  streamed          INTEGER NOT NULL,
  ok                INTEGER NOT NULL,
  error_kind        TEXT,
  error_status      INTEGER,
  error_message     TEXT,
  stop_reason       TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens  INTEGER,
  ms                INTEGER NOT NULL,
  first_token_ms    INTEGER,
  tokens_per_second REAL,
  cost_usd          REAL,
  cost_source       TEXT,
  message_count     INTEGER NOT NULL DEFAULT 0,
  request_bytes     INTEGER NOT NULL DEFAULT 0,
  request_ref       TEXT NOT NULL,
  response_ref      TEXT
);
CREATE INDEX IF NOT EXISTS calls_by_message ON calls(user_event_id, seq);
CREATE INDEX IF NOT EXISTS calls_by_turn ON calls(turn_id, seq);
CREATE INDEX IF NOT EXISTS calls_by_time ON calls(started_at);

CREATE TABLE IF NOT EXISTS blobs (
  hash    TEXT PRIMARY KEY,
  data    BLOB NOT NULL,
  bytes   INTEGER NOT NULL,
  used_at TEXT NOT NULL
);
`;

/** A call as a list shows it: everything but the request and the reply. */
export interface CallRow {
  id: string;
  startedAt: string;
  role: CallRole;
  model: string;
  servedBy: string | null;
  userEventId: string | null;
  turnId: string | null;
  laneId: string | null;
  goalId: string | null;
  taskId: string | null;
  chatId: string | null;
  step: number | null;
  streamed: boolean;
  ok: boolean;
  error: { kind: string; status: number | null; message: string } | null;
  stopReason: string | null;
  promptTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number | null;
  ms: number;
  firstTokenMs: number | null;
  tokensPerSecond: number | null;
  costUsd: number | null;
  costSource: "reported" | "price" | null;
  messageCount: number;
  /** The size of the request as stored before compression. */
  requestBytes: number;
}

/** One call whole: the request as it was sent, and the reply. */
export interface CallDetail extends CallRow {
  request: {
    system: string;
    /** Messages as they were sent; images are replaced by their type and size. */
    messages: ModelMessage[];
    tools: ToolDefinition[];
    toolChoice: string;
    maxOutputTokens: number | null;
    temperature: number | null;
    effort: string | null;
  };
  response: { text: string; toolCalls: ToolCall[]; reasoning: string | null; meta: Record<string, unknown> | null } | null;
}

export interface CallTotals {
  calls: number;
  failed: number;
  promptTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Cache reads over prompt tokens, 0 to 1; null before any prompt. */
  cacheHitRate: number | null;
  costUsd: number;
  /** How many calls had a price; the rest are not in `costUsd`. */
  priced: number;
  ms: number;
  /** The average generation speed over calls that have one. */
  tokensPerSecond: number | null;
  /** The average time to the first token over streamed calls. */
  firstTokenMs: number | null;
}

export interface CallBreakdown extends CallTotals {
  role: CallRole;
  model: string;
}

/** A user message and everything done for it. */
export interface QuestionCalls extends CallTotals {
  userEventId: string;
  startedAt: string;
}

export interface CallQuery {
  userEventId?: string;
  turnId?: string;
  role?: CallRole;
  /** Only calls started at or after this ISO time. */
  since?: string;
  /** Calls before this sequence number, newest first. */
  before?: number;
  limit?: number;
}

const COLUMNS = `seq, id, started_at, role, model, served_by, user_event_id, turn_id, lane_id, goal_id, task_id, chat_id, step, streamed, ok, error_kind, error_status, error_message, stop_reason,
  prompt_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, ms, first_token_ms, tokens_per_second, cost_usd, cost_source, message_count, request_bytes`;

const TOTALS = `COUNT(*) AS calls, COALESCE(SUM(1 - ok), 0) AS failed,
  COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(output_tokens), 0) AS output,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read, COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
  COALESCE(SUM(cost_usd), 0) AS cost, COUNT(cost_usd) AS priced, COALESCE(SUM(ms), 0) AS ms,
  AVG(tokens_per_second) AS tps, AVG(CASE WHEN streamed = 1 THEN first_token_ms END) AS first_token`;

type Row = Record<string, unknown>;

const totalsOf = (r: Row): CallTotals => {
  const prompt = Number(r.prompt);
  return {
    calls: Number(r.calls),
    failed: Number(r.failed),
    promptTokens: prompt,
    outputTokens: Number(r.output),
    cacheReadTokens: Number(r.cache_read),
    cacheWriteTokens: Number(r.cache_write),
    cacheHitRate: prompt > 0 ? Number(r.cache_read) / prompt : null,
    costUsd: Number(r.cost),
    priced: Number(r.priced),
    ms: Number(r.ms),
    tokensPerSecond: r.tps === null ? null : Math.round(Number(r.tps) * 10) / 10,
    firstTokenMs: r.first_token === null ? null : Math.round(Number(r.first_token)),
  };
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** Image bytes are not kept: a message keeps the type and size of each picture it showed. */
function withoutImages(message: ModelMessage): unknown {
  if (message.role === "assistant" || !message.images?.length) return message;
  return { ...message, images: message.images.map((i) => ({ mediaType: i.mediaType, bytes: Math.floor((i.data.length * 3) / 4) })) };
}

export class CallLog {
  private constructor(private readonly db: DatabaseSync) {}

  static open(path: string): CallLog {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    db.exec(SCHEMA);
    return new CallLog(db);
  }

  close(): void {
    this.db.close();
  }

  /** Save one finished call. */
  record(call: CallRecord): void {
    const { request, response, trace } = call;
    const stamp = call.startedAt;
    let bytes = 0;
    const put = (value: unknown): string => {
      const text = JSON.stringify(value);
      const key = hash(text);
      bytes += text.length;
      if (!Number(this.db.prepare("UPDATE blobs SET used_at = ? WHERE hash = ?").run(stamp, key).changes)) {
        const data = gzipSync(text);
        this.db.prepare("INSERT OR IGNORE INTO blobs (hash, data, bytes, used_at) VALUES (?, ?, ?, ?)").run(key, data, text.length, stamp);
      }
      return key;
    };
    this.db.exec("BEGIN");
    try {
      const requestRef = {
        system: put(request.system),
        tools: put(request.tools),
        messages: request.messages.map((m) => put(withoutImages(m))),
        toolChoice: request.toolChoice,
        maxOutputTokens: request.maxOutputTokens,
        temperature: request.temperature,
        effort: request.effort,
      };
      const responseRef = response ? put({ text: response.text, toolCalls: response.toolCalls, reasoning: response.reasoning, meta: response.meta }) : null;
      const u = response?.usage;
      this.db.prepare(`INSERT INTO calls (id, started_at, role, model, served_by, user_event_id, turn_id, lane_id, goal_id, task_id, chat_id, step, streamed, ok, error_kind, error_status, error_message, stop_reason,
          prompt_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, ms, first_token_ms, tokens_per_second, cost_usd, cost_source, message_count, request_bytes, request_ref, response_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        call.id, call.startedAt, trace.role, call.model, call.servedBy,
        trace.userEventId ?? null, trace.turnId ?? null, trace.laneId ?? null, trace.goalId ?? null, trace.taskId ?? null, trace.chatId ?? null, trace.step ?? null,
        call.streamed ? 1 : 0, call.error ? 0 : 1, call.error?.kind ?? null, call.error?.status ?? null, call.error?.message ?? null, response?.stopReason ?? null,
        u?.promptTokens ?? 0, u?.outputTokens ?? 0, u?.cacheReadTokens ?? 0, u?.cacheWriteTokens ?? 0, u?.reasoningTokens ?? null,
        call.ms, call.firstTokenMs, call.tokensPerSecond, call.cost?.usd ?? null, call.cost?.source ?? null,
        request.messages.length, bytes, JSON.stringify(requestRef), responseRef,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Calls, newest first. */
  list(query: CallQuery = {}): CallRow[] {
    const { where, args } = this.filter(query);
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM calls ${where} ORDER BY seq DESC LIMIT ?`).all(...args, Math.min(query.limit ?? 100, 1_000)) as Row[];
    return rows.map(rowOf);
  }

  /** One message's calls, in the order they were made. */
  forQuestion(userEventId: string): CallRow[] {
    return (this.db.prepare(`SELECT ${COLUMNS} FROM calls WHERE user_event_id = ? ORDER BY seq`).all(userEventId) as Row[]).map(rowOf);
  }

  get(id: string): CallDetail | null {
    const row = this.db.prepare(`SELECT ${COLUMNS}, request_ref, response_ref FROM calls WHERE id = ?`).get(id) as Row | undefined;
    if (!row) return null;
    const ref = JSON.parse(String(row.request_ref)) as { system: string; tools: string; messages: string[]; toolChoice: string; maxOutputTokens: number | null; temperature: number | null; effort: string | null };
    const blob = <T>(key: string): T => {
      const stored = this.db.prepare("SELECT data FROM blobs WHERE hash = ?").get(key) as { data: Uint8Array } | undefined;
      return stored ? JSON.parse(gunzipSync(stored.data).toString("utf8")) as T : (null as T);
    };
    return {
      ...rowOf(row),
      request: {
        system: blob<string>(ref.system) ?? "",
        messages: ref.messages.map((key) => blob<ModelMessage>(key)),
        tools: blob<ToolDefinition[]>(ref.tools) ?? [],
        toolChoice: ref.toolChoice,
        maxOutputTokens: ref.maxOutputTokens,
        temperature: ref.temperature,
        effort: ref.effort,
      },
      response: row.response_ref ? blob(String(row.response_ref)) : null,
    };
  }

  /** The numbers over one message's calls. */
  totalsFor(userEventId: string): CallTotals {
    return totalsOf(this.db.prepare(`SELECT ${TOTALS} FROM calls WHERE user_event_id = ?`).get(userEventId) as Row);
  }

  /** The numbers over all calls since a time (or ever). */
  totals(since?: string): CallTotals {
    return totalsOf(this.db.prepare(`SELECT ${TOTALS} FROM calls ${since ? "WHERE started_at >= ?" : ""}`).get(...(since ? [since] : [])) as Row);
  }

  /** The same numbers per role and model. */
  breakdown(since?: string): CallBreakdown[] {
    const rows = this.db.prepare(`SELECT role, model, ${TOTALS} FROM calls ${since ? "WHERE started_at >= ?" : ""} GROUP BY role, model ORDER BY calls DESC`).all(...(since ? [since] : [])) as Row[];
    return rows.map((r) => ({ ...totalsOf(r), role: r.role as CallRole, model: String(r.model) }));
  }

  /** User messages with calls, newest first, each with the totals of what was done for it. */
  questions(options: { limit?: number; before?: string; since?: string } = {}): QuestionCalls[] {
    const clauses = ["user_event_id IS NOT NULL", ...(options.since ? ["started_at >= ?"] : [])];
    const args = [...(options.since ? [options.since] : []), ...(options.before ? [options.before] : []), Math.min(options.limit ?? 50, 500)];
    const rows = this.db.prepare(`SELECT user_event_id, MIN(started_at) AS first_at, ${TOTALS} FROM calls WHERE ${clauses.join(" AND ")}
      GROUP BY user_event_id ${options.before ? "HAVING MIN(started_at) < ?" : ""} ORDER BY first_at DESC LIMIT ?`).all(...args) as Row[];
    return rows.map((r) => ({ ...totalsOf(r), userEventId: String(r.user_event_id), startedAt: String(r.first_at) }));
  }

  /** Forget calls started before a time, and the saved parts no remaining call has used since. Returns how many calls went. */
  prune(before: string): number {
    const removed = Number(this.db.prepare("DELETE FROM calls WHERE started_at < ?").run(before).changes);
    if (removed) this.db.prepare("DELETE FROM blobs WHERE used_at < ?").run(before);
    return removed;
  }

  /** The bytes the saved parts take, compressed. */
  storedBytes(): number {
    return Number((this.db.prepare("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM blobs").get() as Row).n);
  }

  private filter(query: CallQuery): { where: string; args: (string | number)[] } {
    const parts: string[] = [];
    const args: (string | number)[] = [];
    if (query.userEventId) { parts.push("user_event_id = ?"); args.push(query.userEventId); }
    if (query.turnId) { parts.push("turn_id = ?"); args.push(query.turnId); }
    if (query.role) { parts.push("role = ?"); args.push(query.role); }
    if (query.since) { parts.push("started_at >= ?"); args.push(query.since); }
    if (query.before !== undefined) { parts.push("seq < ?"); args.push(query.before); }
    return { where: parts.length ? `WHERE ${parts.join(" AND ")}` : "", args };
  }
}

function rowOf(r: Row): CallRow {
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    id: String(r.id),
    startedAt: String(r.started_at),
    role: r.role as CallRole,
    model: String(r.model),
    servedBy: text(r.served_by),
    userEventId: text(r.user_event_id),
    turnId: text(r.turn_id),
    laneId: text(r.lane_id),
    goalId: text(r.goal_id),
    taskId: text(r.task_id),
    chatId: text(r.chat_id),
    step: num(r.step),
    streamed: Number(r.streamed) === 1,
    ok: Number(r.ok) === 1,
    error: Number(r.ok) === 1 ? null : { kind: String(r.error_kind), status: num(r.error_status), message: String(r.error_message) },
    stopReason: text(r.stop_reason),
    promptTokens: Number(r.prompt_tokens),
    outputTokens: Number(r.output_tokens),
    cacheReadTokens: Number(r.cache_read_tokens),
    cacheWriteTokens: Number(r.cache_write_tokens),
    reasoningTokens: num(r.reasoning_tokens),
    ms: Number(r.ms),
    firstTokenMs: num(r.first_token_ms),
    tokensPerSecond: num(r.tokens_per_second),
    costUsd: num(r.cost_usd),
    costSource: r.cost_source === null ? null : (r.cost_source as "reported" | "price"),
    messageCount: Number(r.message_count),
    requestBytes: Number(r.request_bytes),
  };
}
