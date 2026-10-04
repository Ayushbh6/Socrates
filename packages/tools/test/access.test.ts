import { existsSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AccessPolicy, describeAccess } from "../src";
import { harness, tempDir, writeFiles } from "./helpers";

const originalHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = originalHome;
});

/** A project, a folder beside it, and Socrates' data folder; the policy is changeable between calls. */
function setup(policy: Partial<AccessPolicy> = {}, approve: boolean | ((r: { kind: string }) => boolean) = true) {
  const other = tempDir();
  const parent = tempDir();
  const data = path.join(parent, "data");
  writeFiles(other, { "notes.md": "outside notes\n", "deep/plan.md": "the plan\n" });
  writeFiles(parent, { "visible.md": "secret-value is mentioned here\n", "data/.env": "GEMINI_API_KEY=secret-value\n", "data/settings.json": "{}\n" });
  let current: AccessPolicy = { folders: null, approvals: "auto", protected: [data], ...policy };
  const h = harness({ files: { "src/a.ts": "const a = 1;\n" }, approve, access: () => current });
  return { h, other, data, parent, set: (next: Partial<AccessPolicy>) => (current = { ...current, ...next }) };
}

describe("access: full", () => {
  it("reads, searches, edits and patches by absolute path anywhere, and expands ~", async () => {
    const { h, other } = setup();
    const read = await h.call("read", { path: path.join(other, "notes.md") });
    expect(read.content).toContain("1: outside notes");
    expect(read.content).toContain(`${other}/notes.md`);
    process.env.HOME = other;
    expect((await h.call("read", { path: "~/deep/plan.md" })).content).toContain("1: the plan");
    const glob = await h.call("glob", { pattern: "**/*.md", path: other });
    expect(glob.json.matches).toEqual([`${other}/deep/plan.md`, `${other}/notes.md`]);
    const grep = await h.call("grep", { pattern: "plan", path: other });
    expect(grep.json.matches).toEqual([{ path: `${other}/deep/plan.md`, line_number: 1, text: "the plan" }]);
    const edit = await h.call("edit", { path: path.join(other, "notes.md"), old_text: "outside notes", new_text: "changed notes" });
    expect(edit.isError).toBe(false);
    expect(readFileSync(path.join(other, "notes.md"), "utf8")).toBe("changed notes\n");
    const patch = await h.call("apply_patch", { patch: `*** Begin Patch\n*** Add File: ${other}/new.md\n+created\n*** End Patch` });
    expect(patch.isError).toBe(false);
    expect(readFileSync(path.join(other, "new.md"), "utf8")).toBe("created\n");
    expect(h.approvals).toEqual([]);
    // Workspace paths stay relative.
    expect((await h.call("read", { path: "src/a.ts" })).content).toContain("src/a.ts");
  });

  it("never reads, lists, changes or runs commands inside Socrates' data, including through a link", async () => {
    const { h, other, data, parent } = setup();
    const env = await h.call("read", { path: path.join(data, ".env") });
    expect(env.json.error.code).toBe("protected_path");
    expect(env.content).not.toContain("secret-value");
    symlinkSync(data, path.join(other, "alias"));
    expect((await h.call("read", { path: path.join(other, "alias", ".env") })).json.error.code).toBe("protected_path");
    if (process.platform === "darwin") expect((await h.call("read", { path: path.join(data.toUpperCase(), ".env") })).json.error.code).toBe("protected_path");
    const glob = await h.call("glob", { pattern: "**", path: parent });
    expect(glob.json.matches).toEqual([`${parent}/visible.md`]);
    const grep = await h.call("grep", { pattern: "secret-value", path: parent, literal: true });
    expect(grep.json.matches.map((m: { path: string }) => m.path)).toEqual([`${parent}/visible.md`]);
    expect(grep.content).not.toContain("GEMINI_API_KEY");
    expect((await h.call("edit", { path: path.join(data, "settings.json"), old_text: "{}", new_text: "{\"x\":1}" })).json.error.code).toBe("protected_path");
    expect((await h.call("terminal", { command: "ls", cwd: data })).json.error.code).toBe("protected_path");
    expect(readFileSync(path.join(data, "settings.json"), "utf8")).toBe("{}\n");
  });
});

describe("access: my folders", () => {
  it("works inside the folders without asking and asks once per path outside them", async () => {
    const asked: string[] = [];
    const s = setup({ approvals: "auto" }, (r) => (asked.push(r.kind), true));
    // The workspace is one of the folders.
    s.set({ folders: [s.h.root] });
    expect((await s.h.call("read", { path: "src/a.ts" })).isError).toBe(false);
    expect((await s.h.call("edit", { path: "src/a.ts", old_text: "1", new_text: "2" })).isError).toBe(false);
    expect(asked).toEqual([]);
    // A folder outside asks; the grant covers what is below it for this run, for reading only.
    expect((await s.h.call("glob", { pattern: "**/*.md", path: s.other })).json.matches).toHaveLength(2);
    expect(s.h.approvals.at(-1)).toMatchObject({ kind: "outside_folder", tool: "glob", detail: `Read ${s.other}, outside your folders` });
    expect((await s.h.call("read", { path: path.join(s.other, "deep/plan.md") })).isError).toBe(false);
    expect(asked).toEqual(["outside_folder"]);
    expect((await s.h.call("edit", { path: path.join(s.other, "notes.md"), old_text: "outside", new_text: "inside" })).isError).toBe(false);
    expect(s.h.approvals.at(-1)).toMatchObject({ kind: "outside_folder", detail: `Change ${s.other}/notes.md, outside your folders` });
    expect(asked).toEqual(["outside_folder", "outside_folder"]);
    // A new run asks again.
    s.h.nextTurn();
    await s.h.call("read", { path: path.join(s.other, "notes.md") });
    expect(asked).toEqual(["outside_folder", "outside_folder", "outside_folder"]);
  });

  it("refuses a path outside the folders when the user declines, and asks for the workspace when it is not listed", async () => {
    const { h, other } = setup({ folders: [], approvals: "auto" }, false);
    const refused = await h.call("read", { path: path.join(other, "notes.md") });
    expect(refused.json.error.code).toBe("approval_denied");
    expect(refused.content).not.toContain("outside notes");
    expect((await h.call("terminal", { command: "pwd" })).json.error.code).toBe("approval_denied");
    expect(h.approvals.at(-1)).toMatchObject({ kind: "outside_folder", detail: `Run commands in ${h.root}, outside your folders` });
    expect((await h.call("apply_patch", { patch: "*** Begin Patch\n*** Add File: src/b.ts\n+b\n*** End Patch" })).json.error.code).toBe("approval_denied");
    expect(existsSync(path.join(h.root, "src/b.ts"))).toBe(false);
    expect(h.store.listEvents({ type: "approval_decided" }).map((e) => (e.payload as any).kind)).toEqual(["outside_folder", "outside_folder", "outside_folder"]);
  });
});

describe("access: approvals", () => {
  it("asks first for every changing call with what will change, and never for reading", async () => {
    const { h } = setup({ approvals: "ask" }, (r) => r.kind !== "action" || !(r as any).detail.startsWith("Edit"));
    expect((await h.call("read", { path: "src/a.ts" })).isError).toBe(false);
    expect((await h.call("grep", { pattern: "const" })).isError).toBe(false);
    expect(h.approvals).toEqual([]);
    const refused = await h.call("edit", { path: "src/a.ts", old_text: "const a = 1;", new_text: "const a = 2;" });
    expect(refused.json.error.code).toBe("approval_denied");
    expect(h.approvals[0]).toEqual({ kind: "action", tool: "edit", detail: "Edit src/a.ts", preview: "--- replace\nconst a = 1;\n+++ with\nconst a = 2;" });
    expect(readFileSync(path.join(h.root, "src/a.ts"), "utf8")).toBe("const a = 1;\n");
    const patch = "*** Begin Patch\n*** Add File: src/b.ts\n+b\n*** Update File: src/a.ts\n@@\n-const a = 1;\n+const a = 3;\n*** End Patch";
    expect((await h.call("apply_patch", { patch })).isError).toBe(false);
    expect(h.approvals[1]).toEqual({ kind: "action", tool: "apply_patch", detail: "Apply a patch: add src/b.ts, update src/a.ts", preview: patch });
    // One approval covers a command run without a deadline: the classic prompt is not asked again.
    const run = await h.call("terminal", { command: "echo approved", timeout_ms: 0 });
    expect(run.json.output).toContain("approved");
    expect(h.approvals.slice(2)).toEqual([{ kind: "action", tool: "terminal", detail: "Run echo approved (without a deadline)" }]);
  });

  it("works freely in auto mode, skipping the first-change gate, and a change of policy applies to the next call", async () => {
    const other = tempDir();
    let policy: AccessPolicy = { folders: null, approvals: "auto", protected: [] };
    const h = harness({ files: { "a.txt": "one\n" }, gateArmed: true, access: () => policy });
    expect(h.store.firstMutationGatePending(h.binding.taskId)).toBe(true);
    expect((await h.call("edit", { path: "a.txt", old_text: "one", new_text: "two" })).isError).toBe(false);
    expect((await h.call("terminal", { command: "echo free", timeout_ms: 0 })).json.output).toContain("free");
    expect(h.approvals).toEqual([]);
    policy = { ...policy, approvals: "ask" };
    await h.call("edit", { path: "a.txt", old_text: "two", new_text: "three" });
    expect(h.approvals.map((a) => a.kind)).toEqual(["action"]);
    policy = { folders: [h.root], approvals: "auto", protected: [] };
    await h.call("read", { path: path.join(other, "missing.md") });
    expect(h.approvals.map((a) => a.kind)).toEqual(["action", "outside_folder"]);
  });

  it("keeps the workspace boundary and classic approvals without a policy", async () => {
    const other = tempDir();
    writeFiles(other, { "x.md": "x\n" });
    const h = harness({ files: { "a.txt": "one\n" }, gateArmed: true });
    expect((await h.call("read", { path: path.join(other, "x.md") })).json.error.code).toBe("outside_workspace");
    expect((await h.call("apply_patch", { patch: `*** Begin Patch\n*** Add File: ${other}/y.md\n+y\n*** End Patch` })).json.error.code).toBe("invalid_patch");
    await h.call("edit", { path: "a.txt", old_text: "one", new_text: "two" });
    expect(h.approvals.map((a) => a.kind)).toEqual(["first_mutation"]);
  });
});

describe("describeAccess", () => {
  it("tells the agent where it may work and when the user approves", () => {
    expect(describeAccess({ folders: null, approvals: "auto", protected: [] })).toBe(
      "files: anywhere on this computer by absolute path (Socrates' own data folders excepted).\napprovals: edits, patches and commands run without asking.",
    );
    expect(describeAccess({ folders: ["/Users/me/acme"], approvals: "ask", protected: [] })).toContain("files: /Users/me/acme. Any other path, including the workspace when it is not listed, asks the user first");
  });
});
