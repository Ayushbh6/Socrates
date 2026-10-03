import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixedClock } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { type ApprovalRequest, RunState, ToolRunner } from "@socrates/tools";
import { afterEach, describe, expect, it } from "vitest";
import { InstalledCatalog, MCP_RETRY_AFTER_MS, loadSkill, readMcpConfig, scanSkills } from "../src";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture-server.ts");
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

function home(files: Record<string, string> = {}): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "socrates-home-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function store(): LedgerStore {
  const s = LedgerStore.open({ path: ":memory:", clock: fixedClock("2026-10-01T10:00:00Z") });
  cleanups.push(() => s.close());
  return s;
}

const tracker = (notes: string, extra: object = {}) => ({ command: process.execPath, args: [TSX, FIXTURE], env: { FIXTURE_NOTES: notes }, ...extra });
const mcpJson = (servers: Record<string, unknown>) => JSON.stringify({ mcpServers: servers });

async function open(options: Parameters<typeof InstalledCatalog.open>[0]): Promise<InstalledCatalog> {
  const catalog = await InstalledCatalog.open(options);
  cleanups.push(() => catalog.close());
  return catalog;
}

const SKILL = "---\nname: release-notes\ndescription: Write release notes from merged changes.\ntags: [changelog]\ndependencies: [tracker.ticket_get]\n---\n\n# Release notes\nStart with RELEASE NOTES.\n";

describe("Skills", () => {
  it("reads valid Skills and skips invalid folders with a reason", () => {
    const dir = home({
      "skills/release-notes/SKILL.md": SKILL,
      "skills/wrong-name/SKILL.md": "---\nname: other\ndescription: x\n---\nbody",
      "skills/no-description/SKILL.md": "---\nname: no-description\n---\nbody",
      "skills/bad-yaml/SKILL.md": "---\nname: [unclosed\n---\nbody",
      "skills/plain/SKILL.md": "No frontmatter here.",
      "skills/notes-only/README.md": "not a Skill",
    });
    const scan = scanSkills(path.join(dir, "skills"));
    expect(scan.skills.map((s) => s.name)).toEqual(["release-notes"]);
    expect(scan.skills[0]).toMatchObject({ description: "Write release notes from merged changes.", tags: ["changelog"] });
    expect(scan.problems.sort()).toEqual([
      expect.stringContaining("bad-yaml skipped: its frontmatter is not valid YAML"),
      expect.stringContaining("no-description skipped: its frontmatter description is missing"),
      expect.stringContaining("plain skipped: it does not start with a --- frontmatter block"),
      expect.stringContaining("wrong-name skipped: its name other does not match its folder wrong-name"),
    ]);
    expect(scanSkills(path.join(dir, "absent"))).toEqual({ skills: [], problems: [] });
  });

  it("loads the body as instructions and versions the exact file", () => {
    const dir = home({ "skills/release-notes/SKILL.md": SKILL });
    const skill = scanSkills(path.join(dir, "skills")).skills[0]!;
    const loaded = loadSkill(skill);
    expect(loaded).toMatchObject({ instructions: "# Release notes\nStart with RELEASE NOTES.", dependencies: ["tracker.ticket_get"], resourceBase: { kind: "directory", path: skill.dir } });
    writeFileSync(path.join(skill.dir, "SKILL.md"), SKILL.replace("Start with", "Begin with"));
    expect(loadSkill(skill).version).not.toBe(loaded.version);
  });
});

describe("mcp.json", () => {
  it("reads stdio and HTTP servers, expands environment references, and skips invalid servers", () => {
    const dir = home({
      "mcp.json": JSON.stringify({
        mcpServers: {
          local: { command: "${TOOL_BIN}/server", args: ["--root", "${ROOT}"], env: { TOKEN: "${SECRET}" } },
          remote: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer ${REMOTE_TOKEN}" } },
          off: { url: "https://example.test/off", disabled: true },
          broken: { args: ["no command or url"] },
          sse: { command: "" },
        },
      }),
    });
    const { servers, problems } = readMcpConfig(path.join(dir, "mcp.json"), { TOOL_BIN: "/opt/bin", ROOT: "/data", SECRET: "s3" });
    expect(servers).toEqual([
      { name: "local", transport: "stdio", command: "/opt/bin/server", args: ["--root", "/data"], env: { TOKEN: "s3" }, disabled: false, missingEnv: [] },
      { name: "remote", transport: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer " }, disabled: false, missingEnv: ["REMOTE_TOKEN"] },
      { name: "off", transport: "http", url: "https://example.test/off", headers: {}, disabled: true, missingEnv: [] },
    ]);
    expect(problems).toEqual([expect.stringContaining("MCP server broken skipped"), expect.stringContaining("MCP server sse skipped")]);
    expect(readMcpConfig(path.join(dir, "absent.json"))).toEqual({ servers: [], problems: [] });
    writeFileSync(path.join(dir, "mcp.json"), "{ not json");
    expect(readMcpConfig(path.join(dir, "mcp.json")).problems[0]).toContain("is not valid JSON");
  });
});

describe("InstalledCatalog", () => {
  it("connects a server when first needed: on open only while its tools are unknown, and closes it", { timeout: 30_000 }, async () => {
    const dir = home();
    const starts = path.join(dir, "starts.txt");
    const count = () => readFileSync(starts, "utf8").split("\n").filter(Boolean).length;
    writeFileSync(path.join(dir, "mcp.json"), mcpJson({ tracker: tracker(path.join(dir, "notes.txt"), { env: { FIXTURE_NOTES: path.join(dir, "notes.txt"), FIXTURE_STARTS: starts } }) }));
    const s = store();
    // Unknown tools: opening connects once so they can be found.
    await (await open({ store: s, home: dir })).close();
    expect(count()).toBe(1);
    // Known tools: search works from the recorded list and nothing is launched until use.
    const catalog = await open({ store: s, home: dir });
    expect(catalog.entries().filter((e) => e.kind === "mcp")).toHaveLength(5);
    expect(count()).toBe(1);
    await catalog.loadMcpTool("tracker.ticket_get");
    await catalog.loadMcpTool("tracker.note_add");
    expect(count()).toBe(2);
  });

  it("indexes a stdio server's tools/list as a snapshot and calls its tools", { timeout: 30_000 }, async () => {
    const dir = home({ "skills/release-notes/SKILL.md": SKILL });
    const notes = path.join(dir, "notes.txt");
    writeFileSync(path.join(dir, "mcp.json"), mcpJson({ tracker: tracker(notes) }));
    const s = store();
    const catalog = await open({ store: s, home: dir });

    const entries = catalog.entries();
    expect(entries.map((e) => `${e.kind}:${e.name}:${e.availability}`)).toEqual([
      "skill:release-notes:available",
      "mcp:tracker.migrate_ticket_schema:available",
      "mcp:tracker.note_add:available",
      "mcp:tracker.note_list:available",
      "mcp:tracker.reveal_extra:available",
      "mcp:tracker.ticket_get:available",
    ]);
    expect(entries.find((e) => e.name === "tracker.ticket_get")).toMatchObject({ server: "tracker", tool: "ticket_get", readOnly: true });
    expect(entries.find((e) => e.name === "tracker.note_add")).toMatchObject({ readOnly: false });
    expect(s.listEvents({ type: "mcp_tools_listed" })).toHaveLength(1);

    const tool = await catalog.loadMcpTool("tracker.ticket_get", { fresh: true });
    expect(tool).toMatchObject({ connection: "connected", readOnly: true, inputSchema: { type: "object", required: ["id"] } });
    const signal = new AbortController().signal;
    expect(await catalog.callMcpTool("tracker.ticket_get", { id: "42" }, signal)).toMatchObject({ isError: false, content: expect.stringContaining("lantern-7") });
    expect(await catalog.callMcpTool("tracker.ticket_get", { id: "9" }, signal)).toEqual({ isError: true, content: "No ticket 9." });
    expect(await catalog.callMcpTool("tracker.note_add", { text: "first" }, signal)).toEqual({ isError: false, content: "Saved note #1." });
    expect(readFileSync(notes, "utf8")).toBe("first\n");
    // A protocol error is the tool's error result, not an unreachable server.
    expect(await catalog.callMcpTool("tracker.note_add", {}, signal)).toMatchObject({ isError: true });
    await expect(catalog.callMcpTool("other.tool", {}, signal)).rejects.toThrow("No configured MCP server provides other.tool");

    // tools/list_changed refreshes the listing and records a new snapshot.
    await catalog.callMcpTool("tracker.reveal_extra", {}, signal);
    await expect.poll(() => catalog.entries().some((e) => e.name === "tracker.extra_echo"), { timeout: 5_000 }).toBe(true);
    expect(s.listEvents({ type: "mcp_tools_listed" })).toHaveLength(2);
  });

  it("keeps a recorded server searchable while it cannot be reached, and backs off before reconnecting", { timeout: 30_000 }, async () => {
    const dir = home();
    const s = store();
    writeFileSync(path.join(dir, "mcp.json"), mcpJson({ tracker: tracker(path.join(dir, "notes.txt")) }));
    await (await open({ store: s, home: dir })).close();

    // The same server, now broken: its recorded tools stay searchable, reported offline.
    writeFileSync(path.join(dir, "mcp.json"), mcpJson({ tracker: { command: path.join(dir, "missing-binary") } }));
    let now = 1_000_000;
    const logs: string[] = [];
    const catalog = await open({ store: s, home: dir, now: () => now, log: (m) => logs.push(m) });
    // A recorded server is not connected on open; the first use tries and fails.
    expect(new Set(catalog.entries().map((e) => e.availability))).toEqual(new Set(["available"]));
    await expect(catalog.loadMcpTool("tracker.ticket_get")).rejects.toThrow();
    expect(new Set(catalog.entries().map((e) => e.availability))).toEqual(new Set(["offline"]));
    expect(logs.some((l) => l.includes("MCP server tracker: connection failed"))).toBe(true);
    await expect(catalog.loadMcpTool("tracker.ticket_get")).rejects.toThrow("offline");
    now += MCP_RETRY_AFTER_MS;
    expect(new Set(catalog.entries().map((e) => e.availability))).toEqual(new Set(["available"]));
    await expect(catalog.loadMcpTool("tracker.ticket_get")).rejects.toThrow();
    expect(new Set(catalog.entries().map((e) => e.availability))).toEqual(new Set(["offline"]));
  });

  it("reports missing secrets, refused credentials, and disabled servers without exposing them", { timeout: 30_000 }, async () => {
    const dir = home();
    const s = store();
    const http = createServer((_, res) => res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}'));
    await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
    cleanups.push(() => new Promise<void>((done) => http.close(() => done())));
    const port = (http.address() as { port: number }).port;
    for (const [name, payload] of [["needs-env", "a"], ["refused", "b"], ["off", "c"]] as const) {
      s.recordMcpToolSnapshot({ server: name, digest: payload, tools: [{ name: "get", description: "Get a thing.", read_only: true, input_schema: { type: "object" } }] });
    }
    writeFileSync(path.join(dir, "mcp.json"), mcpJson({
      "needs-env": { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer ${SOCRATES_TEST_ABSENT_TOKEN}" } },
      refused: { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer wrong" } },
      off: { url: `http://127.0.0.1:${port}/mcp`, disabled: true },
    }));
    const logs: string[] = [];
    const catalog = await open({ store: s, home: dir, env: {}, log: (m) => logs.push(m) });
    // Recorded servers connect on first use; the refused one learns it needs credentials then.
    await expect(catalog.loadMcpTool("refused.get")).rejects.toThrow();
    expect(Object.fromEntries(catalog.entries().map((e) => [e.name, e.availability]))).toEqual({ "needs-env.get": "authentication_required", "refused.get": "authentication_required", "off.get": "disabled" });
    expect(logs).toContain("MCP server needs-env needs the environment variables SOCRATES_TEST_ABSENT_TOKEN.");
    expect(logs.join("\n")).not.toContain("wrong");
  });

  it("serves capability search, activation, approval, and calls through the tool runner", { timeout: 30_000 }, async () => {
    const dir = home({ "skills/release-notes/SKILL.md": SKILL });
    writeFileSync(path.join(dir, "mcp.json"), mcpJson({ tracker: tracker(path.join(dir, "notes.txt")) }));
    const s = store();
    const catalog = await open({ store: s, home: dir });
    const approvals: ApprovalRequest[] = [];
    const runner = new ToolRunner({ store: s, timeZone: "UTC", catalog, approve: async (r) => (approvals.push(r), true) });
    cleanups.push(() => runner.close());
    const goal = s.createGoal({ title: "Tracker work", objective: "Handle tickets." });
    const task = s.createTask(goal.id, { title: "Ticket 42", objective: "Fix it." });
    const turn = s.bindTurn({ userEventId: s.recordUserMessage("Fix ticket 42").id, taskId: task.id, route: "continue_current", gateArmed: false, workspaceConfidence: "high" });
    const scope = { binding: { goalId: goal.id, taskId: task.id, chatId: turn.chatId, turnId: turn.id }, workspace: null, run: new RunState(), signal: new AbortController().signal };
    let n = 0;
    const call = async (name: string, input: unknown) => JSON.parse((await runner.run({ id: `call${++n}`, name, input }, scope)).content);

    const found = await call("capability_search", { query: "tracker ticket", kind: "mcp" });
    const ticket = found.matches.find((m: { name: string }) => m.name === "tracker.ticket_get");
    expect(await call("capability_control", { action: "activate", ref: ticket.ref })).toMatchObject({ status: "activated", public_name: "mcp__tracker__ticket_get", connection: "connected" });
    expect((await runner.mcpDefinitions(goal.id)).map((d) => d.name)).toEqual(["mcp__tracker__ticket_get"]);
    expect((await runner.run({ id: "t1", name: "mcp__tracker__ticket_get", input: { id: "42" } }, scope)).content).toContain("lantern-7");
    expect(approvals).toEqual([]);

    const add = (await call("capability_search", { query: "tracker.note_add" })).matches[0];
    await call("capability_control", { action: "activate", ref: add.ref });
    await runner.run({ id: "a1", name: "mcp__tracker__note_add", input: { text: "one" } }, scope);
    await runner.run({ id: "a2", name: "mcp__tracker__note_add", input: { text: "two" } }, scope);
    expect(approvals.map((a) => a.kind)).toEqual(["mcp_tool"]);

    const skill = (await call("capability_search", { query: "release-notes", kind: "skill" })).matches[0];
    expect(await call("capability_control", { action: "activate", ref: skill.ref })).toMatchObject({ status: "activated", instructions: "# Release notes\nStart with RELEASE NOTES.", dependencies: [{ kind: "mcp", name: "tracker.ticket_get", status: "active" }] });
    expect(runner.capabilities.current(goal.id)).toEqual({ skills: [{ name: "release-notes", instructions: "# Release notes\nStart with RELEASE NOTES." }], mcpTools: ["mcp__tracker__note_add", "mcp__tracker__ticket_get"] });
  });
});

describe("MCP schema changes", () => {
  it("replaces an active tool's schema after the server changes it, and never runs the old one", { timeout: 30_000 }, async () => {
    const dir = home();
    writeFileSync(path.join(dir, "mcp.json"), mcpJson({ tracker: tracker(path.join(dir, "notes.txt")) }));
    const s = store();
    const catalog = await open({ store: s, home: dir });
    const runner = new ToolRunner({ store: s, timeZone: "UTC", catalog, approve: async () => true });
    cleanups.push(() => runner.close());
    const goal = s.createGoal({ title: "Tracker work", objective: "Handle tickets." });
    const task = s.createTask(goal.id, { title: "Ticket 42", objective: "Fix it." });
    const turn = s.bindTurn({ userEventId: s.recordUserMessage("Fix ticket 42").id, taskId: task.id, route: "continue_current", gateArmed: false, workspaceConfidence: "high" });
    const scope = { binding: { goalId: goal.id, taskId: task.id, chatId: turn.chatId, turnId: turn.id }, workspace: null, run: new RunState(), signal: new AbortController().signal };
    const ref = JSON.parse((await runner.run({ id: "s", name: "capability_search", input: { query: "tracker.ticket_get" } }, scope)).content).matches[0].ref;
    await runner.run({ id: "a", name: "capability_control", input: { action: "activate", ref } }, scope);
    const before = s.listActiveCapabilities(goal.id)[0]!.digest;

    await catalog.callMcpTool("tracker.migrate_ticket_schema", {}, new AbortController().signal);
    await expect.poll(() => s.listEvents({ type: "mcp_tools_listed" }).length, { timeout: 5_000 }).toBe(2);
    // A call with the old schema fails closed instead of reaching the changed tool.
    const stale = JSON.parse((await runner.run({ id: "c1", name: "mcp__tracker__ticket_get", input: { id: "42" } }, scope)).content);
    expect(stale.error.code).toBe("tool_schema_changed");
    // The next request carries the one replacement schema, recorded with its new digest.
    const [definition] = await runner.mcpDefinitions(goal.id);
    expect(Object.keys(definition!.inputSchema.properties as object)).toEqual(["ticket_id"]);
    expect(s.listActiveCapabilities(goal.id)[0]!.digest).not.toBe(before);
    expect((await runner.run({ id: "c2", name: "mcp__tracker__ticket_get", input: { ticket_id: "42" } }, scope)).content).toContain("lantern-7");
  });
});
