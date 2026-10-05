import type { Exchange, Step } from "./model";

type ToolStep = Extract<Step, { kind: "tool" }>;

/**
 * The work behind an answer, in order (architecture/web.md, "Work and
 * answer"): the model's thinking, its narration, its tool calls grouped by
 * kind, and handoffs, warnings and approval decisions.
 */
export type Segment =
  | { kind: "thinking"; text: string; truncated: boolean; live: boolean; seq?: number }
  | { kind: "narration"; text: string; live: boolean }
  | { kind: "tools"; group: ToolGroup; steps: ToolStep[] }
  | { kind: "meta"; step: Exclude<Step, ToolStep | { kind: "step" } | { kind: "thinking" }> };

export type ToolGroup = "read" | "search" | "edit" | "terminal" | "memory" | "capability" | "other";

/** The kind of a tool call, from its one-line form ("read a.ts", "terminal: npm test"). */
export function toolGroup(line: string): ToolGroup {
  const tool = /^[^\s:]+/.exec(line)?.[0] ?? "";
  switch (tool) {
    case "read": return "read";
    case "glob": case "grep": return "search";
    case "edit": case "apply_patch": return "edit";
    case "terminal": case "terminal_control": return "terminal";
    case "context_retrieve": return "memory";
    case "capability_search": case "capability_control": return "capability";
    default: return "other";
  }
}

/** The exchange's work, with what is arriving now (its thinking and narration drafts) at the end. */
export function workSegments(exchange: Exchange): Segment[] {
  const live = exchange.state === "working";
  const out: Segment[] = [];
  for (const step of exchange.steps) {
    if (step.kind === "thinking") out.push({ kind: "thinking", text: step.text, truncated: step.truncated, live: false, seq: step.seq });
    else if (step.kind === "step") out.push({ kind: "narration", text: step.text, live: false });
    else if (step.kind === "tool") {
      const group = toolGroup(step.line);
      const last = out.at(-1);
      // Calls of the same kind in a row are one group.
      if (last?.kind === "tools" && last.group === group) last.steps.push(step);
      else out.push({ kind: "tools", group, steps: [step] });
    } else out.push({ kind: "meta", step });
  }
  if (live && exchange.thinking) out.push({ kind: "thinking", text: exchange.thinking.text, truncated: false, live: true });
  if (live && exchange.draft?.kind === "narration") out.push({ kind: "narration", text: exchange.draft.text, live: true });
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One group's line: "Read 2 files", "Ran 1 command". */
export function groupLabel(group: ToolGroup, steps: { line: string }[]): string {
  const n = steps.length;
  switch (group) {
    case "read": return `Read ${plural(n, "file")}`;
    case "search": return `Searched ${plural(n, "time")}`;
    case "edit": return `Edited ${plural(n, "file")}`;
    case "terminal": {
      const commands = steps.filter((s) => s.line.startsWith("terminal:")).length;
      return commands ? `Ran ${plural(commands, "command")}` : `Checked ${plural(n, "command")}`;
    }
    case "memory": return `Looked back ${plural(n, "time")}`;
    case "capability": return `Used ${plural(n, "capability", "capabilities")}`;
    case "other": return `Used ${plural(n, "tool")}`;
  }
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
  if (segments.some((s) => s.kind === "thinking")) parts.push(parts.length ? "thought" : "Thought");
  const counts = new Map<ToolGroup, { line: string }[]>();
  for (const s of segments) if (s.kind === "tools") counts.set(s.group, [...(counts.get(s.group) ?? []), ...s.steps]);
  for (const [group, steps] of counts) {
    const label = groupLabel(group, steps);
    parts.push(parts.length ? label[0]!.toLowerCase() + label.slice(1) : label);
  }
  return parts.join(" · ") || (working ? "Working" : "Worked");
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}
