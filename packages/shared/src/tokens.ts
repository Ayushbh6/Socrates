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
 * seconds). Runs longer than LONG_RUN characters are encoded in RUN_CHUNK
 * pieces: the count stays within a few tokens of exact, decoding still
 * reproduces the text exactly, and the cost stays linear.
 */
const LONG_RUN = 64;
const RUN_CHUNK = 32;
const LONG_RUN_PATTERN = new RegExp(`\\S{${LONG_RUN},}`, "g");

function encode(text: string): number[] {
  const enc = getEncoder();
  if (text.length < LONG_RUN) return enc.encode(text);
  const tokens: number[] = [];
  let last = 0;
  for (const m of text.matchAll(LONG_RUN_PATTERN)) {
    if (m.index > last) tokens.push(...enc.encode(text.slice(last, m.index)));
    for (let i = 0; i < m[0].length; i += RUN_CHUNK) tokens.push(...enc.encode(m[0].slice(i, i + RUN_CHUNK)));
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push(...enc.encode(text.slice(last)));
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
  return { text: getEncoder().decode(tokens.slice(0, Math.max(0, maxTokens))), truncated: true };
}

/**
 * Keep the last `maxTokens` tokens of text. Returns the original string when
 * it already fits.
 */
export function truncateTailToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return { text, truncated: false };
  return { text: getEncoder().decode(tokens.slice(tokens.length - Math.max(0, maxTokens))), truncated: true };
}
