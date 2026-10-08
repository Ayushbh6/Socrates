import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AccessPolicy } from "@socrates/tools";
import { continueTask, decision, defineTask, general } from "../../router/test/helpers";
import { call, contextText, final, tempDir, world, writeFiles } from "./helpers";

describe("access", () => {
  it("tells the agent where it may work, asks before each change in ask mode, and omits the block without a policy", async () => {
    const w = await world({ files: { "server.js": "const port = 30;\n" } });
    const policy: AccessPolicy = { folders: [w.root], approvals: "ask", protected: [] };
    const { socrates, model } = w.socrates([continueTask()], [
      { toolCalls: [call("read", { path: "server.js" })] },
      { toolCalls: [call("edit", { path: "server.js", old_text: "30", new_text: "3000" })] },
      final({ full_answer: "The port is fixed." }),
    ], { access: () => policy });
    await socrates.handle("Fix the port.");
    const text = contextText(model.requests[0]!);
    const block = /<ACCESS>\n([\s\S]*?)\n<\/ACCESS>/.exec(text)![1]!;
    expect(block).toBe(`starts in: ${realpathSync(w.root)}. Relative paths and commands begin here; any other path is absolute or starts with ~/.\nfiles: ${w.root}. Any other path, including the workspace when it is not listed, asks the user first, who may refuse.\napprovals: the user approves each edit, patch, command and changing MCP call before it runs, and may refuse. Reading and searching need no approval.`);
    expect(text.indexOf("<ACCESS>")).toBeGreaterThan(text.indexOf("<CURRENT_TASK>"));
    expect(text.indexOf("<ACCESS>")).toBeLessThan(text.indexOf("<CURRENT_USER_MESSAGE>"));
    expect(w.approvals).toEqual([{ kind: "action", tool: "edit", detail: "Edit server.js", preview: "--- replace\n30\n+++ with\n3000" }]);
    expect(readFileSync(path.join(w.root, "server.js"), "utf8")).toBe("const port = 3000;\n");

    const plain = await world();
    const classic = plain.socrates([continueTask()], [final()]);
    await classic.socrates.handle("Continue.");
    expect(contextText(classic.model.requests[0]!)).not.toContain("<ACCESS>");
  });

  it("keeps outside-folder grants across compound parts, and expires them at the next message", async () => {
    const outside = tempDir();
    writeFiles(outside, { "one.md": "one", "two.md": "two" });
    const w = await world();
    const part = (order: number, extra: object) => ({ order, request: `Read outside part ${order}`, depends_on: order === 2 ? [1] : [], goal_label: "current", new_goal_title: null, task_label: null, new_task_title: null, workspace_confidence: "high", reason: "test", ...extra });
    const route = { text: decision({ decision: "compound", workspace_confidence: null, parts: [
      part(1, { decision: "continue_current", task_decision: "continue_task", task_label: "current" }),
      part(2, { decision: "continue_current", task_decision: "create_task", new_task_title: "Read second", ...defineTask("Read second") }),
    ] as never }) };
    const { socrates } = w.socrates([route, continueTask()], [
      { toolCalls: [call("glob", { path: outside, pattern: "*.md" })] }, final(),
      { toolCalls: [call("read", { path: path.join(outside, "two.md") })] }, final(),
      { toolCalls: [call("read", { path: path.join(outside, "one.md") })] }, final(),
    ], { access: () => ({ folders: [w.root], approvals: "auto", protected: [] }) });
    const first = await socrates.handle("Read outside part 1, then Read outside part 2.");
    expect(first).toMatchObject({ kind: "answered", parts: [{ status: "completed" }, { status: "completed" }] });
    expect(w.approvals.map(a => a.kind)).toEqual(["outside_folder"]);
    expect(await socrates.handle("Read the first one again.")).toMatchObject({ kind: "answered", parts: [{ status: "completed", toolCalls: 1 }] });
    expect(w.approvals.map(a => a.kind)).toEqual(["outside_folder", "outside_folder"]);
  });

  it("omits automatic anchor content and hash reads after workspace access is revoked", async () => {
    const w = await world({ files: { "plan.md": "PRIVATE-CONTEXT-SENTINEL", "other.md": "PRIVATE-PROPOSAL-SENTINEL" } });
    w.store.upsertAnchor({ goalId: w.goalId, path: "plan.md", role: "goal_plan", summary: "", status: "active" });
    const { socrates, model } = w.socrates([continueTask()], [final({ anchors: [{ path: "other.md", role: "reference", reason: "Useful reference." }] })], { access: () => ({ folders: [], approvals: "auto", protected: [] }) });
    await socrates.handle("Continue the project.");
    expect(contextText(model.requests[0]!)).not.toContain("PRIVATE-CONTEXT-SENTINEL");
    expect(w.store.listAnchors(w.goalId).map(a => a.path)).toEqual(["plan.md"]);
    expect(w.approvals).toEqual([]);
    expect(w.store.listEvents({ type: "agent_warning" }).some(e => JSON.stringify(e.payload).includes("excluded by file access"))).toBe(true);
  });
  it("starts the general conversation in the working folder each turn without binding it", async () => {
    const w = await world({ files: { "notes.md": "GENERAL-READ-SENTINEL" } });
    const { socrates, model } = w.socrates([general()], [
      { toolCalls: [call("read", { path: "notes.md" })] },
      { toolCalls: [call("terminal", { command: "echo TERMINAL-$((40+2))" })] },
      final(),
    ], { access: () => ({ folders: [w.root], approvals: "auto", protected: [] }), resolveWorkspace: () => ({ name: "work", rootPath: w.root }) });
    await socrates.handle("Read my notes and run a quick command.");
    expect(contextText(model.requests[0]!)).toContain(`starts in: ${realpathSync(w.root)}.`);
    expect(JSON.stringify(model.requests[1]!.messages.at(-1)!.content)).toContain("GENERAL-READ-SENTINEL");
    expect(JSON.stringify(model.requests[2]!.messages.at(-1)!.content)).toContain("TERMINAL-42");
    expect(w.approvals).toEqual([]);
    expect(w.store.getGeneralGoal()!.workspaceId).toBeNull();
  });

  it("works with no workspace at all: it starts in the home folder and asks before every path outside the user's folders", async () => {
    const outside = tempDir();
    writeFiles(outside, { "todo.md": "OUTSIDE-READ-SENTINEL" });
    const w = await world({ workspace: false });
    const { socrates, model } = w.socrates([continueTask()], [
      { toolCalls: [call("read", { path: path.join(outside, "todo.md") })] },
      { toolCalls: [call("terminal", { command: "echo TERMINAL-$((40+2))" })] },
      final(),
    ], { access: () => ({ folders: [], approvals: "ask", protected: [] }) });
    await socrates.handle("Read my todo and run a quick command.");
    expect(contextText(model.requests[0]!)).toContain(`starts in: ${realpathSync(homedir())}.`);
    expect(JSON.stringify(model.requests[1]!.messages.at(-1)!.content)).toContain("OUTSIDE-READ-SENTINEL");
    expect(JSON.stringify(model.requests[2]!.messages.at(-1)!.content)).toContain("TERMINAL-42");
    expect(w.approvals.map((a) => a.kind).sort()).toEqual(["action", "outside_folder", "outside_folder"]);
    expect(w.store.requireGoal(w.goalId).workspaceId).toBeNull();
  });
});
