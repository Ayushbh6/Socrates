import { SUMMARY_MAX_TOKENS } from "@socrates/contracts";

/**
 * The one universal context budget (agent-harness.md, "Token budget and
 * trigger points"). Every value is an absolute token count; production uses
 * the defaults, and tests and evaluations shrink them to exercise compaction
 * cheaply.
 */
export interface ContextBudgets {
  /** Compaction runs before a request at or above this calibrated size. */
  trigger: number;
  /** Compaction continues until the request is at or below this size. */
  target: number;
  /** No request is ever sent at or above this size. */
  ceiling: number;
  /** Newest completed turns kept exactly as attached when a checkpoint is written. */
  verbatimWindow: number;
  /** Newest tool calls of the current turn kept intact when it is linearized. */
  intactWindow: number;
  /** Turn N−1 is fitted to this size. */
  previousTurn: number;
  /** A checkpoint or handover capsule as rendered in the prompt. */
  summaryMax: number;
  /** `<RETRIEVED_HISTORY>` in total. */
  retrievedMax: number;
  /** `<PROJECT_CONTEXT>` in total. */
  projectContextMax: number;
  /** A chat holds at most this many compactions; the next trigger rolls it over. */
  maxCompactionsPerChat: number;
}

export const DEFAULT_BUDGETS: ContextBudgets = {
  trigger: 160_000,
  target: 80_000,
  ceiling: 180_000,
  verbatimWindow: 30_000,
  intactWindow: 30_000,
  previousTurn: 20_000,
  summaryMax: SUMMARY_MAX_TOKENS,
  retrievedMax: 8_000,
  projectContextMax: 3_000,
  maxCompactionsPerChat: 5,
};
