import { readFileSync } from "node:fs";
import path from "node:path";
import { countTokens } from "@socrates/shared";
import { describe, expect, it } from "vitest";
import { OutputArchive, type ArchiveLimits } from "../src/output-archive";
import { harness, tempDir } from "./helpers";

/** T1 (docs/terminal-output-and-memory.md): terminal output saved by id, scoped to its run, read back by line or search. */

const ORIGIN = { by: "agent" as const, goalId: null, taskId: null, chatId: null, turnId: null, label: null };

function withArchive(limits: Partial<ArchiveLimits> = {}, extra: Parameters<typeof harness>[0] = {}) {
  const dir = path.join(tempDir("socrates-outputs-"), "terminal");
  let clock = new Date("2026-10-11T10:00:00Z");
  const archive = new OutputArchive(dir, () => ({ retentionDays: 15, totalCapBytes: 1024 ** 3, perOutputCapBytes: 100 * 1024 ** 2, ...limits }), () => clock);
  const h = harness({ ...extra, terminals: { archive, ...(extra.terminals ?? {}) } });
  return { h, archive, dir, setClock: (d: Date) => { clock = d; } };
}

/** A second chat in its own task, as Standard mode makes. */
function otherChat(h: ReturnType<typeof harness>, title: string) {
  const task = h.store.createTask(h.binding.goalId, { title, objective: title });
  const user = h.store.recordUserMessage(`Work on ${title}.`);
  const turn = h.store.bindTurn({ userEventId: user.id, taskId: task.id, route: "continue_current", gateArmed: false, workspaceConfidence: "high" });
  return { goalId: h.binding.goalId, taskId: task.id, chatId: turn.chatId, turnId: turn.id };
}

describe.skipIf(process.platform === "win32")("saved terminal output", () => {
  it("saves a huge output by id, previews it within the preview budget, and finds the middle by search and line", async () => {
    const { h } = withArchive();
    const r = await h.call("terminal", { command: "node -e \"for (let i = 1; i <= 60000; i++) console.log(i === 31337 ? 'IMPORTANT-MARKER failure here' : 'line ' + i)\"" });
    expect(r.json).toMatchObject({ status: "completed", exit_code: 0, truncated: true, output_id: expect.stringMatching(/^out_[0-9a-f]{12}$/), output_lines: 60000 });
    expect(r.json.output).not.toContain("IMPORTANT-MARKER");
    expect(r.json.output).toContain(`saved as ${r.json.output_id}`);
    // The preview is held to the default 4,500 tokens, well under the 10,000 ceiling.
    expect(countTokens(r.json.output)).toBeLessThanOrEqual(4_600);
    // The event log keeps the preview and the id, not the whole text.
    const done = h.store.listEvents({ type: "tool_completed" }).at(-1)!;
    expect(JSON.stringify(done.payload)).not.toContain("line 30000");
    expect(JSON.stringify(done.payload)).not.toContain("output_full");
    expect(h.store.listEvents({ type: "terminal_started" }).at(-1)!.payload).toMatchObject({ output_id: r.json.output_id });

    const found = await h.call("terminal_control", { action: "read", output: r.json.output_id, search: "important-marker" });
    expect(found.json).toMatchObject({ output_id: r.json.output_id, saved: "complete", total_lines: 60000, more_matches: false, scanned_lines: 60000 });
    expect(found.json.matches).toEqual([{ line: 31337, text: "IMPORTANT-MARKER failure here", before: "line 31336", after: "line 31338" }]);
    expect(found.json.source).toContain("started by you, in this turn");
    // filter takes a regular expression, as it does for a live session.
    const filtered = await h.call("terminal_control", { action: "read", output: r.json.output_id, filter: "(ERROR|IMPORTANT-MARKER)" });
    expect(filtered.json).toMatchObject({ filter: "(ERROR|IMPORTANT-MARKER)", matches: [{ line: 31337 }] });
    expect((await h.call("terminal_control", { action: "read", output: r.json.output_id, filter: "x", search: "y" })).json.error.code).toBe("invalid_parameters");

    const page = await h.call("terminal_control", { action: "read", output: r.json.output_id, from_line: 31336, limit_lines: 3 });
    expect(page.json).toMatchObject({ from_line: 31336, lines_shown: 3, output: "line 31336\nIMPORTANT-MARKER failure here\nline 31338\n", next_line: 31339 });

    // Inspecting the call later reads the saved output, and points to the rest.
    const inspected = await h.call("context_retrieve", { action: "inspect", ref: r.handle });
    expect(inspected.json.output.content).toContain(`saved output ${r.json.output_id}: 60000 lines`);
    expect(inspected.json.output.content).toContain("line 1\n");
    expect(inspected.json.output.content).toContain("line 60000");
  });

  it("keeps short output whole and uses the configured preview budget", async () => {
    const { h } = withArchive({}, { terminals: { previewTokens: () => 4_000 } });
    const short = await h.call("terminal", { command: "echo hi" });
    expect(short.json).toMatchObject({ output: "hi\n", truncated: false, output_lines: 1 });
    const long = await h.call("terminal", { command: "seq 1 40000" });
    expect(countTokens(long.json.output)).toBeLessThanOrEqual(4_100);
  });

  it("labels output by whose run it is, so another chat's run is never taken for this one", async () => {
    const { h } = withArchive();
    const a = await h.call("terminal", { command: "echo from-chat-A; echo ok" });
    const chatB = otherChat(h, "Fix the login page");
    const b = await h.call("terminal", { command: "echo from-chat-B" }, { binding: chatB });
    expect(a.json.output_id).not.toBe(b.json.output_id);

    // Chat B reads its own run as its own, and chat A's as another chat's, by title.
    const ownB = await h.call("terminal_control", { action: "read", output: b.json.output_id }, { binding: chatB });
    expect(ownB.json).toMatchObject({ output: "from-chat-B\n" });
    expect(ownB.json.source).toContain("started by you, in this turn");
    const crossed = await h.call("terminal_control", { action: "read", output: a.json.output_id }, { binding: chatB });
    expect(crossed.json.output).toBe("from-chat-A\nok\n");
    expect(crossed.json.source).toContain('started by another chat ("Fix the server"');

    // A later turn of chat A sees its earlier run as its own.
    h.nextTurn();
    const later = await h.call("terminal_control", { action: "read", output: a.json.output_id });
    expect(later.json.source).toContain("started by you, earlier in this chat");
  });

  it("gives a restarted tab a new output id, and refuses an old cursor instead of reading the new run", async () => {
    const { h } = withArchive();
    const first = await h.call("terminal", { command: "echo first-run; sleep 30", background: true, name: "svc", ready: { pattern: "first-run" } });
    const oldCursor = `${first.json.session_id}:c0`;
    const restarted = await h.call("terminal_control", { action: "restart", terminal: "svc" });
    expect(restarted.json.output_id).not.toBe(first.json.output_id);
    expect(restarted.json.cursor).toMatch(new RegExp(`^${restarted.json.session_id}:c\\d+$`));

    const refused = await h.call("terminal_control", { action: "read", terminal: "svc", cursor: oldCursor });
    expect(refused.json.error.code).toBe("cursor_other_run");
    expect(refused.json.error.hint ?? refused.json.error.next_step ?? JSON.stringify(refused.json.error)).toContain(first.json.output_id);
    const earlier = await h.call("terminal_control", { action: "read", output: first.json.output_id });
    expect(earlier.json).toMatchObject({ output: "first-run\n" });
    expect(earlier.json.source).toMatch(/· stopped$/);

    const list = await h.call("terminal_control", { action: "list" });
    expect(list.json.terminals[0]).toMatchObject({ terminal: "svc", output_id: restarted.json.output_id, started_by: "you, in this turn" });
    await h.call("terminal_control", { action: "terminate", terminal: "svc" });
  });

  it("labels a shell the user opened as the user's", async () => {
    const { h } = withArchive();
    const supervisor = h.runner.terminals(h.workspace);
    const session = supervisor.launch({ command: "/bin/sh", shell: "/bin/sh", cwd: h.root, cwdRel: ".", env: {}, timeoutMs: null, background: true, name: "Shell 1", ready: null, pty: null, origin: null, owner: { goalId: h.binding.goalId, taskId: h.binding.taskId, chatId: null, turnId: null } }, { onStart() {}, onExit() {} });
    const list = await h.call("terminal_control", { action: "list" });
    expect(list.json.terminals.find((t: { terminal: string }) => t.terminal === "Shell 1")).toMatchObject({ started_by: "the user, in the terminal panel", output_id: session.outputId });
    await supervisor.terminate(session);
  });

  it("refuses output saved in a folder this work may not read, and explains removed output", async () => {
    let root = "";
    const { h, archive } = withArchive({}, { access: () => ({ folders: [root], approvals: "auto", protected: [] }) });
    root = h.root;
    const elsewhere = archive.begin({ workspace: "/somewhere/else", session_id: "term-999", name: null, command: "cat secrets", cwd: "/somewhere/else", pty: false, background: false, origin: ORIGIN })!;
    elsewhere.write("secret\n");
    elsewhere.end({ exit_code: 0, signal: null, reason: "exited" });
    const refused = await h.call("terminal_control", { action: "read", output: elsewhere.id });
    expect(refused.json.error.code).toBe("output_out_of_scope");
    expect(refused.content).not.toContain("secret\\n");

    const r = await h.call("terminal", { command: "echo keep" });
    const meta = archive.meta(r.json.output_id)!;
    archive.saveMeta({ ...meta, ended_at: "2026-09-01T00:00:00Z" });
    expect(archive.sweep()).toMatchObject({ removed: 1 });
    const removed = await h.call("terminal_control", { action: "read", output: r.json.output_id });
    expect(removed.json.error.code).toBe("output_removed");
    expect(removed.json.error.message).toContain("age limit");
    const unknown = await h.call("terminal_control", { action: "read", output: "out_000000000000" });
    expect(unknown.json.error.code).toBe("output_not_found");
    expect((await h.call("terminal_control", { action: "read", output: r.json.output_id, cursor: "c0" })).json.error.code).toBe("invalid_parameters");
    expect((await h.call("terminal_control", { action: "read", terminal: "x", from_line: 2 })).json.error.code).toBe("invalid_parameters");
  });

  it("stops saving past the per-output cap without stopping the command, and says so", async () => {
    const { h } = withArchive({ perOutputCapBytes: 2_000 });
    const r = await h.call("terminal", { command: "seq 1 5000; echo still-running-after-cap" });
    expect(r.json).toMatchObject({ status: "completed", exit_code: 0, output_saved: "partly: saving stopped at the size limit for one output" });
    // The run went on: its end is in the preview, from memory.
    expect(r.json.output).toContain("still-running-after-cap");
    const done = h.store.listEvents({ type: "tool_completed" }).at(-1)!;
    expect(JSON.stringify(done.payload)).not.toContain("output_full");
    const page = await h.call("terminal_control", { action: "read", output: r.json.output_id, from_line: 1, limit_lines: 2 });
    expect(page.json).toMatchObject({ output: "1\n2\n", saved: "partly: saving stopped at the size limit for one output" });
  });
});

describe("the output archive", () => {
  const limits = (l: Partial<ArchiveLimits> = {}) => () => ({ retentionDays: 15, totalCapBytes: 10_000, perOutputCapBytes: 100_000, ...l });

  it("cleans up by age, then oldest first by total size, never running output, and keeps metadata as a tombstone", () => {
    const dir = tempDir();
    let now = new Date("2026-10-01T00:00:00Z");
    const archive = new OutputArchive(dir, limits({ totalCapBytes: 13_000 }), () => now);
    const make = (text: string, endedAt: string | null) => {
      const c = archive.begin({ workspace: dir, session_id: "term-1", name: null, command: "x", cwd: dir, pty: false, background: false, origin: ORIGIN })!;
      c.write(text);
      if (endedAt) { c.end({ exit_code: 0, signal: null, reason: "exited" }); archive.saveMeta({ ...archive.meta(c.id)!, ended_at: endedAt }); }
      return c.id;
    };
    const old = make("a".repeat(100), "2026-09-01T00:00:00Z");
    const older = make("b".repeat(6_000), "2026-09-28T00:00:00Z");
    const newer = make("c".repeat(6_000), "2026-09-30T00:00:00Z");
    const running = make("d".repeat(6_000), null);
    expect(archive.sweep(new Set([running]))).toEqual({ removed: 2, freed: 6_100 });
    expect(archive.meta(old)).toMatchObject({ removed_reason: "age" });
    expect(archive.meta(older)).toMatchObject({ removed_reason: "space" });
    expect(archive.available(newer)).toBe(true);
    expect(archive.available(running)).toBe(true);
    // Tombstones go after 90 days.
    now = new Date("2027-02-01T00:00:00Z");
    archive.sweep(new Set([running]));
    expect(archive.meta(old)).toBeNull();
  });

  it("marks output the app was not there to see end as interrupted", () => {
    const dir = tempDir();
    const first = new OutputArchive(dir, limits());
    const c = first.begin({ workspace: dir, session_id: "term-1", name: null, command: "npm run dev", cwd: dir, pty: false, background: true, origin: ORIGIN })!;
    c.write("listening\n");
    const after = new OutputArchive(dir, limits());
    expect(after.recoverInterrupted()).toBe(1);
    expect(after.meta(c.id)).toMatchObject({ complete: false, gap: "interrupted", lines: 1 });
    expect(after.readLines(c.id, 1, 10, 1_000).text).toBe("listening\n");
  });

  it("reads a line longer than a page in part, counts a last line without a newline, and keeps Unicode intact", () => {
    const dir = tempDir();
    const archive = new OutputArchive(dir, limits({ perOutputCapBytes: 50 * 1024 * 1024 }));
    const c = archive.begin({ workspace: dir, session_id: "term-1", name: null, command: "x", cwd: dir, pty: false, background: false, origin: ORIGIN })!;
    c.write("x".repeat(5 * 1024 * 1024));
    c.write("\nnaïve 😀 ünïcode\nEND");
    c.end({ exit_code: 0, signal: null, reason: "exited" });
    expect(archive.meta(c.id)).toMatchObject({ lines: 3, complete: true });
    const first = archive.readLines(c.id, 1, 10, 500);
    expect(first.lines_shown).toBe(1);
    expect(first.next_line).toBe(2);
    expect(first.text).toContain("line cut");
    expect(archive.readLines(c.id, 2, 10, 500)).toMatchObject({ text: "naïve 😀 ünïcode\nEND", lines_shown: 2, next_line: null });
    expect(archive.search(c.id, "😀", 10, 1_000).hits).toEqual([{ line: 2, text: "naïve 😀 ünïcode", before: expect.stringMatching(/^x+…$/), after: "END" }]);
    expect(readFileSync(path.join(dir, c.id, "output.log"), "utf8").endsWith("ünïcode\nEND")).toBe(true);
    const excerpt = archive.excerpt(c.id, 300, "read the rest");
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.text).toContain("END");
  });
});
