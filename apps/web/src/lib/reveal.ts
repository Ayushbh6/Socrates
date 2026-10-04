/** Frames over which text that is waiting to be shown is let out. */
const REVEAL_FRAMES = 12;

/**
 * How much of the text to show next. A share of what is still waiting, and
 * at least one character, so bursts flow out progressively and a trickle
 * keeps pace with the provider. Catch-up time depends on the burst's size.
 */
export function nextShown(shown: number, total: number): number {
  const waiting = total - shown;
  if (waiting <= 0) return total;
  return Math.min(total, shown + Math.max(1, Math.ceil(waiting / REVEAL_FRAMES)));
}

/** The first `end` characters of the text, never splitting one character in two. */
export function cut(text: string, end: number): string {
  if (end >= text.length) return text;
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end + 1 : end);
}
