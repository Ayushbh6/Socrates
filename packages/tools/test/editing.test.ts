import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parsePatch } from "../src";
import { harness } from "./helpers";

const read = (root: string, rel: string) => readFileSync(path.join(root, rel), "utf8");

describe("edit", () => {
  it("replaces one exact occurrence and returns a bounded diff", async () => {
    const h = harness({ files: { "a.ts": "const a = 1;\nconst b = 2;\n" } });
    const r = await h.call("edit", { path: "a.ts", old_text: "const b = 2;", new_text: "const b = 3;" });
    expect(r.json).toMatchObject({ path: "a.ts", replacements: 1, changed: true, match: "exact" });
    expect(r.json.diff).toContain("-const b = 2;\n+const b = 3;");
    expect(read(h.root, "a.ts")).toBe("const a = 1;\nconst b = 3;\n");
    const change = h.store.listEvents({ type: "file_changed" })[0]!.payload as any;
    expect(change).toMatchObject({ path: "a.ts", action: "updated", before: "const a = 1;\nconst b = 2;\n", after: "const a = 1;\nconst b = 3;\n" });
    expect(h.store.taskFacts(h.binding.taskId).map((f) => f.value)).toEqual(["a.ts"]);
  });

  it("fails safely on ambiguous and absent text, naming the lines", async () => {
    const h = harness({ files: { "a.ts": "x = 1\ny = 2\nx = 1\n" } });
    const ambiguous = await h.call("edit", { path: "a.ts", old_text: "x = 1", new_text: "x = 9" });
    expect(ambiguous.json.error.code).toBe("old_text_ambiguous");
    expect(ambiguous.json.error.message).toContain("lines 1, 3");
    const absent = await h.call("edit", { path: "a.ts", old_text: "x = 1\nz = 3", new_text: "q" });
    expect(absent.json.error.code).toBe("old_text_not_found");
    expect(absent.json.error.message).toContain("line 1, 3");
    expect(read(h.root, "a.ts")).toBe("x = 1\ny = 2\nx = 1\n");
    const all = await h.call("edit", { path: "a.ts", old_text: "x = 1", new_text: "x = 9", replace_all: true });
    expect(all.json.replacements).toBe(2);
    expect(read(h.root, "a.ts")).toBe("x = 9\ny = 2\nx = 9\n");
  });

  it("tolerates whitespace and punctuation drift without guessing, and re-indents the replacement", async () => {
    const source = "class A {\n    run() {\n        return 1;\n    }\n}\n";
    const h = harness({ files: { "a.ts": source, "q.md": "Use the “quoted” form — always.\n", "t.py": "x = 1   \n" } });
    const shifted = await h.call("edit", { path: "a.ts", old_text: "run() {\n    return 1;\n}", new_text: "run() {\n    return 2;\n}" });
    expect(shifted.json.match).toBe("indentation");
    expect(read(h.root, "a.ts")).toBe("class A {\n    run() {\n        return 2;\n    }\n}\n");
    const quotes = await h.call("edit", { path: "q.md", old_text: 'Use the "quoted" form - always.', new_text: "Use the plain form." });
    expect(quotes.json.match).toBe("unicode_punctuation");
    expect(read(h.root, "q.md")).toBe("Use the plain form.\n");
    const trailing = await h.call("edit", { path: "t.py", old_text: "x = 1", new_text: "x = 2" });
    expect(trailing.json.match).toBe("exact");
    expect(read(h.root, "t.py")).toBe("x = 2   \n");
  });

  it("never matches a merely similar block", async () => {
    const h = harness({ files: { "a.ts": "function alpha() {\n  return computeTotal(a, b);\n}\n" } });
    const r = await h.call("edit", { path: "a.ts", old_text: "function alpha() {\n  return computeTotals(a, b);\n}", new_text: "x" });
    expect(r.json.error.code).toBe("old_text_not_found");
  });

  it("preserves CRLF line endings and a byte-order mark", async () => {
    const h = harness({ files: { "w.txt": "﻿one\r\ntwo\r\n" } });
    await h.call("edit", { path: "w.txt", old_text: "one\ntwo", new_text: "uno\ndos" });
    expect(read(h.root, "w.txt")).toBe("﻿uno\r\ndos\r\n");
  });

  it("rejects a stale edit after the file changed outside the task, until it is read again", async () => {
    const h = harness({ files: { "a.ts": "value = 1\n" } });
    await h.call("read", { path: "a.ts" });
    writeFileSync(path.join(h.root, "a.ts"), "value = 1\n// formatter touched this\n");
    const stale = await h.call("edit", { path: "a.ts", old_text: "value = 1", new_text: "value = 2" });
    expect(stale.json.error.code).toBe("stale_file");
    expect(stale.json.error.correction).toContain("Read a.ts again");
    await h.call("read", { path: "a.ts" });
    expect((await h.call("edit", { path: "a.ts", old_text: "value = 1", new_text: "value = 2" })).isError).toBe(false);
    // Its own edit does not make the next edit stale.
    expect((await h.call("edit", { path: "a.ts", old_text: "value = 2", new_text: "value = 3" })).isError).toBe(false);
  });

  it("succeeds without a mutation when the replacement is identical", async () => {
    const h = harness({ files: { "a.ts": "same\n" } });
    const r = await h.call("edit", { path: "a.ts", old_text: "same", new_text: "same" });
    expect(r.json).toMatchObject({ changed: false, replacements: 1 });
    expect(h.store.listEvents({ type: "file_changed" })).toEqual([]);
  });

  it("does not create files or touch repository metadata", async () => {
    const h = harness({ files: { ".git/HEAD": "ref: refs/heads/main\n" } });
    expect((await h.call("edit", { path: "new.ts", old_text: "a", new_text: "b" })).json.error.code).toBe("file_not_found");
    expect((await h.call("edit", { path: ".git/HEAD", old_text: "main", new_text: "x" })).json.error.code).toBe("protected_path");
  });
});

describe("apply_patch", () => {
  it("parses the grammar leniently: heredoc wrapper, missing first @@, and end-of-file chunks", () => {
    const hunks = parsePatch(["apply_patch <<'EOF'", "*** Begin Patch", "*** Update File: a.ts", " keep", "-old", "+new", "*** End of File", "*** End Patch", "EOF"].join("\n"));
    expect(hunks).toEqual([{ kind: "update", path: "a.ts", moveTo: null, chunks: [{ context: null, oldLines: ["keep", "old"], newLines: ["keep", "new"], endOfFile: true }] }]);
  });

  it("creates, updates, moves, and deletes files in one atomic patch", async () => {
    const h = harness({ files: { "src/server.ts": "import x from 'x';\n\nexport function start() {\n  return 1;\n}\n", "old.md": "notes\n", "gone.txt": "bye\n" } });
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/config.ts",
      "+export const port = 3000;",
      "*** Update File: src/server.ts",
      "@@ export function start() {",
      "-  return 1;",
      "+  return 2;",
      "*** Update File: old.md",
      "*** Move to: docs/notes.md",
      "@@",
      "-notes",
      "+updated notes",
      "*** Delete File: gone.txt",
      "*** End Patch",
    ].join("\n");
    const r = await h.call("apply_patch", { patch });
    expect(r.isError).toBe(false);
    expect(r.json.files).toEqual([
      { path: "src/config.ts", action: "created" },
      { path: "src/server.ts", action: "updated" },
      { path: "docs/notes.md", action: "moved", from: "old.md" },
      { path: "gone.txt", action: "deleted" },
    ]);
    expect(read(h.root, "src/config.ts")).toBe("export const port = 3000;\n");
    expect(read(h.root, "src/server.ts")).toContain("  return 2;\n");
    expect(read(h.root, "docs/notes.md")).toBe("updated notes\n");
    expect(existsSync(path.join(h.root, "old.md"))).toBe(false);
    expect(existsSync(path.join(h.root, "gone.txt"))).toBe(false);
    expect(h.store.listEvents({ type: "file_changed" })).toHaveLength(4);
  });

  it("validates everything first: one bad chunk leaves every file untouched", async () => {
    const h = harness({ files: { "a.ts": "alpha\n", "b.ts": "beta\n" } });
    const patch = ["*** Begin Patch", "*** Update File: a.ts", "-alpha", "+ALPHA", "*** Update File: b.ts", "-gamma", "+GAMMA", "*** Add File: c.ts", "+c", "*** End Patch"].join("\n");
    const r = await h.call("apply_patch", { patch });
    expect(r.json.error.code).toBe("patch_context_not_found");
    expect(r.json.error.message).toContain("b.ts");
    expect(read(h.root, "a.ts")).toBe("alpha\n");
    expect(existsSync(path.join(h.root, "c.ts"))).toBe(false);
  });

  it("rolls back already written files when a later write fails", async () => {
    const h = harness({ files: { "a.ts": "alpha\n" } });
    const patch = ["*** Begin Patch", "*** Update File: a.ts", "-alpha", "+ALPHA", "*** Add File: blocked/deep/c.ts", "+c", "*** End Patch"].join("\n");
    writeFileSync(path.join(h.root, "blocked"), "a file where a directory is needed\n");
    const r = await h.call("apply_patch", { patch });
    expect(r.isError).toBe(true);
    expect(read(h.root, "a.ts")).toBe("alpha\n");
  });

  it("refuses unsafe or contradictory operations with corrective errors", async () => {
    const h = harness({ files: { "a.ts": "a\n", "b.ts": "b\n" } });
    const run = (body: string[]) => h.call("apply_patch", { patch: ["*** Begin Patch", ...body, "*** End Patch"].join("\n") });
    expect((await run(["*** Add File: a.ts", "+x"])).json.error.code).toBe("file_exists");
    expect((await run(["*** Delete File: missing.ts"])).json.error.code).toBe("file_not_found");
    expect((await run([`*** Add File: ${path.join(h.root, "abs.ts")}`, "+x"])).json.error.code).toBe("invalid_patch");
    expect((await run(["*** Add File: ../out.ts", "+x"])).json.error.code).toBe("outside_workspace");
    expect((await run(["*** Update File: a.ts", "*** Move to: b.ts", "-a", "+z"])).json.error.code).toBe("file_exists");
    expect((await run(["*** Update File: a.ts", "-a", "+x", "*** Update File: a.ts", "-x", "+y"])).json.error.message).toContain("more than once");
    const malformed = await h.call("apply_patch", { patch: "*** Begin Patch\n*** Frobnicate: a.ts\n*** End Patch" });
    expect(malformed.json.error.code).toBe("invalid_patch");
    expect(malformed.json.error.message).toContain("Line 2");
    expect(read(h.root, "a.ts")).toBe("a\n");
  });

  it("locates chunks by @@ context and tolerates trailing whitespace", async () => {
    const h = harness({ files: { "a.py": "def one():\n    return 1   \n\ndef two():\n    return 1\n" } });
    const patch = ["*** Begin Patch", "*** Update File: a.py", "@@ def two():", "-    return 1", "+    return 2", "*** End Patch"].join("\n");
    expect((await h.call("apply_patch", { patch })).isError).toBe(false);
    expect(read(h.root, "a.py")).toBe("def one():\n    return 1   \n\ndef two():\n    return 2\n");
  });
});
