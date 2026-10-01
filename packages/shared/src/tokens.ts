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

export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  return getEncoder().encode(text).length;
}

/**
 * Cut text to at most `maxTokens` tokens, keeping the beginning. Returns the
 * original string when it already fits.
 */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const enc = getEncoder();
  const tokens = enc.encode(text);
  if (tokens.length <= maxTokens) return { text, truncated: false };
  return { text: enc.decode(tokens.slice(0, Math.max(0, maxTokens))), truncated: true };
}
