import { symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { timed } from "../src/tools/search";
import { harness, tempDir, writeFiles } from "./helpers";

describe("read", () => {
  it("returns a numbered window with paging metadata", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const h = harness({ files: { "src/a.ts": `${lines}\n` } });
    const r = await h.call("read", { path: "src/a.ts", offset: 10, limit: 5 });
    expect(r.isError).toBe(false);
    expect(r.content).toContain("src/a.ts — lines 10–14 of 30");
    expect(r.content).toContain("10: line 10\n");
    expect(r.content).toContain("14: line 14");
    expect(r.content).toContain("continue with read offset 15");
    const stored = h.store.listEvents({ type: "tool_completed" }).at(-1)!.payload as any;
    expect(stored.result).toMatchObject({ offset: 10, total_lines: 30, truncated: true, next_offset: 15 });
    expect(stored.result.lines[0]).toEqual({ number: 10, text: "line 10" });
  });

  it("pages at the token ceiling rather than losing text", async () => {
    const h = harness({ files: { "big.txt": Array.from({ length: 3000 }, (_, i) => `${i} ${"lorem ipsum dolor sit amet ".repeat(4)}`).join("\n") } });
    const first = await h.call("read", { path: "big.txt" });
    const next = /continue with read offset (\d+)/.exec(first.content);
    expect(next).not.toBeNull();
    const second = await h.call("read", { path: "big.txt", offset: Number(next![1]) });
    expect(second.content).toContain(`${next![1]}: ${Number(next![1]) - 1} lorem`);
  });

  it("cuts pathological lines with an explicit marker", async () => {
    const h = harness({ files: { "min.js": `${"x".repeat(5000)}\nshort\n` } });
    const r = await h.call("read", { path: "min.js" });
    expect(r.content).toContain("[line truncated: 3000 more characters]");
    expect(r.content).toContain("2: short");
  });

  it("handles empty files, CRLF, and a BOM", async () => {
    const h = harness({ files: { "empty.txt": "", "win.txt": "﻿a\r\nb\r\n" } });
    expect((await h.call("read", { path: "empty.txt" })).content).toContain("empty (0 lines)");
    const win = await h.call("read", { path: "win.txt" });
    expect(win.content).toContain("1: a\n2: b");
    expect(win.content).not.toContain("\r");
    expect(win.content).not.toContain("﻿");
  });

  it("fails with corrective errors for missing, directory, binary, invalid UTF-8, and out-of-range reads", async () => {
    const h = harness({ files: { "src/server.ts": "x\n", "data.bin": Buffer.from([0x89, 0x50, 0x00, 0x01]), "latin.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9]) } });
    const missing = await h.call("read", { path: "src/servr.ts" });
    expect(missing.json.error.code).toBe("file_not_found");
    expect(missing.json.error.message).toContain("src/server.ts");
    expect((await h.call("read", { path: "src" })).json.error.code).toBe("is_directory");
    expect((await h.call("read", { path: "data.bin" })).json.error.code).toBe("binary_file");
    expect((await h.call("read", { path: "latin.txt" })).json.error.code).toBe("invalid_utf8");
    const range = await h.call("read", { path: "src/server.ts", offset: 9 });
    expect(range.json.error).toMatchObject({ code: "offset_out_of_range" });
    expect(range.json.error.correction).toContain("between 1 and 1");
  });

  it("refuses paths outside the workspace, including through symbolic links", async () => {
    const outside = tempDir("socrates-outside-");
    writeFiles(outside, { "secret.txt": "secret\n" });
    const h = harness({ files: { "ok.txt": "fine\n" } });
    symlinkSync(outside, path.join(h.root, "escape"));
    for (const p of ["../secret.txt", path.join(outside, "secret.txt"), "escape/secret.txt"]) {
      const r = await h.call("read", { path: p });
      expect(r.json.error.code).toBe("outside_workspace");
      expect(r.content).not.toContain("secret\n");
    }
    // An absolute path inside the workspace is accepted.
    expect((await h.call("read", { path: path.join(h.root, "ok.txt") })).content).toContain("1: fine");
  });
});

describe("glob", () => {
  it("lists files in stable path order, honouring .gitignore and excluding .git", async () => {
    const h = harness({
      files: {
        ".gitignore": "dist/\n",
        "b.ts": "",
        "a.ts": "",
        "src/c.ts": "",
        "src/d.md": "",
        ".hidden/e.ts": "",
        "dist/out.ts": "",
        ".git/config.ts": "",
      },
    });
    const r = await h.call("glob", { pattern: "**/*.ts", sort: "path" });
    expect(r.json).toMatchObject({ root: ".", truncated: false, next_cursor: null });
    expect(r.json.matches).toEqual([".hidden/e.ts", "a.ts", "b.ts", "src/c.ts"]);
    const scoped = await h.call("glob", { pattern: "*", path: "src", sort: "path" });
    expect(scoped.json.matches).toEqual(["src/c.ts", "src/d.md"]);
    expect(scoped.json.root).toBe("src");
  });

  it("pages an exact frozen result set with cursors", async () => {
    const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}.txt`, ""]));
    const h = harness({ files });
    const first = await h.call("glob", { pattern: "*.txt", limit: 3, sort: "path" });
    expect(first.json).toMatchObject({ returned: 3, truncated: true });
    writeFiles(h.root, { "f_late.txt": "" }); // Created after the first page; must not appear.
    const second = await h.call("glob", { pattern: "*.txt", limit: 3, sort: "path", cursor: first.json.next_cursor });
    const third = await h.call("glob", { pattern: "*.txt", limit: 3, sort: "path", cursor: second.json.next_cursor });
    expect([...first.json.matches, ...second.json.matches, ...third.json.matches]).toEqual(Object.keys(files).sort());
    expect(third.json.next_cursor).toBeNull();
    const mismatch = await h.call("glob", { pattern: "*.txt", limit: 3, cursor: first.json.next_cursor });
    expect(mismatch.json.error.code).toBe("cursor_mismatch");
    expect((await h.call("glob", { pattern: "*.txt", cursor: "k999" })).json.error.code).toBe("cursor_expired");
  });

  it("lists the most recently modified first by default, and ignored files only when asked", async () => {
    const h = harness({ files: { ".gitignore": "node_modules/\n", "old.ts": "", "new.ts": "", "mid.ts": "", "node_modules/pkg/index.ts": "", ".git/hooks/x.ts": "" } });
    const day = 86_400;
    const now = Date.now() / 1000;
    utimesSync(path.join(h.root, "old.ts"), now - 3 * day, now - 3 * day);
    utimesSync(path.join(h.root, "mid.ts"), now - 2 * day, now - 2 * day);
    utimesSync(path.join(h.root, "new.ts"), now - day, now - day);
    utimesSync(path.join(h.root, "node_modules/pkg/index.ts"), now - 4 * day, now - 4 * day);
    expect((await h.call("glob", { pattern: "**/*.ts" })).json.matches).toEqual(["new.ts", "mid.ts", "old.ts"]);
    expect((await h.call("glob", { pattern: "**/*.ts", include_ignored: true })).json.matches).toEqual(["new.ts", "mid.ts", "old.ts", "node_modules/pkg/index.ts"]);
    // An inclusion pattern alone never brings an ignored file back.
    expect((await h.call("glob", { pattern: "node_modules/**" })).json.matches).toEqual([]);
    expect((await h.call("glob", { pattern: "*.{ts,md}", sort: "path" })).json.matches).toEqual(["mid.ts", "new.ts", "old.ts"]);
    // A catch-all pattern never brings .git back, even with ignored files included.
    expect((await h.call("glob", { pattern: "**/*", include_ignored: true, sort: "path" })).json.matches).toEqual([".gitignore", "mid.ts", "new.ts", "node_modules/pkg/index.ts", "old.ts"]);
    expect((await h.call("glob", { pattern: ".git/**", include_ignored: true })).json.matches).toEqual([]);
  });

  it("returns an empty match as success with a hint", async () => {
    const h = harness({ files: { "a.ts": "" } });
    const r = await h.call("glob", { pattern: "*.py" });
    expect(r.isError).toBe(false);
    expect(r.json.matches).toEqual([]);
    expect(r.json.note).toContain(".gitignore");
    expect((await h.call("glob", { pattern: "*", path: "a.ts" })).json.error.code).toBe("not_a_directory");
  });
});

describe("grep", () => {
  const files = {
    "src/server.ts": "const server = await startServer();\nexport function startServer() {}\n",
    "src/util.ts": "// StartServer helper\nconst x = 1;\n",
    "test/server.test.ts": "startServer();\n",
  };

  it("finds regex matches with paths and line numbers in stable order", async () => {
    const h = harness({ files });
    const r = await h.call("grep", { pattern: "start\\w+\\(" });
    expect(r.json.matches).toEqual([
      { path: "src/server.ts", line_number: 1, text: "const server = await startServer();" },
      { path: "src/server.ts", line_number: 2, text: "export function startServer() {}" },
      { path: "test/server.test.ts", line_number: 1, text: "startServer();" },
    ]);
  });

  it("supports literal, case-insensitive, glob-filtered, and single-file searches", async () => {
    const h = harness({ files });
    expect((await h.call("grep", { pattern: "startServer()", literal: true })).json.returned).toBe(3);
    expect((await h.call("grep", { pattern: "startserver", case_sensitive: false })).json.returned).toBe(4);
    expect((await h.call("grep", { pattern: "startServer", glob: "*.test.ts" })).json.matches.map((m: any) => m.path)).toEqual(["test/server.test.ts"]);
    expect((await h.call("grep", { pattern: "const", path: "src/util.ts" })).json.matches).toEqual([{ path: "src/util.ts", line_number: 2, text: "const x = 1;" }]);
  });

  it("cuts long matched lines and pages with cursors", async () => {
    const h = harness({ files: { "a.txt": Array.from({ length: 12 }, (_, i) => `hit ${i} ${"y".repeat(900)}`).join("\n") } });
    const first = await h.call("grep", { pattern: "hit", limit: 5 });
    expect(first.json.matches[0].text).toContain("[line truncated:");
    expect(first.json.matches[0].text.length).toBeLessThan(600);
    const rest = await h.call("grep", { pattern: "hit", limit: 100, cursor: first.json.next_cursor });
    expect(rest.json.matches.map((m: any) => m.line_number)).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });

  it("reports an invalid expression as a corrective error and no match as success", async () => {
    const h = harness({ files });
    const bad = await h.call("grep", { pattern: "start(" });
    expect(bad.json.error.code).toBe("invalid_pattern");
    expect(bad.json.error.correction).toContain("literal");
    const none = await h.call("grep", { pattern: "nothing_here" });
    expect(none.isError).toBe(false);
    expect(none.json.matches).toEqual([]);
    expect((await h.call("grep", { pattern: "x", path: "nope" })).json.error.code).toBe("path_not_found");
  });

  it("shows the lines around each match, and a line between two matches belongs to both", async () => {
    const h = harness({ files: { "a.ts": ["one", "two", "hit A", "four", "hit B", "six", "seven"].join("\n") + "\n" } });
    const r = await h.call("grep", { pattern: "hit", context: 2 });
    expect(r.json.matches).toEqual([
      { path: "a.ts", line_number: 3, text: "hit A", before: ["one", "two"], after: ["four", "hit B"] },
      { path: "a.ts", line_number: 5, text: "hit B", before: ["hit A", "four"], after: ["six", "seven"] },
    ]);
    const edges = await h.call("grep", { pattern: "one|seven", context_before: 1, context_after: 0 });
    expect(edges.json.matches).toEqual([{ path: "a.ts", line_number: 1, text: "one", before: [] }, { path: "a.ts", line_number: 7, text: "seven", before: ["six"] }]);
  });

  it("lists matching files newest first, or counts matching lines per file", async () => {
    const h = harness({ files: { "old.ts": "todo\ntodo\n", "new.ts": "todo\n", "none.ts": "nothing\n" } });
    const now = Date.now() / 1000;
    utimesSync(path.join(h.root, "old.ts"), now - 200, now - 200);
    utimesSync(path.join(h.root, "new.ts"), now - 100, now - 100);
    expect((await h.call("grep", { pattern: "todo", output: "files" })).json).toMatchObject({ output: "files", files: ["new.ts", "old.ts"], returned: 2 });
    expect((await h.call("grep", { pattern: "todo", output: "count", sort: "path" })).json.counts).toEqual([{ path: "new.ts", count: 1 }, { path: "old.ts", count: 2 }]);
    expect((await h.call("grep", { pattern: "todo", output: "count", path: "old.ts" })).json.counts).toEqual([{ path: "old.ts", count: 2 }]);
  });

  it("matches across lines when asked, and says so when a pattern needs it", async () => {
    const h = harness({ files: { "a.ts": "function go(\n  x,\n) {}\n" } });
    const r = await h.call("grep", { pattern: "go\\(\\n\\s+x", multiline: true });
    expect(r.json.matches).toEqual([{ path: "a.ts", line_number: 1, end_line: 2, text: "function go(\n  x," }]);
    const plain = await h.call("grep", { pattern: "go\\(\\n" });
    expect(plain.json.error).toMatchObject({ code: "invalid_pattern", correction: "To match across lines, set multiline: true." });
  });

  it("filters by file type, and names an unknown type", async () => {
    const h = harness({ files: { "a.py": "needle\n", "b.ts": "needle\n", "c.md": "needle\n" } });
    expect((await h.call("grep", { pattern: "needle", type: "py" })).json.matches.map((m: any) => m.path)).toEqual(["a.py"]);
    expect((await h.call("grep", { pattern: "needle", glob: "!*.md", sort: "path" })).json.matches.map((m: any) => m.path)).toEqual(["a.py", "b.ts"]);
    expect((await h.call("grep", { pattern: "needle", type: "nosuchtype" })).json.error.code).toBe("invalid_type");
  });

  it("shows a window around a match deep in a long line, and keeps matches in files that are not UTF-8", async () => {
    const h = harness({ files: { "min.js": `${"a".repeat(3000)}NEEDLE${"b".repeat(3000)}\n` } });
    writeFileSync(path.join(h.root, "latin1.txt"), Buffer.from("caf\xe9 needle\n", "latin1"));
    const long = (await h.call("grep", { pattern: "NEEDLE" })).json.matches[0];
    expect(long.text).toContain("NEEDLE");
    expect(long.text).toMatch(/^\[line truncated: \d+ characters before\] …a+NEEDLEb+… \[line truncated: \d+ more characters\]$/);
    const latin = (await h.call("grep", { pattern: "needle" })).json.matches[0];
    expect(latin).toMatchObject({ path: "latin1.txt", line_number: 1, encoding: "not_utf8" });
    expect(latin.text).toContain("needle");
  });

  it("searches ignored files only when asked, and never .git", async () => {
    const h = harness({ files: { ".gitignore": "dist/\n", "src/a.ts": "token\n", "dist/a.js": "token\n", ".git/config": "token\n" } });
    expect((await h.call("grep", { pattern: "token" })).json.matches.map((m: any) => m.path)).toEqual(["src/a.ts"]);
    expect((await h.call("grep", { pattern: "token", glob: "dist/**" })).json.matches).toEqual([]);
    expect((await h.call("grep", { pattern: "token", include_ignored: true })).json.matches.map((m: any) => m.path)).toEqual(["dist/a.js", "src/a.ts"]);
    expect((await h.call("grep", { pattern: "token", path: "dist/a.js" })).json.matches).toEqual([]);
    expect((await h.call("grep", { pattern: "token", glob: "**/*", include_ignored: true })).json.matches.map((m: any) => m.path)).toEqual(["dist/a.js", "src/a.ts"]);
  });

  it("stops a search that runs too long with a corrective error", async () => {
    const slow = timed(new AbortController().signal, (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))), 20);
    await expect(slow).rejects.toMatchObject({ code: "search_timeout" });
    const user = new AbortController();
    const cancelled = timed(user.signal, (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")))), 5_000);
    user.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
  });
});
