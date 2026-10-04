import { type ModelMessage, type ToolDefinition, userText } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";

/** Shared request accounting for the worker and compactor, including framing. */
export function requestTokens(system: string, messages: ModelMessage[], tools: ToolDefinition[] = []): number {
  return countTokens(system) + countTokens(JSON.stringify(tools)) + 32 + messages.reduce((n, m) => n + messageTokens(m), 0);
}

/**
 * What one image is counted as before calibration: about what a provider
 * charges for a large image, so the context budget never underestimates it.
 */
export const IMAGE_TOKENS = 1_600;

/** Harness-standard size of one message, counting native replay content conservatively. */
export function messageTokens(m: ModelMessage): number {
  if (m.role === "user") return countTokens(userText(m.content)) + (m.images?.length ?? 0) * IMAGE_TOKENS + 16;
  if (m.role === "tool") return countTokens(m.content) + countTokens(m.toolName) + (m.images?.length ?? 0) * IMAGE_TOKENS + 16;
  const normalized = countTokens(m.content) + (m.toolCalls?.length ? countTokens(JSON.stringify(m.toolCalls)) : 0);
  // Native replay may include substantial reasoning/signature blocks absent
  // from normalized text. Count them conservatively before calibration.
  return Math.max(normalized, m.raw ? countTokens(JSON.stringify(m.raw.content)) : 0) + 16;
}
