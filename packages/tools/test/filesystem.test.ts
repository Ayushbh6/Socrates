import { symlinkSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
    const h = harness({ files: { "src/server.ts": "x\n", "img.png": Buffer.from([0x89, 0x50, 0x00, 0x01]), "latin.txt": Buffer.from([0x63, 0x61, 0x66, 0xe9]) } });
    const missing = await h.call("read", { path: "src/servr.ts" });
    expect(missing.json.error.code).toBe("file_not_found");
    expect(missing.json.error.message).toContain("src/server.ts");
    expect((await h.call("read", { path: "src" })).json.error.code).toBe("is_directory");
    expect((await h.call("read", { path: "img.png" })).json.error.code).toBe("binary_file");
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
    const r = await h.call("glob", { pattern: "**/*.ts" });
    expect(r.json).toMatchObject({ root: ".", truncated: false, next_cursor: null });
    expect(r.json.matches).toEqual([".hidden/e.ts", "a.ts", "b.ts", "src/c.ts"]);
    const scoped = await h.call("glob", { pattern: "*", path: "src" });
    expect(scoped.json.matches).toEqual(["src/c.ts", "src/d.md"]);
    expect(scoped.json.root).toBe("src");
  });

  it("pages an exact frozen result set with cursors", async () => {
    const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}.txt`, ""]));
    const h = harness({ files });
    const first = await h.call("glob", { pattern: "*.txt", limit: 3 });
    expect(first.json).toMatchObject({ returned: 3, truncated: true });
    writeFiles(h.root, { "f_late.txt": "" }); // Created after the first page; must not appear.
    const second = await h.call("glob", { pattern: "*.txt", limit: 3, cursor: first.json.next_cursor });
    const third = await h.call("glob", { pattern: "*.txt", limit: 3, cursor: second.json.next_cursor });
    expect([...first.json.matches, ...second.json.matches, ...third.json.matches]).toEqual(Object.keys(files).sort());
    expect(third.json.next_cursor).toBeNull();
    const mismatch = await h.call("glob", { pattern: "*.md", cursor: first.json.next_cursor });
    expect(mismatch.json.error.code).toBe("cursor_mismatch");
    expect((await h.call("glob", { pattern: "*.txt", cursor: "k999" })).json.error.code).toBe("cursor_expired");
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
});
