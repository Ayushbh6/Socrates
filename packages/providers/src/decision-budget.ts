import type { DecisionRequest } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";

/** Perplexity V1.2 and Jev 1.14: 262,144 context tokens; use at most 60%, never a fill target. */
export const DECIDER_CONTEXT_TOKENS = 262_144;
export const DECIDER_INPUT_TOKENS = Math.floor(DECIDER_CONTEXT_TOKENS * 0.6);

/** o200k undercounted a live Perplexity long-text probe by 31%. Reserve 50%
 * extra text tokens; still an estimate, not a provider tokenizer guarantee. */
export function decisionTextTokens(text: string): number { return Math.ceil(countTokens(text) * 1.5); }

/** Conservative local estimate, not a provider tokenizer or a cost guarantee. */
export function decisionTokens(request: Pick<DecisionRequest, "state" | "questions" | "images">): number {
  const questions = Object.fromEntries(Object.entries(request.questions).map(([name, q]) => [name, { type: "noul", instructions: q.instructions, criteria: { true: q.yes, false: q.no } }]));
  return 256 + decisionTextTokens(request.state) + decisionTextTokens(JSON.stringify(questions)) + (request.images ?? []).reduce((sum, image) => sum + (
    image.width && image.height && Number.isFinite(image.width) && Number.isFinite(image.height) && image.width > 0 && image.height > 0
      ? Math.max(1_600, Math.ceil(image.width / 14) * Math.ceil(image.height / 14) + 256)
      : Math.max(1_600, Math.ceil(image.data.length / 3))
  ), 0);
}

export function decisionOverflow(request: Pick<DecisionRequest, "state" | "questions" | "images">): string | null {
  const tokens = decisionTokens(request);
  return tokens > DECIDER_INPUT_TOKENS ? `Decider input estimate ${tokens} exceeds ${DECIDER_INPUT_TOKENS}-token allowance (60%); full evidence retained` : null;
}
