import type { Effort, ListedModel } from "./types";

export const PROVIDER_LABELS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", openrouter: "OpenRouter", deepseek: "DeepSeek" };

export const EFFORT_LABELS: Record<Effort, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/**
 * The models matching what the user typed (every word, in the id or the
 * name), at most `limit` of them, and how many more matched.
 */
export function filterModels(models: ListedModel[], query: string, limit: number): { shown: ListedModel[]; more: number } {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = models.filter((m) => words.every((w) => `${m.id} ${m.name ?? ""}`.toLowerCase().includes(w)));
  return { shown: matching.slice(0, limit), more: Math.max(0, matching.length - limit) };
}
