import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { countTokens, truncateTailToTokens, truncateToTokens } from "@socrates/shared";
import { headTail } from "./bounds";

/**
 * Saved terminal output (agent-harness.md, "Terminal output"; plan in
 * docs/terminal-output-and-memory.md, T1). Every process run gets an output
 * id that is never reused; what it prints is appended to
 * `<dir>/<id>/output.log` as it arrives, next to `meta.json`, which says whose
 * run it is. The ledger keeps only a preview and the id, so a long build log
 * never enters the event log, and the agent reads the rest by id. Cleanup by
 * age and total size leaves the metadata, so an old id explains itself.
 */

/** Who started a run: the agent, in a goal/task/chat/turn, or the user from the terminal panel. */
export interface OutputOrigin {
  by: "agent" | "user";
  goalId: string | null;
  taskId: string | null;
  chatId: string | null;
  turnId: string | null;
  /** "g2/t3", for listings. */
  label: string | null;
}

export type CaptureGap = "cap" | "write_failed" | "interrupted";

export interface OutputMeta {
  id: string;
  /** The workspace folder whose supervisor ran it. */
  workspace: string;
  session_id: string;
  name: string | null;
  command: string;
  cwd: string;
  pty: boolean;
  background: boolean;
  origin: OutputOrigin;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  signal: string | null;
  reason: string | null;
  bytes: number;
  /** Lines saved, counting a last line without a newline. */
  lines: number;
  /** Null while running; false when something was not saved (`gap` says why). */
  complete: boolean | null;
  gap: CaptureGap | null;
  removed_at: string | null;
  removed_reason: "age" | "space" | null;
}

export interface ArchiveLimits {
  retentionDays: number;
  totalCapBytes: number;
  perOutputCapBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = { retentionDays: 15, totalCapBytes: 1024 * 1024 * 1024, perOutputCapBytes: 100 * 1024 * 1024 };

const ID = /^out_[0-9a-f]{12}$/;
/** Metadata of removed output is kept this long, so its id still explains itself. */
const TOMBSTONE_DAYS = 90;
const READ_CHUNK = 1024 * 1024;
/** A line longer than this is read in pieces. */
const LONG_LINE_CHARS = 2 * 1024 * 1024;

export function isOutputId(id: string): boolean {
  return ID.test(id);
}

/** One run's output as it is being saved. */
export class OutputCapture {
  private fd: number | null;
  private stopped = false;
  private newlines = 0;

  constructor(private readonly archive: OutputArchive, readonly meta: OutputMeta, fd: number, private readonly cap: number) {
    this.fd = fd;
  }

  get id(): string {
    return this.meta.id;
  }

  /** Append text as it arrives; past the cap (what fits is kept, cut at a character) or after a failed write, saving stops and the run goes on. */
  write(chunk: string): void {
    if (this.stopped || this.fd === null || !chunk) return;
    let text = chunk;
    let full = true;
    if (this.meta.bytes + Buffer.byteLength(text) > this.cap) {
      const bytes = Buffer.from(text);
      let cut = Math.max(0, this.cap - this.meta.bytes);
      while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
      text = bytes.subarray(0, cut).toString("utf8");
      full = false;
    }
    if (text) {
      try {
        writeSync(this.fd, text);
      } catch {
        return this.stop("write_failed");
      }
      this.meta.bytes += Buffer.byteLength(text);
      for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) this.newlines++;
      this.meta.lines = this.newlines + (text.endsWith("\n") ? 0 : 1);
    }
    if (!full) this.stop("cap");
  }

  /** The run ended: record how, and whether everything it printed was saved. */
  end(fields: { exit_code: number | null; signal: string | null; reason: string | null }): void {
    this.close();
    Object.assign(this.meta, fields, { ended_at: this.archive.now().toISOString(), complete: this.meta.gap === null });
    this.archive.saveMeta(this.meta);
  }

  private stop(gap: CaptureGap): void {
    this.stopped = true;
    this.meta.gap ??= gap;
    this.close();
    this.archive.saveMeta(this.meta);
  }

  private close(): void {
    if (this.fd === null) return;
    try { closeSync(this.fd); } catch {}
    this.fd = null;
  }
}

/** Lines of a saved output, numbered from 1. */
export interface LinePage {
  text: string;
  from_line: number;
  /** The first line not shown, or null at the end of what is saved. */
  next_line: number | null;
  lines_shown: number;
  /** Opaque cursor, including the output id and position within a long line. */
  next_cursor: string | null;
}

export interface SearchHit {
  line: number;
  text: string;
  /** The line before and the line after, when there are any. */
  before?: string;
  after?: string;
}

export class OutputArchive {
  readonly now: () => Date;

  constructor(readonly dir: string, private readonly limits: () => ArchiveLimits = () => DEFAULT_ARCHIVE_LIMITS, now: () => Date = () => new Date()) {
    this.now = now;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Start saving a run's output; null when the folder cannot be written (the run goes on without it). */
  begin(fields: Pick<OutputMeta, "workspace" | "session_id" | "name" | "command" | "cwd" | "pty" | "background" | "origin">): OutputCapture | null {
    const id = `out_${randomBytes(6).toString("hex")}`;
    const meta: OutputMeta = {
      id, ...fields, command: fields.command.slice(0, 2_000), started_at: this.now().toISOString(), ended_at: null,
      exit_code: null, signal: null, reason: null, bytes: 0, lines: 0, complete: null, gap: null, removed_at: null, removed_reason: null,
    };
    try {
      mkdirSync(this.folder(id), { mode: 0o700 });
      const fd = openSync(this.logPath(id), "a", 0o600);
      this.saveMeta(meta);
      return new OutputCapture(this, meta, fd, Math.max(1, this.limits().perOutputCapBytes));
    } catch {
      return null;
    }
  }

  meta(id: string): OutputMeta | null {
    if (!isOutputId(id)) return null;
    try {
      return JSON.parse(readFileSync(path.join(this.folder(id), "meta.json"), "utf8")) as OutputMeta;
    } catch {
      return null;
    }
  }

  saveMeta(meta: OutputMeta): void {
    const file = path.join(this.folder(meta.id), "meta.json");
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(meta), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {}
  }

  /** Whether the output's text is still on disk. */
  available(id: string): boolean {
    return isOutputId(id) && existsSync(this.logPath(id));
  }

  /** Bounded, lossless pages; the cursor resumes within an oversized line. */
  readLines(id: string, fromLine: number, maxLines: number, maxTokens: number, fromOffset = 0): LinePage {
    let text = "";
    let tokens = 0;
    let shown = 0;
    let line = 1;
    let offset = 0;
    let next: number | null = null;
    let nextOffset = 0;
    this.eachLine(id, (piece, ends) => {
      const start = offset;
      offset += piece.length;
      if (line < fromLine || (line === fromLine && offset <= fromOffset)) {
        if (ends) { line++; offset = 0; }
        return true;
      }
      if (shown >= maxLines) { next = line; nextOffset = start; return false; }
      const skip = line === fromLine ? Math.max(0, fromOffset - start) : 0;
      const remaining = piece.slice(skip);
      const room = Math.max(0, maxTokens - tokens);
      const cost = remaining.length > room * 8 ? Infinity : countTokens(remaining);
      if (cost > room) {
        const prefix = plainPrefix(remaining, room);
        text += prefix;
        if (prefix) shown++;
        next = line;
        nextOffset = start + skip + prefix.length;
        return false;
      }
      text += remaining;
      tokens += cost;
      if (ends) { shown++; line++; offset = 0; }
      return true;
    });
    return { text, from_line: fromLine, next_line: next, lines_shown: shown,
      next_cursor: next === null ? null : `${id}:l${next}:c${nextOffset}` };
  }

  /** Literal searches scan every chunk. Regex requires a whole line, capped explicitly. */
  search(id: string, query: string | RegExp, maxHits: number, maxTokens: number): { hits: SearchHit[]; more: boolean; scanned_lines: number; skipped_lines: number } {
    const literal = typeof query === "string";
    const pattern = literal ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu") : query;
    const hits: SearchHit[] = [];
    const shorten = (s: string) => s.length > 1_000 ? `${s.slice(0, 1_000)}…` : s.replace(/\n$/, "");
    let tokens = 0;
    let line = 1;
    let scanned = 0;
    let skipped = 0;
    let more = false;
    let previous = "";
    let current = "";
    let prefix = "";
    let tooLong = false;
    let excerpt: string | null = null;
    let open: SearchHit | null = null;
    const match = (text: string) => {
      pattern.lastIndex = 0;
      const found = pattern.exec(text);
      if (!found) return;
      const from = Math.max(0, found.index - 200);
      const to = Math.min(text.length, from + 1_000);
      excerpt = `${from ? "…" : ""}${text.slice(from, to).replace(/\n$/, "")}${to < text.length ? "…" : ""}`;
    };
    this.eachLine(id, (piece, ends) => {
      if (prefix.length < 1_001) prefix += piece.slice(0, 1_001 - prefix.length);
      if (literal) {
        if (excerpt === null) {
          const window = current + piece;
          match(window);
          // Keep enough overlap for a literal crossing the next chunk boundary.
          current = window.slice(-Math.max(200, (query as string).length * 2));
        }
      } else if (!tooLong) {
        if (current.length + piece.length > LONG_LINE_CHARS) { tooLong = true; current = ""; }
        else current += piece;
      }
      if (!ends) return true;
      if (!literal && !tooLong) match(current.replace(/\n$/, ""));
      if (tooLong) skipped++; else scanned++;
      if (open) { open.after = shorten(prefix); open = null; }
      if (excerpt !== null) {
        const hit: SearchHit = { line, text: excerpt, ...(previous ? { before: previous } : {}) };
        const cost = countTokens(JSON.stringify(hit)) + 40;
        if (hits.length >= maxHits || tokens + cost > maxTokens) { more = true; return false; }
        hits.push(hit); tokens += cost; open = hit;
      }
      previous = shorten(prefix);
      current = ""; prefix = ""; excerpt = null; tooLong = false; line++;
      return true;
    });
    return { hits, more, scanned_lines: scanned, skipped_lines: skipped };
  }

  /** The start and end of the saved text within `maxTokens`, reading only those ends of the file. */
  excerpt(id: string, maxTokens: number, hint = ""): { text: string; truncated: boolean } {
    const meta = this.meta(id);
    if (!meta || !this.available(id)) return { text: "", truncated: false };
    let size = 0;
    try { size = statSync(this.logPath(id)).size; } catch {}
    const window = maxTokens * 8;
    if (size <= window * 2) return headTailText(this.text(id, window * 2).text, maxTokens, hint);
    const head = this.text(id, window).text;
    const tail = this.tail(id, window);
    const half = Math.max(1, Math.floor((maxTokens - 40) / 2));
    return { text: `${cutHead(head, half)}\n[… middle of ${meta.lines} lines omitted${hint ? `; ${hint}` : ""} …]\n${cutTail(tail, half)}`, truncated: true };
  }

  /** The last `maxChars` or so of the saved text, from the first whole line. */
  private tail(id: string, maxChars: number): string {
    let fd: number;
    try { fd = openSync(this.logPath(id), "r"); } catch { return ""; }
    try {
      const size = statSync(this.logPath(id)).size;
      const length = Math.min(size, maxChars * 4);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      const cut = text.indexOf("\n");
      return (cut >= 0 && cut < text.length - 1 ? text.slice(cut + 1) : text).slice(-maxChars);
    } finally {
      closeSync(fd);
    }
  }

  /** The whole saved text, up to `maxChars` (for the page's evidence view). */
  text(id: string, maxChars: number): { text: string; truncated: boolean } {
    let text = "";
    let truncated = false;
    this.eachLine(id, (piece) => {
      if (text.length + piece.length > maxChars) { text += piece.slice(0, maxChars - text.length); truncated = true; return false; }
      text += piece;
      return true;
    });
    return { text, truncated };
  }

  /**
   * A run the app was not there to see end (it stopped or crashed while the
   * run was saving): its output may lack the end. Called once at startup,
   * before any run starts.
   */
  recoverInterrupted(): number {
    let count = 0;
    for (const meta of this.all()) {
      if (meta.ended_at || meta.removed_at) continue;
      // Counts are saved with the metadata only at the end: count what reached the file.
      let lines = 0;
      this.eachLine(meta.id, (_line, ends) => { if (ends) lines++; return true; });
      try { meta.bytes = statSync(this.logPath(meta.id)).size; } catch {}
      meta.lines = lines;
      meta.ended_at = this.now().toISOString();
      meta.complete = false;
      meta.gap ??= "interrupted";
      meta.reason ??= "interrupted";
      this.saveMeta(meta);
      count++;
    }
    return count;
  }

  /**
   * Remove finished output older than the retention period, then the oldest
   * finished output until the total is under the cap. Running output is never
   * removed. The metadata stays, as a tombstone, for TOMBSTONE_DAYS.
   */
  sweep(active: ReadonlySet<string> = new Set()): { removed: number; freed: number } {
    const limits = this.limits();
    const now = this.now().getTime();
    const metas = this.all();
    let removed = 0;
    let freed = 0;
    const remove = (meta: OutputMeta, reason: "age" | "space", size: number) => {
      try { rmSync(this.logPath(meta.id), { force: true }); } catch { return; }
      meta.removed_at = this.now().toISOString();
      meta.removed_reason = reason;
      this.saveMeta(meta);
      removed++;
      freed += size;
    };
    const live: { meta: OutputMeta; size: number }[] = [];
    for (const meta of metas) {
      if (meta.removed_at) {
        if (now - Date.parse(meta.removed_at) > TOMBSTONE_DAYS * 86_400_000) rmSync(this.folder(meta.id), { recursive: true, force: true });
        continue;
      }
      let size = 0;
      try { size = statSync(this.logPath(meta.id)).size; } catch {}
      const finished = !!meta.ended_at && !active.has(meta.id);
      if (finished && now - Date.parse(meta.ended_at!) > limits.retentionDays * 86_400_000) remove(meta, "age", size);
      else live.push({ meta, size });
    }
    let total = live.reduce((sum, o) => sum + o.size, 0);
    for (const { meta, size } of live.filter((o) => !!o.meta.ended_at && !active.has(o.meta.id)).sort((a, b) => a.meta.ended_at!.localeCompare(b.meta.ended_at!))) {
      if (total <= limits.totalCapBytes) break;
      remove(meta, "space", size);
      total -= size;
    }
    return { removed, freed };
  }

  private all(): OutputMeta[] {
    let names: string[] = [];
    try { names = readdirSync(this.dir); } catch {}
    return names.filter(isOutputId).map((id) => this.meta(id)).filter((m): m is OutputMeta => m !== null);
  }

  /**
   * Each line with its newline (the last may have none), in order, until
   * `visit` returns false. Reads in chunks, so memory stays bounded: a line
   * longer than LONG_LINE_CHARS arrives in pieces, `ends` false until its last.
   */
  private eachLine(id: string, visit: (line: string, ends: boolean) => boolean): void {
    if (!this.available(id)) return;
    let fd: number;
    try { fd = openSync(this.logPath(id), "r"); } catch { return; }
    try {
      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.alloc(READ_CHUNK);
      let carry = "";
      for (;;) {
        const n = readSync(fd, buffer, 0, READ_CHUNK, null);
        const text = carry + (n > 0 ? decoder.write(buffer.subarray(0, n)) : decoder.end());
        let start = 0;
        for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", start)) {
          if (!visit(text.slice(start, i + 1), true)) return;
          start = i + 1;
        }
        carry = text.slice(start);
        if (carry.length > LONG_LINE_CHARS) {
          // Keep a final character so EOF still closes the logical line.
          let cut = carry.length - 1;
          if (carry.charCodeAt(cut) >= 0xdc00 && carry.charCodeAt(cut) <= 0xdfff) cut--;
          if (!visit(carry.slice(0, cut), false)) return;
          carry = carry.slice(cut);
        }
        if (n <= 0) break;
      }
      if (carry) visit(carry, true);
    } finally {
      closeSync(fd);
    }
  }

  private folder(id: string): string {
    if (!isOutputId(id)) throw new Error(`Not an output id: ${id}`);
    return path.join(this.dir, id);
  }

  private logPath(id: string): string {
    return path.join(this.folder(id), "output.log");
  }
}

/** An exact prefix, with no added text and no split surrogate pairs. */
function plainPrefix(text: string, maxTokens: number): string {
  let chars = Math.min(text.length, maxTokens * 4);
  while (chars > 0) {
    if (chars < text.length && text.charCodeAt(chars) >= 0xdc00 && text.charCodeAt(chars) <= 0xdfff) chars--;
    const prefix = text.slice(0, chars);
    if (countTokens(prefix) <= maxTokens) return prefix;
    chars = Math.floor(chars * 0.8);
  }
  return "";
}

function headTailText(text: string, maxTokens: number, hint: string): { text: string; truncated: boolean } {
  const out = headTail(text, maxTokens, hint);
  return { text: out.text, truncated: out.truncated };
}

function cutHead(text: string, tokens: number): string {
  const head = truncateToTokens(text, tokens).text;
  const cut = head.lastIndexOf("\n");
  return cut > head.length / 2 ? head.slice(0, cut + 1) : head;
}

function cutTail(text: string, tokens: number): string {
  const tail = truncateTailToTokens(text, tokens).text;
  const cut = tail.indexOf("\n");
  return cut >= 0 && cut < tail.length / 2 ? tail.slice(cut + 1) : tail;
}
