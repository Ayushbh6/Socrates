import type { Exchange, Step } from "./model";
import type { CallView } from "./types";

export type ToolStep = Extract<Step, { kind: "tool" }>;
type MetaStep = Exclude<Step, ToolStep | { kind: "step" } | { kind: "thinking" }>;

/** One thing inside a group of work: a thought, or a tool call with what it is printing now. */
export type WorkItem =
  | { kind: "thinking"; text: string; truncated: boolean; live: boolean; seq?: number; ms: number | null }
  | { kind: "tool"; step: ToolStep; output: string | null };

/**
 * The work behind an answer, in order (architecture/web.md, "Work and
 * answer"): the model's narration, and between two lines of it, one group of
 * everything it did, as Codex and Claude Code show it. Handoffs, warnings and
 * approval decisions stand on their own.
 */
export type Segment =
  | { kind: "narration"; text: string; live: boolean }
  | { kind: "group"; items: WorkItem[] }
  | { kind: "meta"; step: MetaStep };

/** The exchange's work, with what is arriving now (its thinking and narration drafts) at the end. */
export function workSegments(exchange: Exchange): Segment[] {
  const live = exchange.state === "working";
  const out: Segment[] = [];
  const add = (item: WorkItem) => {
    const last = out.at(-1);
    if (last?.kind === "group") last.items.push(item);
    else out.push({ kind: "group", items: [item] });
  };
  for (const step of exchange.steps) {
    if (step.kind === "thinking") add({ kind: "thinking", text: step.text, truncated: step.truncated, live: false, seq: step.seq, ms: step.ms });
    else if (step.kind === "step") out.push({ kind: "narration", text: step.text, live: false });
    else if (step.kind === "tool") add({ kind: "tool", step, output: live ? exchange.outputs[`${step.turnId}:${step.handle}`] ?? null : null });
    else out.push({ kind: "meta", step });
  }
  // Once the answer is being written, the thought before it is over.
  const answering = exchange.draft?.kind === "answer";
  if (live && exchange.thinking) add({ kind: "thinking", text: exchange.thinking.text, truncated: false, live: !answering, ms: null });
  if (live && exchange.draft?.kind === "narration") out.push({ kind: "narration", text: exchange.draft.text, live: true });
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * "Read 2 files", "ran 1 command": what calls of each kind did, in the order
 * the kinds first appear. A call that failed, of any kind, is never counted as
 * done: every failure is one last part, "1 tool call failed".
 */
export function callCounts(steps: (Pick<ToolStep, "call" | "status"> & { result?: ToolStep["result"] })[]): string[] {
  const calls = steps.filter((s) => !callFailed(s)).map((s) => s.call);
  const failed = steps.length - calls.length;
  const kinds: CallView["kind"][] = [];
  for (const c of calls) if (!kinds.includes(c.kind)) kinds.push(c.kind);
  const done = kinds.map((kind) => {
    const of = calls.filter((c) => c.kind === kind);
    const distinct = (list: CallView[]) => new Set(list.map((c) => c.target)).size;
    switch (kind) {
      case "read": return `Read ${plural(distinct(of), "file")}`;
      case "search": return of.length === 1 ? "Searched once" : `Searched ${of.length} times`;
      case "edit": return `Edited ${plural(distinct(of), "file")}`;
      case "terminal": {
        const commands = of.filter((c) => c.verb === "Ran" || c.verb === "Started").length;
        return commands ? `Ran ${plural(commands, "command")}` : `Worked in ${plural(distinct(of), "terminal")}`;
      }
      case "memory": return of.length === 1 ? "Looked back once" : `Looked back ${of.length} times`;
      case "capability": return `Used ${plural(of.length, "capability", "capabilities")}`;
      case "other": return `Used ${plural(of.length, "tool")}`;
    }
  });
  return failed ? [...done, `${plural(failed, "tool call")} failed`] : done;
}

/** Joins sentence parts: "Read 2 files, ran 1 command". */
const joined = (parts: string[]) => parts.map((p, i) => (i ? p[0]!.toLowerCase() + p.slice(1) : p)).join(", ");

/** A group's line: its calls by kind, or how long it thought when it only thought. */
export function groupLabel(items: WorkItem[]): string {
  const calls = items.flatMap((i) => (i.kind === "tool" ? [i.step] : []));
  if (calls.length) return joined(callCounts(calls));
  return thoughtLabel(items.reduce<number | null>((sum, i) => (i.kind === "thinking" && i.ms !== null ? (sum ?? 0) + i.ms : sum), null));
}

export function thoughtLabel(ms: number | null): string {
  return ms === null || ms < 1000 ? "Thought" : `Thought for ${duration(Math.round(ms / 1000))}`;
}

/**
 * The one line the work folds into: how long it took, whether the model
 * thought, and its tool calls by kind, e.g. "Worked for 14s · thought ·
 * read 2 files · ran 1 command".
 */
export function workSummary(segments: Segment[], exchange: Pick<Exchange, "at" | "workedAt" | "state" | "answers" | "draft">, now = Date.now()): string {
  const parts: string[] = [];
  // The clock runs until the answer starts; the work ended with its last saved step.
  const working = exchange.state === "working" && !exchange.answers.length && exchange.draft?.kind !== "answer";
  const end = working ? now : exchange.workedAt ? Date.parse(exchange.workedAt) : NaN;
  const seconds = Math.round((end - Date.parse(exchange.at)) / 1000);
  if (Number.isFinite(seconds) && seconds >= 1) parts.push(`${working ? "Working for" : "Worked for"} ${duration(seconds)}`);
  const items = segments.flatMap((s) => (s.kind === "group" ? s.items : []));
  if (items.some((i) => i.kind === "thinking")) parts.push(parts.length ? "thought" : "Thought");
  for (const label of callCounts(items.flatMap((i) => (i.kind === "tool" ? [i.step] : [])))) {
    parts.push(parts.length ? label[0]!.toLowerCase() + label.slice(1) : label);
  }
  return parts.join(" · ") || (working ? "Working" : "Worked");
}

/** Whether a call failed, or the command it ran did: every failure, of any tool, looks the same. */
export function callFailed(step: Pick<ToolStep, "status"> & { result?: ToolStep["result"] }): boolean {
  return step.status === "error" || step.result?.failed === true;
}

/** What a tool row says: "Ran", "Running", or the result's own verb ("Created"). */
export function callVerb(step: ToolStep): string {
  if (step.status === "running") return step.call.active;
  return step.result?.verb ?? step.call.verb;
}

/** "Thinking" before anything streams, "Reading your message" before routing has placed it. */
export function waitingLine(exchange: Pick<Exchange, "route" | "steps" | "state">): string {
  if (exchange.state === "sending") return "Sending";
  return exchange.route || exchange.steps.length ? "Thinking" : "Reading your message";
}

/** Whether the work shows anything arriving now: a thought, a narration, a running call, or the answer. */
export function arriving(exchange: Pick<Exchange, "thinking" | "draft" | "steps">): boolean {
  return exchange.thinking !== null || exchange.draft !== null || exchange.steps.some((s) => s.kind === "tool" && s.status === "running");
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}

/** Milliseconds as "0.4s", "12s", "2m 3s". */
export function elapsed(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : duration(Math.round(ms / 1000));
}
