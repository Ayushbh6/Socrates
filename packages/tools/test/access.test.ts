import { existsSync, readFileSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AccessPolicy, describeAccess } from "../src";
import { harness, tempDir, writeFiles } from "./helpers";

const originalHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = originalHome;
});

/** A project, a folder beside it, and Socrates' data folder; the policy is changeable between calls. */
function setup(policy: Partial<AccessPolicy> = {}, approve: boolean | ((r: { kind: string }) => boolean | Promise<boolean>) = true) {
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
    // Several changes, or a new file, are shown whole too.
    await h.call("edit", { path: "src/a.ts", edits: [{ old_text: "const", new_text: "let" }, { old_text: "1", new_text: "2", replace_all: true }] });
    expect(h.approvals.at(-1)).toMatchObject({ detail: "Edit src/a.ts (2 changes) (every occurrence)", preview: "--- replace\nconst\n+++ with\nlet\n\n--- replace\n1\n+++ with\n2" });
    await h.call("edit", { path: "src/new.ts", old_text: "", new_text: "export {};\n" });
    expect(h.approvals.at(-1)).toMatchObject({ detail: "Create src/new.ts", preview: "+++ new file\nexport {};\n" });
    h.approvals.splice(1);
    const patch = "*** Begin Patch\n*** Add File: src/b.ts\n+b\n*** Update File: src/a.ts\n@@\n-const a = 1;\n+const a = 3;\n*** End Patch";
    expect((await h.call("apply_patch", { patch })).isError).toBe(false);
    expect(h.approvals[1]).toEqual({ kind: "action", tool: "apply_patch", detail: "Apply a patch: add src/b.ts, update src/a.ts", preview: patch });
    // One approval covers a command run without a deadline: the classic prompt is not asked again.
    const run = await h.call("terminal", { command: "echo approved", timeout_ms: 0 });
    expect(run.json.output).toContain("approved");
    expect(h.approvals.slice(2)).toEqual([{ kind: "action", tool: "terminal", detail: "Run echo approved (without a deadline)", preview: JSON.stringify({ command: "echo approved", timeout_ms: 0 }) }]);
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

describe("access review regressions", () => {
  it("protects the real target of a data folder that is itself a symlink", async () => {
    const data = tempDir();
    const parent = tempDir();
    const alias = path.join(parent, "classic-data");
    writeFiles(data, { "secret.md": "private sentinel" });
    symlinkSync(data, alias);
    const { h } = setup({ protected: [alias] });
    expect((await h.call("read", { path: path.join(data, "secret.md") })).json.error.code).toBe("protected_path");
    expect((await h.call("grep", { path: data, pattern: "sentinel" })).json.error.code).toBe("protected_path");
  });

  it("prunes protected search folders before opening their ignore files, even with inclusion globs", async () => {
    const parent = tempDir();
    const data = path.join(parent, "data[private]*");
    writeFiles(parent, { "public.md": "sentinel", "data[private]*/private.md": "private sentinel", "data[private]*/.ignore": "[\n" });
    const { h } = setup({ protected: [data] });
    const files = await h.call("glob", { pattern: "**", path: parent });
    expect(files.isError).toBe(false);
    expect(files.json.matches).toEqual([`${parent}/public.md`]);
    const found = await h.call("grep", { pattern: "sentinel", glob: "**", path: parent });
    expect(found.isError).toBe(false);
    expect(found.json.matches).toEqual([{ path: `${parent}/public.md`, line_number: 1, text: "sentinel" }]);
    // Including ignored files never includes protected ones.
    expect((await h.call("glob", { pattern: "**", path: parent, include_ignored: true })).json.matches).toEqual([`${parent}/public.md`]);
    expect((await h.call("grep", { pattern: "sentinel", glob: "**", path: parent, include_ignored: true })).json.matches.map((m: { path: string }) => m.path)).toEqual([`${parent}/public.md`]);
  });

  it.each(["read", "edit", "apply_patch"])("rechecks %s paths after an outside-folder approval", async tool => {
    const outside = tempDir();
    const data = tempDir();
    const file = path.join(outside, "notes.md");
    writeFiles(outside, { "notes.md": "ordinary" });
    writeFiles(data, { "secret.md": "private sentinel" });
    const { h } = setup({ folders: [], protected: [data] }, () => {
      renameSync(file, `${file}.old`);
      symlinkSync(path.join(data, "secret.md"), file);
      return true;
    });
    const input = tool === "read" ? { path: file } : tool === "edit" ? { path: file, old_text: "ordinary", new_text: "changed" } : { patch: `*** Begin Patch\n*** Update File: ${file}\n@@\n-ordinary\n+changed\n*** End Patch` };
    const result = await h.call(tool, input);
    expect(result.json.error.code).toBe("protected_path");
    expect(result.content).not.toContain("private sentinel");
    expect(readFileSync(path.join(data, "secret.md"), "utf8")).toBe("private sentinel");
  });

  it("does not turn a file grant into permission for a replacement directory", async () => {
    const s = setup({ folders: [] });
    const file = path.join(s.other, "notes.md");
    await s.h.call("read", { path: file });
    unlinkSync(file);
    writeFiles(s.other, { "notes.md/child.md": "new child" });
    await s.h.call("read", { path: path.join(file, "child.md") });
    expect(s.h.approvals.map(a => a.kind)).toEqual(["outside_folder", "outside_folder"]);
  });

  it("checks current folders before restarting or writing to an existing terminal", async () => {
    const s = setup({}, false);
    const start = await s.h.call("terminal", { command: "node -e 'setInterval(() => {}, 1000)'", cwd: s.other, background: true, name: "service" });
    expect(start.isError).toBe(false);
    s.set({ folders: [s.h.root] });
    for (const action of ["restart", "write"] as const) {
      const result = await s.h.call("terminal_control", { action, terminal: "service", ...(action === "write" ? { input: "anything" } : {}) });
      expect(result.json.error.code).toBe("approval_denied");
    }
    expect(s.h.approvals).toEqual([
      { kind: "outside_folder", tool: "terminal_control", detail: `Run commands in ${s.other}, outside your folders` },
      { kind: "outside_folder", tool: "terminal_control", detail: `Run commands in ${s.other}, outside your folders` },
    ]);
    expect((await s.h.call("terminal_control", { action: "list" })).json.terminals[0].status).toBe("running");
    // Cleanup stays possible after permission is revoked.
    expect((await s.h.call("terminal_control", { action: "terminate", terminal: "service" })).isError).toBe(false);
  });

  it("blocks a restart when an old terminal's folder becomes protected", async () => {
    const s = setup();
    await s.h.call("terminal", { command: "node -e 'setInterval(() => {}, 1000)'", cwd: s.other, background: true, name: "service" });
    s.set({ protected: [s.other] });
    expect((await s.h.call("terminal_control", { action: "restart", terminal: "service" })).json.error.code).toBe("protected_path");
    expect(s.h.approvals).toEqual([]);
  });

  it("shows the full command, environment and control input in action previews", async () => {
    const { h } = setup({ approvals: "ask" }, false);
    const input = { command: `echo ${"a".repeat(350)}; echo tail`, cwd: ".", env: { MODE: "test" } };
    await h.call("terminal", input);
    expect(h.approvals[0]!.preview).toBe(JSON.stringify(input));
    expect(h.approvals[0]!.preview).toContain("echo tail");
    const control = { action: "write", terminal: "service", input: "changing input", keys: ["CTRL_C"] };
    await h.call("terminal_control", control);
    expect(h.approvals[1]!.preview).toBe(JSON.stringify(control));
  });

  it.each(["edit", "apply_patch", "terminal"])("refuses an oversized %s action instead of approving a truncated preview", async tool => {
    const { h } = setup({ approvals: "ask" });
    const large = "x".repeat(21_000);
    const input = tool === "edit" ? { path: "src/a.ts", old_text: "1", new_text: large } : tool === "apply_patch" ? { patch: `*** Begin Patch\n*** Add File: huge.md\n+${large}\n*** End Patch` } : { command: `#${"\n".repeat(11_000)}` };
    expect((await h.call(tool, input)).json.error.code).toBe("approval_too_large");
    expect(h.approvals).toEqual([]);
    expect(readFileSync(path.join(h.root, "src/a.ts"), "utf8")).toBe("const a = 1;\n");
    expect(existsSync(path.join(h.root, "huge.md"))).toBe(false);
  });

  it("serializes edits of the same outside file across different workspaces", async () => {
    const outside = tempDir();
    writeFiles(outside, { "notes.md": "one" });
    const file = path.join(outside, "notes.md");
    const first = setup().h;
    const second = setup().h;
    await Promise.all([first.call("read", { path: file }), second.call("read", { path: file })]);
    const results = await Promise.all([
      first.call("edit", { path: file, old_text: "one", new_text: "two" }),
      second.call("edit", { path: file, old_text: "one", new_text: "three" }),
    ]);
    expect(results.filter(r => !r.isError)).toHaveLength(1);
    expect(results.find(r => r.isError)!.json.error.code).toBe("stale_file");
    expect(["two", "three"]).toContain(readFileSync(file, "utf8"));
  });
});
