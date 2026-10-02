import { describe, expect, it } from "vitest";
import { countTokens, truncateTailToTokens, truncateToTokens } from "../src";

describe("token counting", () => {
  it("counts ordinary text exactly and truncates at token boundaries from either end", () => {
    const code = "export function f(x) { return x + 1; }\n".repeat(50);
    expect(countTokens(code)).toBe(650);
    const head = truncateToTokens(code, 13);
    expect(head).toEqual({ text: "export function f(x) { return x + 1; }\n", truncated: true });
    expect(code.endsWith(truncateTailToTokens(code, 13).text)).toBe(true);
    expect(truncateToTokens("short", 10)).toEqual({ text: "short", truncated: false });
  });

  it("stays fast and lossless on very long unbroken runs", () => {
    const run = `start ${"=".repeat(200_000)} end`;
    const started = Date.now();
    const n = countTokens(run);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(n).toBeGreaterThan(200_000 / 32);
    const cut = truncateToTokens(run, 100);
    expect(run.startsWith(cut.text)).toBe(true);
  });
});
