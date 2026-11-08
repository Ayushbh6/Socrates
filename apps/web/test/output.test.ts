import { describe, expect, it } from "vitest";
import { WRAP_AT, evidenceLayout, languageOf, layoutOf, matchLayout, plainTerminal, prettyJson, readLayout } from "../src/lib/output";

describe("tool output layouts", () => {
  it("takes a terminal's colour codes out and keeps a redrawn line's last state", () => {
    expect(plainTerminal("\u001b[32m✓ passed\u001b[0m\nprogress 10%\rprogress 100%\n")).toBe("✓ passed\nprogress 100%\n");
  });

  it("indents whole JSON only", () => {
    expect(prettyJson('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
    expect(prettyJson('{"a":1')).toBeNull();
    expect(prettyJson("plain")).toBeNull();
  });

  it("reads a file preview as numbered lines in its language", () => {
    const layout = readLayout("src/a.ts — lines 1–3 of 40\n1: import x from \"y\";\n2: \n3: export const z = 1;\n4", "~/p/src/a.ts");
    expect(layout).toEqual({ kind: "code", path: "src/a.ts", range: "lines 1–3 of 40", language: "typescript", lines: [{ n: 1, text: 'import x from "y";' }, { n: 2, text: "" }, { n: 3, text: "export const z = 1;" }] });
    expect(readLayout("not a file preview", null)).toBeNull();
  });

  it("groups search matches under their files, and counts too", () => {
    expect(matchLayout("a.ts:3: foo\na.ts:9: foo()\nb.md:1: # foo")).toEqual({ kind: "matches", files: [{ path: "a.ts", hits: [{ n: 3, text: "foo" }, { n: 9, text: "foo()" }] }, { path: "b.md", hits: [{ n: 1, text: "# foo" }] }] });
    expect(matchLayout("a.ts: 2\nb.ts: 1")).toEqual({ kind: "matches", files: [{ path: "a.ts", hits: [{ n: null, text: "2 matches" }] }, { path: "b.ts", hits: [{ n: null, text: "1 match" }] }] });
    expect(matchLayout("a.ts\nsrc/b.ts")).toEqual({ kind: "files", paths: ["a.ts", "src/b.ts"] });
  });

  it("lays out command output as a terminal shows it: JSON indented, JSON lines one record at a time, very long lines wrapped", () => {
    expect(layoutOf("terminal", "terminal", '{"ok":true}', null, false)).toEqual({ kind: "terminal", text: '{\n  "ok": true\n}', language: "json", wrap: false });
    const jsonl = layoutOf("terminal", "terminal", '{"a":1}\n{"b":2}\n{"c":', null, false);
    expect(jsonl).toEqual({ kind: "terminal", text: '{\n  "a": 1\n}\n{\n  "b": 2\n}\n{"c":', language: "json", wrap: false });
    const long = layoutOf("terminal", "terminal", "x".repeat(WRAP_AT + 1), null, false);
    expect(long).toMatchObject({ kind: "terminal", language: null, wrap: true });
    expect(layoutOf("terminal", "terminal", "  2692 total\n   275 a.ts", null, false)).toMatchObject({ wrap: false, language: null });
  });

  it("chooses by tool, and shows a failure as its words", () => {
    expect(layoutOf("glob", "search", "a.ts\nb.ts\n…", "**/*.ts", false)).toEqual({ kind: "files", paths: ["a.ts", "b.ts"] });
    expect(layoutOf("read", "read", "Error: no such file", "x.ts", true)).toEqual({ kind: "text", text: "Error: no such file" });
    expect(layoutOf("context_retrieve", "memory", '{"results":[]}', null, false)).toEqual({ kind: "json", text: '{\n  "results": []\n}' });
  });

  it("knows a file's language by its name", () => {
    expect(languageOf("~/x/App.tsx")).toBe("typescript");
    expect(languageOf("Dockerfile")).toBe("dockerfile");
    expect(languageOf("notes.weird")).toBeNull();
  });

  it("lays out a whole recorded result like its card", () => {
    expect(evidenceLayout("grep", JSON.stringify({ matches: [{ path: "a.ts", line_number: 2, text: "foo" }] }), "foo")?.layout).toEqual({ kind: "matches", files: [{ path: "a.ts", hits: [{ n: 2, text: "foo" }] }] });
    expect(evidenceLayout("glob", JSON.stringify({ matches: ["a.ts"], truncated: true }), null)).toEqual({ layout: { kind: "files", paths: ["a.ts"] }, facts: ["more files than listed"] });
    const run = evidenceLayout("terminal", JSON.stringify({ status: "completed", exit_code: 1, output: "\u001b[31mFAIL\u001b[0m x\n", output_lines: 1 }), null);
    expect(run).toEqual({ layout: { kind: "terminal", text: "FAIL x\n", language: null, wrap: false }, facts: ["completed", "exit 1", "1 line"] });
    expect(evidenceLayout("terminal", "[The saved output was removed]\nok", null)?.layout).toMatchObject({ kind: "terminal", text: "[The saved output was removed]\nok" });
    expect(evidenceLayout("edit", JSON.stringify({ diff: "+a" }), null)).toBeNull();
  });
});
