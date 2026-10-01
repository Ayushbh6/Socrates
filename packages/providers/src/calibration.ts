import type { ModelUsage } from "@socrates/contracts";

/**
 * Per-model token calibration (agent-harness.md, "Token budget and trigger
 * points"): the ratio between the provider-reported prompt size and the
 * harness-standard o200k count of the same request, smoothed over requests.
 * The compaction trigger multiplies the o200k count by this ratio, so no
 * provider-specific tokenizer is needed.
 */
export class TokenCalibration {
  private readonly ratios = new Map<string, number>();

  constructor(private readonly smoothing = 0.3) {}

  /** Record one response. Ignored when either count is unavailable. */
  observe(modelId: string, harnessCount: number, usage: ModelUsage): void {
    if (harnessCount <= 0 || usage.promptTokens <= 0) return;
    const sample = usage.promptTokens / harnessCount;
    const prev = this.ratios.get(modelId);
    this.ratios.set(modelId, prev === undefined ? sample : prev + this.smoothing * (sample - prev));
  }

  /** The current ratio; 1.0 before the first observation. */
  ratio(modelId: string): number {
    return this.ratios.get(modelId) ?? 1;
  }

  /** The calibrated size of a request whose harness-standard count is known. */
  measure(modelId: string, harnessCount: number): number {
    return Math.ceil(harnessCount * this.ratio(modelId));
  }
}
