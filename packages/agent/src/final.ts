import { CONTINUATION_NOTE_MAX_CHARS, FinalAnswer, GOAL_NOTE_MAX_CHARS, noteLength, type NoteField } from "@socrates/contracts";

export interface NoteIssue { field: NoteField; length: number | null; limit: number; reason: string }
export type FinalValidation = { ok: true; value: FinalAnswer; noteIssues: NoteIssue[] } | { ok: false; errors: string[] };

/** Validate answer fields independently: bad notes never discard a valid answer. */
export function validateFinalAnswer(text: string): FinalValidation {
  let raw: unknown;
  try { raw = parseJsonObject(text); }
  catch { return { ok: false, errors: ["The message must be one JSON object with full_answer, continuation_note, goal_note, task_complete, and anchors."] }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["Expected a final answer object."] };
  const object = raw as Record<string, unknown>;
  const noteIssues = validateNotes(object);
  const parsed = FinalAnswer.safeParse({ ...object, continuation_note: typeof object.continuation_note === "string" && object.continuation_note.trim() ? object.continuation_note.trim() : "Continuation note unavailable.", goal_note: typeof object.goal_note === "string" && object.goal_note.trim() ? object.goal_note.trim() : null });
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 8).map(i => `${i.path.join(".") || "(object)"}: ${i.message}`) };
  return { ok: true, value: parsed.data, noteIssues };
}

export function validateNotes(raw: Record<string, unknown>, fields: NoteField[] = ["continuation_note", "goal_note"]): NoteIssue[] {
  return fields.flatMap(field => {
    const limit = field === "continuation_note" ? CONTINUATION_NOTE_MAX_CHARS : GOAL_NOTE_MAX_CHARS;
    const value = raw[field];
    if (field === "goal_note" && value === null) return [];
    const length = typeof value === "string" ? noteLength(value) : null;
    const reason = length === null ? "missing or not a string" : length === 0 ? "empty" : length > limit ? "exceeds accepted character limit" : null;
    return reason ? [{ field, length, limit, reason }] : [];
  });
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
  return `${what} after ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}.`;
}
