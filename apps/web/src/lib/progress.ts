import type { Exchange } from "./model";
import type { ProgressStage, ProgressStep } from "./types";

/**
 * The routing line (architecture/web.md, "Routing line"): one line that says
 * what a message is doing before its first model step, from the stages the
 * server reports as they really begin. Nothing here rotates on a timer.
 */

/** Each stage stays readable at least this long; the answer itself is never held back. */
export const STAGE_MIN_MS = 300;
/** Routing this long reads as "still finding". */
export const SLOW_ROUTING_MS = 6_000;

type Route = NonNullable<Exchange["route"]>;
type Shown = Pick<Exchange, "state" | "route" | "progress">;

const BEFORE_BINDING = new Set<ProgressStage>(["remembering", "recalling", "routing", "searching", "rechecking", "escalating"]);

const NOW: Record<ProgressStage, string> = {
  remembering: "Checking what I remember…",
  recalling: "Recalling what you’ve told me…",
  routing: "Finding the goal and task…",
  searching: "Looking through earlier tasks…",
  rechecking: "Checking the routing decision again…",
  escalating: "Taking a closer look at where this belongs…",
  waiting: "Waiting for the earlier message in this task…",
  preparing: "Preparing this task…",
  starting: "Starting work…",
};

const DONE: Record<ProgressStage, string> = {
  remembering: "Checked what I remember",
  recalling: "Recalled what you’ve told me",
  routing: "Looked for the goal and task",
  searching: "Looked through earlier tasks",
  rechecking: "Checked the routing decision again",
  escalating: "Took a closer look",
  waiting: "Waited for the earlier message",
  preparing: "Prepared this task",
  starting: "Started work",
};

const place = (route: Route, sep: string) => `${route.goal.title} ${sep} ${route.task.title}`;
/** Routed in Flow, rather than sent to a chosen chat (Standard) or a lane's task. */
const wasRouted = (trail: ProgressStep[]) => trail.some((s) => s.stage === "routing");

/** The line now, for the stage at `shown` (the newest one already on screen). */
export function progressLine(e: Shown, shown: number, now: number): string {
  if (e.state === "sending") return "Sending…";
  const step = e.progress[shown];
  // Once placed, a stage from before binding (or none, after a reload) becomes the place itself.
  if (e.route && (!step || BEFORE_BINDING.has(step.stage) || step.stage === "preparing")) {
    return wasRouted(e.progress) ? `Opening ${place(e.route, "→")}` : NOW.preparing;
  }
  if (!step) return "Reading your message…";
  if (step.stage === "routing") {
    const first = e.progress.find((s) => s.stage === "routing")!;
    if (now - Date.parse(first.at) >= SLOW_ROUTING_MS) return "Still finding the right task…";
  }
  return NOW[step.stage];
}

export interface TrailItem { label: string; offsetMs: number; done: boolean }

/** The stages up to `shown`, in past tense once passed, with time since the message. */
export function progressTrail(e: Shown & Pick<Exchange, "at">, shown: number, settled = e.state !== "working"): TrailItem[] {
  const start = Date.parse(e.at);
  const routed = wasRouted(e.progress);
  return e.progress.slice(0, shown + 1).map((s, i, list) => {
    const done = i < list.length - 1 || settled;
    const label = s.stage === "preparing" && routed && e.route ? `${done ? "Chose" : "Opening"} ${place(e.route, "/")}` : done ? DONE[s.stage] : NOW[s.stage];
    return { label, offsetMs: Math.max(0, Date.parse(s.at) - start), done };
  });
}

/** Once work shows, one quiet line for how long getting started took, or null without stages. */
export function orientedLine(e: Shown & Pick<Exchange, "at">): { label: string; ms: number } | null {
  const start = e.progress.find((s) => s.stage === "starting");
  if (!start) return null;
  const ms = Math.max(0, Date.parse(start.at) - Date.parse(e.at));
  return { label: wasRouted(e.progress) ? "Found where this belongs" : "Prepared this task", ms };
}
