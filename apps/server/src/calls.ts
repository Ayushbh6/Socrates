/**
 * Tool calls and their results in plain words, for the web app
 * (architecture/server.md, "Live activity"): "Ran `npm test`", "Pressed
 * Enter in `configure`", a command's output rather than its JSON, an edit's
 * diff. The model-facing records are untouched; this is only how they read.
 */

export type CallKind = "read" | "search" | "edit" | "terminal" | "memory" | "capability" | "other";

/** One call: `${verb} ${target} ${detail}` once done, `${active} …` while it runs. */
export interface CallView {
  kind: CallKind;
  verb: string;
  active: string;
  /** The file, pattern, command or terminal, shown as code; "" when there is none. */
  target: string;
  detail: string | null;
}

/** One result: what to show when the call is opened, and a few words beside it. */
export interface ResultView {
  /** "+5 −2", "exit 1", "12 matches in 3 files", or null. */
  summary: string | null;
  /** Output, matches or file lines, cut to the preview size; or the failure. */
  preview: string;
  truncated: boolean;
  /** A unified diff, for edits. */
  diff: string | null;
  /** A verb that only the result can tell: "Created" for an edit that made the file. */
  verb: string | null;
  /** How long the call took. */
  ms: number | null;
}

const TARGET_CHARS = 200;
const TYPED_CHARS = 60;
/** A result is previewed up to this many characters; the evidence route returns the rest. */
export const OUTPUT_PREVIEW_CHARS = 2_000;

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const firstLine = (s: string) => {
  const lines = s.trim().split("\n");
  return lines.length > 1 ? `${lines[0]} …` : lines[0] ?? "";
};
const view = (kind: CallKind, verb: string, active: string, target: string, detail: string | null = null): CallView => ({ kind, verb, active, target, detail });
/** "in src"; an absolute folder by its name alone, since the whole path says little and fills the line. */
const inPath = (p: unknown) => {
  const where = str(p).replace(/[\\/]+$/, "");
  if (!where || where === ".") return null;
  return `in ${/^([A-Za-z]:)?[\\/]/.test(where) ? where.split(/[\\/]/).pop() || where : where}`;
};

const KEY_NAMES: Record<string, string> = {
  ENTER: "Enter", TAB: "Tab", ESCAPE: "Escape", BACKSPACE: "Backspace", DELETE: "Delete", UP: "Up", DOWN: "Down", LEFT: "Left", RIGHT: "Right",
  HOME: "Home", END: "End", PAGE_UP: "Page Up", PAGE_DOWN: "Page Down", CTRL_C: "Ctrl-C", CTRL_D: "Ctrl-D", CTRL_L: "Ctrl-L", CTRL_Z: "Ctrl-Z",
};
/** Keys pressed in a row, counted: "Down ×3, Enter". */
function keyList(keys: string[]): string {
  const runs: { key: string; n: number }[] = [];
  for (const k of keys) {
    const last = runs.at(-1);
    if (last?.key === k) last.n++;
    else runs.push({ key: k, n: 1 });
  }
  return runs.map((r) => `${KEY_NAMES[r.key] ?? r.key}${r.n > 1 ? ` ×${r.n}` : ""}`).join(", ");
}

const WAIT_FOR: Record<string, string> = { exit: "to finish", ready: "to be ready", output: "to print more", input_required: "to ask for input", idle: "to go quiet" };

export function describeCall(tool: string, input: unknown): CallView {
  const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  switch (tool) {
    case "read": {
      const from = typeof i.offset === "number" ? i.offset : null;
      return view("read", "Read", "Reading", str(i.path), from && from > 1 ? `from line ${from}` : null);
    }
    case "glob":
      return view("search", "Listed files matching", "Listing files matching", str(i.pattern), inPath(i.path));
    case "grep":
      return view("search", "Searched for", "Searching for", cut(str(i.pattern), TARGET_CHARS), [inPath(i.path), str(i.glob) ? `in ${str(i.glob)}` : null, str(i.type) ? `in ${str(i.type)} files` : null].filter(Boolean).join(" ") || null);
    case "edit": {
      const edits = Array.isArray(i.edits) ? i.edits.length : 1;
      return view("edit", "Edited", "Editing", str(i.path), edits > 1 ? `${edits} changes` : null);
    }
    case "apply_patch": {
      const ops = [...str(i.patch).matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)];
      const files = ops.map((m) => m[2]!.trim());
      const only = ops.length === 1 ? ops[0]![1] : null;
      const verb = only === "Add" ? ["Created", "Creating"] : only === "Delete" ? ["Deleted", "Deleting"] : ["Edited", "Editing"];
      return view("edit", verb[0]!, verb[1]!, files[0] ?? "", files.length > 1 ? `and ${files.length - 1} more file${files.length === 2 ? "" : "s"}` : null);
    }
    case "terminal": {
      const where = [i.background ? (str(i.name) ? `in the background as ${str(i.name)}` : "in the background") : str(i.name) ? `as ${str(i.name)}` : null, inPath(i.cwd)].filter(Boolean).join(" ");
      return view("terminal", i.background ? "Started" : "Ran", i.background ? "Starting" : "Running", cut(firstLine(str(i.command)), TARGET_CHARS), where || null);
    }
    case "terminal_control": {
      const t = str(i.terminal) || (Array.isArray(i.terminals) ? i.terminals.map(String).join(", ") : "");
      switch (i.action) {
        case "write": {
          const keys = Array.isArray(i.keys) ? keyList(i.keys.map(String)) : "";
          const typed = str(i.input);
          if (typed) return view("terminal", "Typed", "Typing", cut(typed.replace(/\n/g, "⏎"), TYPED_CHARS), [`in ${t}`, i.submit !== false ? "and pressed Enter" : null, keys ? `then ${keys}` : null].filter(Boolean).join(" "));
          return view("terminal", "Pressed", "Pressing", keys, `in ${t}`);
        }
        case "wait":
          return view("terminal", "Waited for", "Waiting for", t, i.event === "pattern" ? `to print ${JSON.stringify(str(i.pattern))}` : i.event === "port_open" ? `to open port ${String(i.port)}` : i.event === "port_closed" ? `to close port ${String(i.port)}` : WAIT_FOR[str(i.event)] ?? null);
        case "screen":
          return view("terminal", "Looked at the screen of", "Looking at the screen of", t);
        case "read":
          return view("terminal", "Read the output of", "Reading the output of", t, str(i.filter) ? `lines matching ${JSON.stringify(str(i.filter))}` : null);
        case "list":
          return view("terminal", "Listed the terminals", "Listing the terminals", "");
        case "signal":
          return view("terminal", `Sent ${str(i.signal)} to`, `Sending ${str(i.signal)} to`, t);
        case "terminate":
          return view("terminal", "Stopped", "Stopping", t);
        case "restart":
          return view("terminal", "Restarted", "Restarting", t);
        case "resize":
          return view("terminal", "Resized", "Resizing", t, `to ${String(i.cols)}×${String(i.rows)}`);
        default:
          return view("terminal", "Used", "Using", t);
      }
    }
    case "context_retrieve": {
      const q = str(i.query) || str(i.ref) || str(i.target);
      return view("memory", i.action === "inspect" ? "Looked back at" : "Looked back for", i.action === "inspect" ? "Looking back at" : "Looking back for", cut(q, TARGET_CHARS));
    }
    case "capability_search":
      return view("capability", "Looked for a capability for", "Looking for a capability for", cut(str(i.query), TARGET_CHARS));
    case "capability_control":
      if (i.action === "list") return view("capability", "Listed the active capabilities", "Listing the active capabilities", "");
      return view("capability", i.action === "deactivate" ? "Turned off" : "Turned on", i.action === "deactivate" ? "Turning off" : "Turning on", str(i.name) || str(i.ref));
    default: {
      // An MCP tool or one this list does not know: its name, and the first short text it was given.
      const hint = Object.values(i).find((v): v is string => typeof v === "string" && v.length > 0);
      return view("other", "Used", "Using", tool, hint ? cut(firstLine(hint), TYPED_CHARS) : null);
    }
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The end of a text, where a command's outcome is, from a line start when one is near. */
function tail(text: string, max = OUTPUT_PREVIEW_CHARS): { preview: string; truncated: boolean } {
  if (text.length <= max) return { preview: text, truncated: false };
  const end = text.slice(-max);
  const nl = end.indexOf("\n");
  return { preview: nl >= 0 && nl < 200 ? end.slice(nl + 1) : end, truncated: true };
}
function head(text: string, max = OUTPUT_PREVIEW_CHARS): { preview: string; truncated: boolean } {
  return { preview: text.slice(0, max), truncated: text.length > max };
}

/** "+5 −2" for a unified diff. */
export function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

function exitSummary(r: Record<string, unknown>): string | null {
  if (typeof r.exit_code === "number") return `exit ${r.exit_code}`;
  if (str(r.signal)) return `stopped by ${str(r.signal)}`;
  if (r.status === "timed_out") return "timed out";
  return null;
}

export function describeResult(
  tool: string,
  p: { status: "ok" | "error"; content: string; result: unknown; error: { message: string; correction: string } | null; wall_time_ms?: number },
): ResultView {
  const ms = typeof p.wall_time_ms === "number" ? p.wall_time_ms : null;
  const base: ResultView = { summary: null, preview: "", truncated: false, diff: null, verb: null, ms };
  if (p.status === "error") {
    const message = p.error ? `${p.error.message}${p.error.correction ? `\n${p.error.correction}` : ""}` : p.content;
    return { ...base, summary: "failed", ...head(message) };
  }
  const r = (typeof p.result === "object" && p.result !== null ? p.result : {}) as Record<string, unknown>;
  switch (tool) {
    case "read": {
      if (r.image && typeof r.image === "object") {
        const img = r.image as { width?: number; height?: number };
        return { ...base, summary: `image ${img.width}×${img.height}`, preview: p.content };
      }
      const total = typeof r.total_lines === "number" ? r.total_lines : null;
      const lines = Array.isArray(r.lines) ? r.lines.length : 0;
      return { ...base, summary: total === null ? null : lines < total ? `${lines} of ${plural(total, "line")}` : plural(total, "line"), ...head(p.content) };
    }
    case "glob": {
      const found = Array.isArray(r.matches) ? r.matches.map(String) : [];
      return { ...base, summary: `${found.length}${r.truncated ? "+" : ""} ${found.length === 1 && !r.truncated ? "file" : "files"}`, ...head(found.join("\n")) };
    }
    case "grep": {
      if (Array.isArray(r.matches)) {
        const matches = r.matches as { path?: string; line_number?: number; text?: string }[];
        const files = new Set(matches.map((m) => m.path)).size;
        const more = r.truncated ? "+" : "";
        return { ...base, summary: matches.length ? `${matches.length}${more} ${matches.length === 1 && !more ? "match" : "matches"} in ${plural(files, "file")}` : "no matches", ...head(matches.map((m) => `${m.path}:${m.line_number}: ${m.text ?? ""}`).join("\n")) };
      }
      if (Array.isArray(r.files)) return { ...base, summary: r.files.length ? `${r.files.length}${r.truncated ? "+" : ""} ${r.files.length === 1 ? "file" : "files"}` : "no matches", ...head(r.files.map(String).join("\n")) };
      if (Array.isArray(r.counts)) {
        const counts = r.counts as { path: string; count: number }[];
        return { ...base, summary: counts.length ? plural(counts.reduce((a, c) => a + c.count, 0), "match", "matches") : "no matches", ...head(counts.map((c) => `${c.path}: ${c.count}`).join("\n")) };
      }
      return { ...base, ...head(p.content) };
    }
    case "edit":
    case "apply_patch": {
      const diff = str(r.diff);
      const { added, removed } = diffCounts(diff);
      return { ...base, summary: diff ? `+${added} −${removed}` : r.changed === false ? "no change" : null, preview: "", diff: diff || null, truncated: r.diff_truncated === true, verb: r.created === true ? "Created" : null };
    }
    case "terminal":
    case "terminal_control": {
      if (r.action === "list" && Array.isArray(r.terminals)) {
        const rows = r.terminals as { terminal?: string; status?: string; command?: string }[];
        return { ...base, summary: plural(rows.length, "terminal"), ...head(rows.map((t) => `${t.terminal ?? ""} · ${t.status ?? ""} · ${t.command ?? ""}`).join("\n")) };
      }
      // A program that redraws is best shown as its screen; a stream of redraws is not.
      const screen = typeof r.screen === "object" && r.screen !== null ? str((r.screen as { text?: unknown }).text) : "";
      const output = screen || str(r.output);
      const summary = r.event === "timeout" ? "timed out" : typeof r.event === "string" && r.action === "wait" && r.event !== "exit" ? String(r.event).replace(/_/g, " ") : r.status === "running" && r.action === undefined ? (r.ready === true ? "running, ready" : "still running") : exitSummary(r) ?? (r.input_required === true ? "waiting for input" : null);
      return { ...base, summary, ...tail(output) };
    }
    default:
      return { ...base, ...head(p.content) };
  }
}
