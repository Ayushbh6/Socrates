import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { countTokens } from "@socrates/shared";
import { describe, expect, it } from "vitest";
import { RESULT_CEILING_TOKENS } from "../src";
import { harness } from "./helpers";

const TOOL_ORDER = ["read", "glob", "grep", "edit", "apply_patch", "terminal", "terminal_control", "context_retrieve", "capability_search", "capability_control"];

/** One invalid call per tool. Each must fail with the corrective shape and change nothing. */
const INVALID: [string, unknown][] = [
  ["read", { path: "a.txt", offset: 0 }],
  ["glob", { pattern: "" }],
  ["grep", { pattern: "x", case_sensitive: "yes" }],
  ["edit", { path: "a.txt", old_text: "", new_text: "changed" }],
  ["apply_patch", { patch: 42 }],
  ["terminal", { command: "touch created-by-invalid-call", yield_ms: 10 }],
  ["terminal_control", { action: "explode", terminal: "x" }],
  ["context_retrieve", { action: "inspect", ref: "" }],
  ["capability_search", { query: "pdf", limit: 0 }],
  ["capability_control", { action: "activate" }],
];

function expectCorrective(json: any) {
  expect(Object.keys(json)).toEqual(["error"]);
  expect(Object.keys(json.error).sort()).toEqual(["code", "correction", "message", "retryable"]);
  expect(typeof json.error.code).toBe("string");
  expect(json.error.message.length).toBeGreaterThan(0);
  expect(json.error.correction.length).toBeGreaterThan(0);
  expect(typeof json.error.retryable).toBe("boolean");
}

describe("tool contract", () => {
  it("exposes exactly the ten permanent tools in their fixed order with plain object schemas", () => {
    const h = harness();
    expect(h.runner.definitions.map((d) => d.name)).toEqual(TOOL_ORDER);
    for (const d of h.runner.definitions) {
      expect(d.inputSchema.type).toBe("object");
      expect(JSON.stringify(d.inputSchema)).not.toMatch(/"(anyOf|oneOf|\$schema)"|"additionalProperties":false/);
      expect(d.description.length).toBeGreaterThan(80);
    }
    const control = h.runner.definitions.find((d) => d.name === "terminal_control")!.inputSchema as any;
    expect(control.required).toEqual(["action"]);
    expect(control.properties.action.enum).toEqual(["list", "read", "wait", "write", "signal", "terminate", "restart"]);
  });

  it.each(INVALID)("%s rejects invalid input with a corrective error and no side effects", async (name, input) => {
    const h = harness({ files: { "a.txt": "original\n" } });
    const before = h.store.listEvents().length;
    const r = await h.call(name, input);
    expect(r.isError).toBe(true);
    expectCorrective(r.json);
    expect(r.json.error.code).toBe("invalid_parameters");
    expect(r.json.error.retryable).toBe(true);
    expect(readFileSync(path.join(h.root, "a.txt"), "utf8")).toBe("original\n");
    expect(existsSync(path.join(h.root, "created-by-invalid-call"))).toBe(false);
    // Only the call and its failed result are recorded.
    expect(h.store.listEvents().slice(before).map((e) => e.type)).toEqual(["tool_called", "tool_completed"]);
  });

  it("rejects unknown fields instead of ignoring them", async () => {
    const h = harness({ files: { "a.txt": "x\n" } });
    const r = await h.call("read", { path: "a.txt", lines: 10 });
    expect(r.json.error.code).toBe("invalid_parameters");
    expect(r.json.error.message).toContain("lines");
  });

  it("accepts arguments delivered as a JSON string", async () => {
    const h = harness({ files: { "a.txt": "hello\n" } });
    const r = await h.call("read", JSON.stringify({ path: "a.txt" }));
    expect(r.isError).toBe(false);
    expect(r.content).toContain("1: hello");
  });

  it("answers an unknown tool with the valid tool names", async () => {
    const h = harness();
    const r = await h.call("write_file", { path: "x" });
    expectCorrective(r.json);
    expect(r.json.error.code).toBe("unknown_tool");
    expect(r.json.error.correction).toContain("apply_patch");
  });

  it.each(["read", "glob", "grep", "edit", "apply_patch", "terminal", "terminal_control"])("%s fails with no_workspace when the work has none", async (name) => {
    const h = harness();
    const inputs: Record<string, unknown> = {
      read: { path: "a" },
      glob: { pattern: "*" },
      grep: { pattern: "x" },
      edit: { path: "a", old_text: "a", new_text: "b" },
      apply_patch: { patch: "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch" },
      terminal: { command: "true" },
      terminal_control: { action: "list" },
    };
    const r = await h.call(name, inputs[name], { workspace: null });
    expectCorrective(r.json);
    expect(r.json.error.code).toBe("no_workspace");
    expect(r.json.error.retryable).toBe(false);
  });

  it("keeps infrastructure failures distinct, safe, and fully logged internally", async () => {
    const h = harness();
    // A ledger row that violates the store's own invariant triggers an unexpected exception inside the handler.
    h.store.db.exec("DROP TABLE exchange_fts");
    const r = await h.call("context_retrieve", { action: "search", query: "server" });
    expectCorrective(r.json);
    expect(r.json.error.code).toBe("internal_error");
    expect(r.content).not.toMatch(/at \w+ \(|exchange_fts|SQLITE/);
    const stored = h.store.listEvents({ type: "tool_completed" }).at(-1)!.payload as { diagnostics: string };
    expect(stored.diagnostics).toContain("exchange_fts");
  });

  it("assigns permanent task-local evidence handles in call order", async () => {
    const h = harness({ files: { "a.txt": "x\n" } });
    const first = await h.call("read", { path: "a.txt" });
    const second = await h.call("read", { path: "missing.txt" });
    h.nextTurn();
    const third = await h.call("glob", { pattern: "*.txt" });
    expect([first.handle, second.handle, third.handle]).toEqual(["e1", "e2", "e3"]);
  });

  it("never lets one result exceed the ceiling", async () => {
    const h = harness({ files: { "big.txt": `${"word ".repeat(400)}\n`.repeat(400) } });
    const r = await h.call("read", { path: "big.txt" });
    expect(countTokens(r.content)).toBeLessThanOrEqual(RESULT_CEILING_TOKENS);
    const t = await h.call("terminal", { command: "yes 'line of output' | head -n 200000" });
    expect(countTokens(t.content)).toBeLessThanOrEqual(RESULT_CEILING_TOKENS);
    expect(t.json.truncated).toBe(true);
  });

  it("serializes mutating calls submitted together, in submission order", async () => {
    const h = harness({ files: { "a.txt": "one\n" } });
    const results = await Promise.all([
      h.call("edit", { path: "a.txt", old_text: "one", new_text: "two" }),
      h.call("edit", { path: "a.txt", old_text: "two", new_text: "three" }),
    ]);
    expect(results.map((r) => r.isError)).toEqual([false, false]);
    expect(readFileSync(path.join(h.root, "a.txt"), "utf8")).toBe("three\n");
  });

  it("classifies tools for the loop's parallel scheduling", () => {
    const h = harness();
    const parallel = TOOL_ORDER.filter((n) => h.runner.concurrency(n) === "parallel");
    expect(parallel).toEqual(["read", "glob", "grep", "context_retrieve", "capability_search"]);
    expect(h.runner.concurrency("mcp__github__get_issue")).toBe("serial");
  });
});

describe("approval policy", () => {
  it("asks once before the first mutation of a low-confidence workspace, then not again", async () => {
    const h = harness({ files: { "a.txt": "one\n" }, gateArmed: true });
    await h.call("read", { path: "a.txt" });
    expect(h.approvals).toEqual([]);
    expect((await h.call("edit", { path: "a.txt", old_text: "one", new_text: "two" })).isError).toBe(false);
    expect(h.approvals.map((a) => a.kind)).toEqual(["first_mutation"]);
    expect(h.approvals[0]!.detail).toContain("a.txt");
    await h.call("edit", { path: "a.txt", old_text: "two", new_text: "three" });
    expect(h.approvals).toHaveLength(1);
  });

  it("turns a declined mutation into a non-retryable corrective error with no change", async () => {
    const h = harness({ files: { "a.txt": "one\n" }, gateArmed: true, approve: false });
    const r = await h.call("edit", { path: "a.txt", old_text: "one", new_text: "two" });
    expect(r.json.error).toMatchObject({ code: "approval_denied", retryable: false });
    expect(readFileSync(path.join(h.root, "a.txt"), "utf8")).toBe("one\n");
    expect(h.store.listEvents({ type: "approval_decided" }).map((e) => (e.payload as { granted: boolean }).granted)).toEqual([false]);
  });
});
