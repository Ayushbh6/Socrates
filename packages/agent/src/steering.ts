import { contextTime } from "@socrates/store";
import type { PartResult } from "./socrates";

/** A message the user sent for a task while a turn of it was running (agent-harness.md, "Steering"). */
export interface Steer {
  /** The steered message's own turn, bound to the task but never run. */
  turnId: string;
  userEventId: string;
  text: string;
  at: string;
}

export type SteerOutcome = "injected" | "returned";

/**
 * The running turn's door for later messages about its task. The loop takes
 * what is pending at each step boundary; a message still pending when the
 * loop ends is returned to run as its own turn. `done` settles with the
 * running turn's result, so a folded message can end with it.
 */
export class SteerQueue {
  private pending: { steer: Steer; resolve: (outcome: SteerOutcome) => void }[] = [];
  private closed = false;
  private settle!: (result: PartResult) => void;
  readonly done: Promise<PartResult> = new Promise((resolve) => { this.settle = resolve; });
  /** The running turn's result once it finished. */
  settledResult: PartResult | null = null;

  /** Whether the loop can still take a message. */
  get open(): boolean {
    return !this.closed;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Offer a message; resolves `injected` once the loop took it, `returned` when the loop ended first or `signal` gave up. */
  offer(steer: Steer, signal?: AbortSignal): Promise<SteerOutcome> {
    if (this.closed) return Promise.resolve("returned");
    return new Promise((resolve) => {
      const entry = { steer, resolve };
      this.pending.push(entry);
      signal?.addEventListener("abort", () => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) {
          this.pending.splice(i, 1);
          resolve("returned");
        }
      }, { once: true });
    });
  }

  /** Everything pending, now part of the running turn. */
  take(): Steer[] {
    const taken = this.pending.splice(0);
    for (const t of taken) t.resolve("injected");
    return taken.map((t) => t.steer);
  }

  /** The loop ended: nothing more is taken, and what is still pending runs on its own. */
  close(): void {
    this.closed = true;
    for (const t of this.pending.splice(0)) t.resolve("returned");
  }

  /** The running turn's part finished, with this result. */
  finish(result: PartResult): void {
    this.closed = true;
    for (const t of this.pending.splice(0)) t.resolve("returned");
    this.settledResult = result;
    this.settle(result);
  }
}

/** The user message the loop appends for steers taken at a step boundary. */
export function steeringMessage(steers: Steer[], timeZone: string): string {
  const items = steers.map((s) => `- at ${contextTime(s.at, timeZone)}:\n\`\`\`text\n${s.text}\n\`\`\``).join("\n");
  return `<STEERING>\nThe user sent this while you were working on this task:\n${items}\nIt is part of this turn, not a new task: take it into account now (change course, add to the work, or answer it). The user has seen nothing you wrote in this turn so far, so your final answer must stand on its own and cover the original request and this addition together; never refer to an earlier answer of this turn.\n</STEERING>`;
}
