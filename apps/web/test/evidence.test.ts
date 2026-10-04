import { describe, expect, it } from "vitest";
import { viewEvidence } from "../src/lib/evidence";

describe("the tool output viewer", () => {
  it("shows a file change as its diff", () => {
    const content = JSON.stringify({ files: [{ path: "a.js", action: "updated" }], diff: "--- a.js\n+++ a.js\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n" });
    expect(viewEvidence(content)).toEqual({ kind: "diff", lines: [
      { type: "head", text: "--- a.js" }, { type: "head", text: "+++ a.js" }, { type: "hunk", text: "@@ -1,2 +1,2 @@" },
      { type: "same", text: " keep" }, { type: "del", text: "-old" }, { type: "add", text: "+new" },
    ] });
  });

  it("tidies structured results, keeps text as recorded, and says when nothing is recorded", () => {
    expect(viewEvidence('{"matches":["a"],"diff":""}')).toEqual({ kind: "json", text: '{\n  "matches": [\n    "a"\n  ],\n  "diff": ""\n}' });
    expect(viewEvidence("line one\nline two")).toEqual({ kind: "text", text: "line one\nline two" });
    expect(viewEvidence("42")).toEqual({ kind: "text", text: "42" });
    expect(viewEvidence(null).kind).toBe("text");
  });
});
