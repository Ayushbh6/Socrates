/** One display frame at 60 frames a second. */
export const FRAME_MS = 1000 / 60;
/** Text that is waiting is let out with this time constant: most of a burst shows within about half a second. */
const SETTLE_MS = 200;

/**
 * How much of the text to show after `elapsed` milliseconds. A share of what
 * is still waiting, and at least one character, so bursts flow out
 * progressively and a trickle keeps pace with the provider. The share follows
 * time, not frames, so slow frames (a busy page, a long answer to render)
 * never leave the text behind.
 */
export function nextShown(shown: number, total: number, elapsed = FRAME_MS): number {
  const waiting = total - shown;
  if (waiting <= 0) return total;
  const share = 1 - Math.exp(-Math.min(elapsed, 1_000) / SETTLE_MS);
  return Math.min(total, shown + Math.max(1, Math.ceil(waiting * share)));
}

/** The first `end` characters of the text, never splitting one character in two. */
export function cut(text: string, end: number): string {
  if (end >= text.length) return text;
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end + 1 : end);
}
