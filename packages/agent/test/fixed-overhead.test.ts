import { countTokens } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { ToolRunner } from "@socrates/tools";
import { describe, expect, it } from "vitest";
import { AGENT_SYSTEM_PROMPT } from "../src";

/**
 * Every request of the working agent carries the system prompt and the ten
 * tool definitions (agent-harness.md, "Prompt caching"). They were trimmed
 * from 7,415 to about 5,400 tokens on 2026-10-10; these budgets keep them
 * from growing back unnoticed. Raise one only on purpose, with the reason.
 * - system 2,100 → 2,250 (2026-10-10): memory, `<MEMORY>` and the final
 *   answer's `memory` field, about 185 tokens.
 */
const BUDGET = { system: 2_250, tools: 3_500 };

describe("the fixed part of every request", () => {
  it("stays within its token budget", () => {
    const runner = new ToolRunner({ store: LedgerStore.open({ path: ":memory:" }), approve: async () => false, timeZone: "UTC" });
    // As OpenAI-compatible providers receive them.
    const tools = runner.definitions.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    expect(countTokens(AGENT_SYSTEM_PROMPT)).toBeLessThanOrEqual(BUDGET.system);
    expect(countTokens(JSON.stringify(tools))).toBeLessThanOrEqual(BUDGET.tools);
  });

  it("sends no validation-only limits to the model", () => {
    const runner = new ToolRunner({ store: LedgerStore.open({ path: ":memory:" }), approve: async () => false, timeZone: "UTC" });
    const sent = JSON.stringify(runner.definitions.map((t) => t.inputSchema));
    expect(sent).not.toContain("minLength");
    expect(sent).not.toContain("maxLength");
  });
});
