/** Frames over which text that is waiting to be shown is let out. */
const REVEAL_FRAMES = 12;

/**
 * How much of the text to show next. A share of what is still waiting, and
 * at least one character, so text that arrives in bursts flows out evenly in
 * about a fifth of a second, and text that trickles in keeps pace with it.
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
