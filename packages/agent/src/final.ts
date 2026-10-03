import { CONTINUATION_NOTE_MAX_TOKENS, FinalAnswer, GOAL_NOTE_MAX_TOKENS } from "@socrates/contracts";
import { countTokens, truncateToTokens } from "@socrates/shared";

export type FinalValidation = { ok: true; value: FinalAnswer } | { ok: false; errors: string[] };

/**
 * Validate the model's final message (agent-harness.md, "Final result"): one
 * JSON object matching the FinalAnswer schema, with the hidden notes inside
 * their token bounds. Errors are phrased for the single repair request.
 */
export function validateFinalAnswer(text: string): FinalValidation {
  let raw: unknown;
  try {
    raw = parseJsonObject(text);
  } catch {
    return { ok: false, errors: ["The message must be one JSON object with full_answer, continuation_note, goal_note, task_complete, and anchors; it could not be parsed as one JSON object."] };
  }
  const parsed = FinalAnswer.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(object)"}: ${i.message}`) };
  }
  const errors: string[] = [];
  const note = countTokens(parsed.data.continuation_note);
  if (note > CONTINUATION_NOTE_MAX_TOKENS) errors.push(`continuation_note is ${note} tokens; shorten it to at most ${CONTINUATION_NOTE_MAX_TOKENS}.`);
  const goal = parsed.data.goal_note === null ? 0 : countTokens(parsed.data.goal_note);
  if (goal > GOAL_NOTE_MAX_TOKENS) errors.push(`goal_note is ${goal} tokens; shorten it to at most ${GOAL_NOTE_MAX_TOKENS}.`);
  return errors.length ? { ok: false, errors } : { ok: true, value: parsed.data };
}

/**
 * The one JSON object of a final message. The object is taken whole: from
 * the message itself, from one code fence wrapping the entire message, or
 * from its first "{" to its last "}". Code fences inside full_answer are part
 * of the answer and never delimit the object.
 */
export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const wrapped = /^```(?:json)?\s*\n([\s\S]*)\n```$/i.exec(trimmed);
  const body = wrapped ? wrapped[1]! : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("No JSON object found.");
    return JSON.parse(body.slice(start, end + 1));
  }
}

/** What the user sees when the final answer stayed invalid after repair: the model's own visible text. */
export function fallbackAnswer(text: string): string {
  // A malformed object usually still carries a readable full_answer.
  const field = /"full_answer"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (field) {
    try {
      const answer = (JSON.parse(`"${field[1]}"`) as string).trim();
      if (answer) return answer;
    } catch {
      // Fall through to the raw text.
    }
  }
  const visible = text.trim();
  return visible || "I could not put together a complete answer this time. Ask me to continue and I will pick up from here.";
}

/** The mechanical continuation note written when the agent produced none. */
export function mechanicalNote(what: string, toolCalls: number): string {
  return truncateToTokens(`${what} after ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}.`, CONTINUATION_NOTE_MAX_TOKENS).text;
}
