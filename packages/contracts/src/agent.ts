/**
 * The working agent's final result (agent-harness.md, "Final result"). The
 * last model message of every run is one JSON object of this shape; the
 * harness validates it, including the token bounds of the hidden fields,
 * before anything is persisted.
 */
import { z } from "zod";

/** Hard bounds of the hidden fields, equal to the ledger's own bounds. */
export const CONTINUATION_NOTE_MAX_TOKENS = 100;
export const GOAL_NOTE_MAX_TOKENS = 150;
export const MAX_ANCHOR_PROPOSALS = 3;

export const AnchorProposal = z.strictObject({
  path: z.string().min(1).max(4096),
  role: z.string().min(1).max(60),
  reason: z.string().min(1).max(400),
});
export type AnchorProposal = z.infer<typeof AnchorProposal>;

/** `full_answer` comes first so the visible answer is written before the short hidden fields. */
export const FinalAnswer = z.strictObject({
  full_answer: z.string().trim().min(1),
  continuation_note: z.string().trim().min(1),
  goal_note: z.string().trim().min(1).nullable(),
  task_complete: z.strictObject({ reason: z.string().trim().min(1) }).nullable(),
  anchors: z.array(AnchorProposal).max(MAX_ANCHOR_PROPOSALS),
});
export type FinalAnswer = z.infer<typeof FinalAnswer>;
