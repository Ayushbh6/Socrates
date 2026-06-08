import { describe, expect, it } from "vitest"
import { evaluateTurnEfficiency, type TurnEfficiencyCall } from "../costEfficiency"

const mainCall = (overrides: Partial<TurnEfficiencyCall> = {}): TurnEfficiencyCall => ({
  sourceKind: "main_model_call",
  modelId: "deepseek/deepseek-v4-pro",
  routedProvider: "DeepSeek",
  uncachedInputTokens: 5_000,
  cachedInputTokens: 15_000,
  outputTokens: 200,
  reasoningTokens: 40,
  costUsd: 0.003,
  ...overrides,
})

describe("evaluateTurnEfficiency", () => {
  it("passes a cheap, well-cached, low-round-trip turn", () => {
    const report = evaluateTurnEfficiency([mainCall(), mainCall(), mainCall(), mainCall()])
    expect(report.passed).toBe(true)
    expect(report.flags).toEqual([])
    expect(report.cacheReadRatio).toBeGreaterThan(0.5)
    expect(report.routedProviders).toEqual(["DeepSeek"])
  })

  it("flags the expensive-route + cold-cache pattern from the benchmark", () => {
    // 23 calls, no cache reads, expensive blended rate (~$1.4/M) on GMICloud.
    const calls = Array.from({ length: 23 }, () =>
      mainCall({
        routedProvider: "GMICloud",
        uncachedInputTokens: 25_000,
        cachedInputTokens: 0,
        costUsd: 0.035,
      }),
    )
    const report = evaluateTurnEfficiency(calls, { blockedRoutedProviders: ["GMICloud"] })
    expect(report.passed).toBe(false)
    expect(report.flags).toContain("too_many_model_calls")
    expect(report.flags).toContain("low_cache_read_ratio")
    expect(report.flags).toContain("blocked_routed_provider")
    expect(report.flags).toContain("expensive_blended_rate")
  })

  it("flags missing routed provider so capture regressions are caught", () => {
    const { routedProvider: _omitted, ...withoutProvider } = mainCall()
    const report = evaluateTurnEfficiency([withoutProvider])
    expect(report.flags).toContain("missing_routed_provider")
  })

  it("ignores non-main calls (title, compaction) for round-trip counting", () => {
    const report = evaluateTurnEfficiency([
      mainCall(),
      { ...mainCall(), sourceKind: "conversation_title" },
      { ...mainCall(), sourceKind: "context_compaction" },
    ])
    expect(report.modelCallCount).toBe(1)
  })

  it("does not flag low cache ratio for short turns", () => {
    const report = evaluateTurnEfficiency([mainCall({ cachedInputTokens: 0, uncachedInputTokens: 10_000 })])
    expect(report.flags).not.toContain("low_cache_read_ratio")
  })
})
