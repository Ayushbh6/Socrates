import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";

/**
 * The harness-standard token counter (agent-harness.md, "Token budget and
 * trigger points"): tiktoken o200k for every model. Shaping budgets use this
 * count directly; the trigger and ceiling check multiply it by a per-model
 * calibration ratio learned from provider-reported usage.
 */
let encoder: Tiktoken | undefined;

function getEncoder(): Tiktoken {
  encoder ??= new Tiktoken(o200kBase);
  return encoder;
}

/**
 * Byte-pair encoding is superlinear in the length of one unbroken run (a
 * progress bar or padding of thousands of identical characters can take
 * seconds). Runs of at least LONG_RUN non-space characters are encoded in
 * RUN_CHUNK pieces split at code-point boundaries, so the cost stays linear
 * and decoding still reproduces the text exactly. Text without such runs is
 * counted exactly. A long run is over-counted, the safe direction for every
 * budget: measured against the canonical encoder, about 1% for base64 or
 * hashes, up to about 25% for long URLs, and up to 2x for one repeated
 * character (see the token tests).
 */
const LONG_RUN = 64;
const RUN_CHUNK = 32;
const LONG_RUN_PATTERN = new RegExp(`\\S{${LONG_RUN},}`, "g");

function encode(text: string): number[] {
  const enc = getEncoder();
  if (text.length < LONG_RUN) return enc.encode(text, [], []);
  const tokens: number[] = [];
  const append = (part: string) => {
    // Spreading a large token array exceeds V8's argument limit.
    for (const token of enc.encode(part, [], [])) tokens.push(token);
  };
  let last = 0;
  for (const m of text.matchAll(LONG_RUN_PATTERN)) {
    if (m.index > last) append(text.slice(last, m.index));
    const run = m[0];
    for (let i = 0; i < run.length; ) {
      // Never split a surrogate pair: every chunk stays valid text, so decoding stays exact.
      let end = Math.min(run.length, i + RUN_CHUNK);
      if (end < run.length && /[\uD800-\uDBFF]/.test(run[end - 1]!)) end++;
      append(run.slice(i, end));
      i = end;
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) append(text.slice(last));
  return tokens;
}

export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return encode(text).length;
}

/**
 * Cut text to at most `maxTokens` tokens, keeping the beginning. Returns the
 * original string when it already fits.
 */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return { text, truncated: false };
  let out = getEncoder().decode(tokens.slice(0, Math.max(0, maxTokens)));
  // A token boundary can fall inside one UTF-8 character; drop that partial character.
  while (out && !text.startsWith(out)) out = out.slice(0, -1);
  return { text: out, truncated: true };
}

/**
 * Keep the last `maxTokens` tokens of text. Returns the original string when
 * it already fits.
 */
export function truncateTailToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return { text, truncated: false };
  let out = getEncoder().decode(tokens.slice(tokens.length - Math.max(0, maxTokens)));
  while (out && !text.endsWith(out)) out = out.slice(1);
  return { text: out, truncated: true };
}
