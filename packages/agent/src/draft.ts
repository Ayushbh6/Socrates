/**
 * What the user can read of a reply that is still arriving (agent-harness.md,
 * "Streaming"). A draft is temporary: it is never saved, and the saved answer
 * or narration replaces it.
 */
export interface Draft {
  /** Which model request of the turn this draft belongs to; a retry or repair starts a new one. */
  call: number;
  /**
   * Narration is the line before tool calls; the answer is the final
   * message's `full_answer`; thinking is the model's readable reasoning (or
   * its provider's summary), kept apart from both. Output is what a running
   * tool call has printed, by its evidence `handle`.
   */
  kind: "narration" | "answer" | "thinking" | "output";
  /** Everything readable so far, not only the newest piece; for output, its newest end. */
  text: string;
  handle?: string;
}

const ANSWER_START = /\{\s*"full_answer"\s*:\s*"/;
const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };

/**
 * The readable part of the reply so far, or null while there is none. The
 * final message is one JSON object whose `full_answer` comes first, so the
 * answer is that string decoded as far as it has arrived; the rest of the
 * object is never shown. Any other text is narration.
 */
export function draftOf(text: string): { kind: "narration" | "answer"; text: string } | null {
  const start = ANSWER_START.exec(text);
  if (start) {
    const answer = decodeString(text, start.index + start[0].length);
    return answer ? { kind: "answer", text: answer } : null;
  }
  // The start of a JSON object or fence is not narration, even before full_answer begins.
  const narration = text.split(/\n\s*(?:```|\{)/, 1)[0]!.trim();
  if (!narration || narration.startsWith("{") || narration.startsWith("```")) return null;
  return { kind: "narration", text: narration };
}

/** A JSON string's contents from `from`, up to its closing quote or as far as complete escapes allow. */
function decodeString(text: string, from: number): string {
  let out = "";
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = text[i + 1];
    // An escape that has only partly arrived waits for the rest.
    if (next === undefined) return out;
    if (next !== "u") {
      out += SIMPLE_ESCAPES[next] ?? next;
      i++;
      continue;
    }
    const hex = text.slice(i + 2, i + 6);
    if (!/^[0-9a-f]{4}$/i.test(hex)) return out;
    const unit = Number.parseInt(hex, 16);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      // A surrogate pair is one character; wait for its second half.
      const low = text.slice(i + 6, i + 12);
      if (low.length < 6 && "\\u".startsWith(low.slice(0, 2)) ) return out;
      if (/^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(low)) {
        out += String.fromCharCode(unit, Number.parseInt(low.slice(2), 16));
        i += 11;
        continue;
      }
    }
    out += String.fromCharCode(unit);
    i += 5;
  }
  return out;
}

/** Turns the pieces of one model request into drafts, skipping a piece that adds nothing readable. */
export function streamDrafts(report: (draft: Draft) => void, call: number): (delta: string) => void {
  let text = "";
  let last = "";
  return (delta) => {
    text += delta;
    const draft = draftOf(text);
    if (!draft || draft.text === last) return;
    last = draft.text;
    // A page watching the draft must never be able to break the turn.
    try { report({ call, ...draft }); } catch {}
  };
}
