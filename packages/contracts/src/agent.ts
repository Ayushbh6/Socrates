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

/** Memory (agent-harness.md, "Memory"): an entry is one short sentence. */
export const MEMORY_TEXT_MAX_CHARS = 280;
export const MAX_MEMORY_SAVES = 3;
export const MAX_MEMORY_FORGETS = 10;
/** The always-on part of memory, `<MEMORY>`, holds at most this many tokens of entries. */
export const MEMORY_PROFILE_MAX_TOKENS = 500;
/** about: who the user is; preference: how they want work done; knowledge: a decision or fact for later. */
export const MEMORY_KINDS = ["about", "preference", "knowledge"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MemorySave = z.strictObject({
  text: z.string().trim().min(1).max(MEMORY_TEXT_MAX_CHARS),
  kind: z.enum(MEMORY_KINDS),
  scope: z.enum(["user", "goal"]),
});
export type MemorySave = z.infer<typeof MemorySave>;

/** What the agent asks to remember or forget this turn; the harness validates and applies it with the answer. */
export const MemoryProposal = z.strictObject({
  save: z.array(MemorySave).max(MAX_MEMORY_SAVES).default([]),
  forget: z.array(z.string().regex(/^m[1-9]\d*$/, "Use a memory handle such as m4.")).max(MAX_MEMORY_FORGETS).default([]),
});
export type MemoryProposal = z.infer<typeof MemoryProposal>;

/** `full_answer` comes first so the visible answer is written before the short hidden fields. */
export const FinalAnswer = z.strictObject({
  full_answer: z.string().trim().min(1),
  continuation_note: z.string().trim().min(1),
  goal_note: z.string().trim().min(1).nullable(),
  task_complete: z.strictObject({ reason: z.string().trim().min(1) }).nullable(),
  anchors: z.array(AnchorProposal).max(MAX_ANCHOR_PROPOSALS),
  /** Optional: most turns leave it out. */
  memory: MemoryProposal.nullable().optional(),
});
export type FinalAnswer = z.infer<typeof FinalAnswer>;

/** Bounds of a history checkpoint or handover capsule (agent-harness.md, "Checkpoint schema"). */
export const SUMMARY_MAX_TOKENS = 8_000;
export const MAX_OUTSTANDING_REQUESTS = 10;
export const OUTSTANDING_QUOTE_MAX_TOKENS = 200;
export const OUTSTANDING_TOTAL_MAX_TOKENS = 2_000;

/** One unanswered user request, quoted verbatim from the turn that made it. */
export const OutstandingRequest = z.strictObject({
  turn: z.number().int().min(1),
  quote: z.string().min(1),
});
export const KeyEvidence = z.strictObject({ ref: z.string().min(1).max(40), note: z.string().min(1) });

/**
 * The compactor's backward-looking summary of completed turns. Flat and
 * all-required except `more_outstanding_turns`, which lists the turns of
 * unanswered requests beyond the ten quoted ones.
 */
export const HistoryCheckpoint = z.strictObject({
  summary: z.string().min(1),
  turns_covered: z.strictObject({ from: z.number().int().min(1), to: z.number().int().min(1) }),
  progress: z.string(),
  decisions: z.array(z.strictObject({ decision: z.string().min(1), rationale: z.string() })),
  constraints: z.array(z.string()),
  files_touched: z.array(z.string()),
  open_threads: z.array(z.string()),
  outstanding_requests: z.array(OutstandingRequest),
  more_outstanding_turns: z.array(z.number().int().min(1)).optional(),
  next_steps: z.array(z.string()),
  key_evidence: z.array(KeyEvidence),
});
export type HistoryCheckpoint = z.infer<typeof HistoryCheckpoint>;

/** The forward-looking capsule that opens a continuation chat (Goal-router.md, "The handover capsule"). */
export const TaskHandover = z.strictObject({
  task_objective: z.string().min(1),
  completion_criteria: z.string(),
  verified_progress: z.string(),
  outstanding_requests: z.array(OutstandingRequest),
  more_outstanding_turns: z.array(z.number().int().min(1)).optional(),
  decisions: z.array(z.string()),
  constraints: z.array(z.string()),
  files_and_tests: z.array(z.string()),
  blockers: z.array(z.string()),
  next_action: z.string().min(1),
  key_evidence: z.array(KeyEvidence),
  /** Harness notice with recovery pointers when mechanical metadata is reduced. */
  omitted_details: z.string().optional(),
});
export type TaskHandover = z.infer<typeof TaskHandover>;
