import { randomBytes } from "node:crypto";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import { describe, expect, it } from "vitest";
import { countTokens, truncateTailToTokens, truncateToTokens } from "../src";

describe("token counting", () => {
  it("counts literal special-token text and large ordinary output without throwing", () => {
    const special = "<|endoftext|> <|fim_prefix|>";
    expect(countTokens(special)).toBeGreaterThan(0);
    expect(truncateToTokens(special, 2).text).toBeTruthy();
    expect(countTokens("word ".repeat(150000))).toBeGreaterThan(100000);
  });
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

  it("never splits a character: truncation returns an exact prefix or suffix", () => {
    const emoji = `a${"😀".repeat(80)}`;
    for (const n of [1, 7, 30, 60]) {
      const head = truncateToTokens(emoji, n).text;
      const tail = truncateTailToTokens(emoji, n).text;
      expect(emoji.startsWith(head)).toBe(true);
      expect(emoji.endsWith(tail)).toBe(true);
      expect(head + tail).not.toContain("\uFFFD");
    }
    const mixed = `x ${"é😀汉".repeat(40)}`;
    expect(mixed.startsWith(truncateToTokens(mixed, 25).text)).toBe(true);
  });

  it("matches the canonical encoder exactly without long runs and only over-counts long runs", () => {
    const canonical = new Tiktoken(o200kBase);
    const exact = ["export const x = await load(path, { cache: true });\n".repeat(30), "Plain prose with ordinary words. ".repeat(50), "😀".repeat(300), "汉字测试数据".repeat(100)];
    for (const text of exact) expect(countTokens(text)).toBe(canonical.encode(text).length);
    const runs = [randomBytes(3000).toString("base64"), `https://example.com/${"segment/".repeat(60)}`, "=".repeat(4000), randomBytes(500).toString("hex")];
    for (const text of runs) {
      const ratio = countTokens(text) / canonical.encode(text).length;
      expect(ratio).toBeGreaterThanOrEqual(1);
      expect(ratio).toBeLessThanOrEqual(2.1);
    }
  });
});
