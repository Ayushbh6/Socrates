import type { Exchange, Model } from "./model";
import { type OwnerTone, laneTone } from "./terminals";
import type { TerminalView } from "./types";
import { type ToolStep, callVerb } from "./work";

/**
 * The board (architecture/web.md, "Strands"): every strand of work beside the
 * main conversation, from what the page already knows. A strand is the main
 * conversation while it works, or a lane that is working, waiting, or finished
 * recently; the row is empty when main works alone, so the canvas looks as it
 * always did.
 */
export interface Strand {
  /** "main" or the lane's id. */
  conversation: string;
  /** "Main", or "Lane 2". */
  label: string;
  /** The task it works on, once routed. */
  title: string | null;
  /** The question it is working on, or worked on last. */
  message: string;
  status: "working" | "waiting" | "done" | "stopped";
  /** What it is doing now: its latest tool call in plain words, or null. */
  step: string | null;
  /** When its work started (working) or ended. */
  at: string;
  running: boolean;
  waitingForApproval: boolean;
  /** A finished lane can be closed from the row. */
  closable: boolean;
  /** Its colour, which its terminals' tabs share. */
  tone: OwnerTone;
}

/** The running terminals a strand started, oldest first: the chip's terminal count opens the first. */
export function strandTerminals(s: Pick<Strand, "conversation">, terminals: TerminalView[]): TerminalView[] {
  return terminals.filter((t) => t.status === "running" && t.owner?.by === "agent" && (s.conversation === "main" ? t.owner.strand === "main" : t.owner.lane?.id === s.conversation));
}

/** A finished lane stays on the board this long after its last activity. */
export const STRAND_RECENT_MS = 30 * 60_000;

export function strands(model: Model, now = Date.now()): Strand[] {
  const lanes = model.live?.lanes ?? [];
  const out: Strand[] = [];
  for (const lane of lanes) {
    const latest = (model.conversations[lane.id] ?? []).at(-1);
    if (!latest) continue;
    const status = lane.waitingForApproval ? "waiting" : lane.running ? "working" : stateOf(latest);
    if (status === null) continue;
    const at = latest.lastAt ?? latest.at;
    if (!lane.running && !lane.waitingForApproval && now - Date.parse(at) > STRAND_RECENT_MS) continue;
    out.push({ conversation: lane.id, label: `Lane ${lane.number}`, title: latest.route?.task.title ?? null, message: latest.message, status, step: latestStep(latest), at: status === "working" || status === "waiting" ? latest.at : at, running: lane.running, waitingForApproval: lane.waitingForApproval, closable: !lane.running && !lane.waitingForApproval, tone: laneTone(lane.number) });
  }
  const main = (model.conversations.main ?? []).findLast((e) => e.state === "working" || e.state === "sending" || e.state === "waiting") ?? (out.length ? (model.conversations.main ?? []).at(-1) : undefined);
  if (main) {
    const status = main.state === "working" || main.state === "sending" ? "working" : main.state === "waiting" ? "waiting" : stateOf(main);
    if (status && (out.length || status === "working" || status === "waiting")) {
      // Main alone, working, is not a board: the row shows only when there is something beside it.
      if (out.length) out.unshift({ conversation: "main", label: "Main", title: main.route?.task.title ?? null, message: main.message, status, step: latestStep(main), at: main.at, running: status === "working", waitingForApproval: status === "waiting", closable: false, tone: "main" });
    }
  }
  return out;
}

function stateOf(e: Exchange): Strand["status"] | null {
  if (e.state === "done") return "done";
  if (e.state === "stopped" || e.state === "failed") return "stopped";
  if (e.state === "working" || e.state === "sending") return "working";
  if (e.state === "waiting") return "waiting";
  return null;
}

/** The latest tool call of an exchange as one line ("Reading hero.css"), or null. */
function latestStep(e: Exchange): string | null {
  const step = e.steps.findLast((s): s is ToolStep => s.kind === "tool");
  if (!step) return null;
  return `${callVerb(step)} ${step.call.target}`.trim();
}
