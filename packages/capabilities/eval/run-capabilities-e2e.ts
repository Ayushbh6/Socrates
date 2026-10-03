/** Live acceptance run of the capabilities stage: a real router and agent
 * model work through Socrates.handle with installed global Skills and a real
 * stdio MCP server (the SDK-built tracker fixture). It covers the frozen Skill
 * shelf, per-turn candidates, activating and calling an MCP tool in the same
 * turn, following a Skill, approval once per MCP tool per goal, Skill
 * instructions carried once, restart with a fresh server process, and
 * event-only replay. Only synthetic fixture content reaches the provider. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type EventPayloads, type ModelClient, type ModelRequest, userText } from "@socrates/contracts";
import { makeModel, PROVIDER_DEFAULTS, type Provider } from "@socrates/providers";
import { LedgerStore } from "@socrates/store";
import type { ApprovalRequest } from "@socrates/tools";
import { type HandleResult, Socrates } from "@socrates/agent";
import { loadEvaluationEnvironment } from "../../router/eval/environment";
import { InstalledCatalog } from "../src";

loadEvaluationEnvironment();
const provider = process.env.SOCRATES_PROVIDER ?? "gemini";
const defaults = PROVIDER_DEFAULTS[provider as Provider];
if (!defaults) throw new Error("Unknown evaluation provider.");
const main = makeModel(provider, process.env.SOCRATES_MAIN_MODEL ?? defaults.main);
const routerModel = makeModel(provider, process.env.SOCRATES_ROUTER_MODEL ?? defaults.router);

const base = fileURLToPath(new URL("../../../.socrates/evals/", import.meta.url));
mkdirSync(base, { recursive: true });
const dir = realpathSync(mkdtempSync(path.join(base, `capabilities-${provider}-`)));
const home = path.join(dir, "home");
const root = path.join(dir, "shop");
const notes = path.join(dir, "tracker-notes.txt");
const SIGNATURE = "Signed: Socrates release desk";
const files: Record<string, string> = {
  "home/skills/release-notes/SKILL.md": `---\nname: release-notes\ndescription: Write release notes for a fix or a set of merged changes, in the team's house format.\n---\n\n# Release notes\n\nWhen you write release notes:\n1. Start with the line "RELEASE NOTES" followed by the ticket id when there is one.\n2. List each change as a bullet that starts with "Fixed:", "Added:" or "Changed:".\n3. End with the exact line "${SIGNATURE}".\n`,
  "home/skills/pdf/SKILL.md": "---\nname: pdf\ndescription: Read, render, inspect, and create PDF files.\n---\n\nUse a PDF library to read or write PDF files.\n",
  "home/mcp.json": JSON.stringify({ mcpServers: { tracker: { command: process.execPath, args: [createRequire(import.meta.url).resolve("tsx/cli"), fileURLToPath(new URL("../test/fixture-server.ts", import.meta.url))], env: { FIXTURE_NOTES: notes } } } }, null, 2),
  "shop/src/cart.js": "export function canCheckout(items) {\n  return items.length > 50 ? false : true;\n}\n",
  "shop/README.md": "# Shop\n\nCheckout code lives in src/cart.js.\n",
};
for (const [rel, content] of Object.entries(files)) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
}
const dbPath = path.join(dir, "ledger.db");

const usage = { requests: 0, promptTokens: 0, outputTokens: 0 };
const requests: ModelRequest[] = [];
const measured = (model: ModelClient, record: boolean): ModelClient => ({
  id: model.id,
  async complete(request) {
    if (record) requests.push({ ...request, signal: undefined });
    const response = await model.complete(request);
    usage.requests++;
    usage.promptTokens += response.usage.promptTokens;
    usage.outputTokens += response.usage.outputTokens;
    return response;
  },
});

const approvals: ApprovalRequest[] = [];
const log = (m: string) => console.error(`[diagnostic] ${m}`);
let store = LedgerStore.open({ path: dbPath });
let catalog: InstalledCatalog;
let socrates: Socrates;
async function open() {
  catalog = await InstalledCatalog.open({ store, home, log });
  socrates = new Socrates({
    store,
    model: measured(main, true),
    routerModel: measured(routerModel, false),
    timeZone: "UTC",
    approve: async (r) => (approvals.push(r), true),
    resolveWorkspace: () => ({ name: "shop", rootPath: root }),
    catalog,
    shelf: { pins: ["release-notes"] },
    log,
  });
}

const rows: { name: string; pass: boolean; details?: string }[] = [];
const passed = (name: string, details?: string) => {
  rows.push({ name, pass: true, ...(details ? { details } : {}) });
  console.log(`PASS ${name}${details ? ` — ${details}` : ""}`);
};
const short = (text: string) => text.replace(/\s+/g, " ").slice(0, 160);

/** One message; returns the answer and the agent requests it made. */
async function ask(message: string): Promise<{ result: Extract<HandleResult, { kind: "answered" }>; made: ModelRequest[] }> {
  const start = requests.length;
  const result = await socrates.handle(message);
  assert.equal(result.kind, "answered", result.kind === "clarify" ? `Unexpected clarification: ${result.text}` : "");
  if (result.kind !== "answered") throw new Error("unreachable");
  return { result, made: requests.slice(start) };
}
const toolCalls = (turnId: string) => store.evidenceForTurn(turnId).map((e) => e.tool);
const context = (r: ModelRequest) => userText(r.messages[0]!.content);
const everything = (r: ModelRequest) => r.messages.map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join(""))).join("\n");

async function run() {
  await open();
  const listed = catalog.entries().map((e) => e.name);
  assert.deepEqual(listed, ["pdf", "release-notes", "tracker.note_add", "tracker.note_list", "tracker.reveal_extra", "tracker.ticket_get"]);
  console.log(`Live capabilities acceptance: ${main.id} (router ${routerModel.id}); catalog ${listed.join(", ")}`);
  console.log(`Workspace, Socrates home and database: ${dir}`);

  // 1. Candidates, then activation and a call of the MCP tool in the same turn.
  const first = await ask("I'm starting on the shop checkout bug. Look up ticket 42 in our issue tracker and tell me its root cause and its code word.");
  const firstTurn = first.result.parts[0]!.turn;
  assert.match(context(first.made[0]!), /<CAPABILITY_CANDIDATES>\n(?:- skill [^\n]*\n)?- mcp c\d+: tracker\.ticket_get/);
  assert.match(context(first.made[0]!), /<AVAILABLE_SKILLS>\n- release-notes: /);
  assert(toolCalls(firstTurn.id).includes("mcp__tracker__ticket_get"), `tool calls: ${toolCalls(firstTurn.id).join(", ")}`);
  assert.match(first.result.text, /lantern-7/);
  assert.equal(approvals.length, 0, "a read-only MCP tool must not ask for approval");
  passed("a per-turn candidate is activated and called in the same turn", `${toolCalls(firstTurn.id).join(" → ")}; ${short(first.result.text)}`);

  // 2. A Skill from the frozen shelf is activated and followed.
  const second = await ask("Now use our release-notes skill to draft the release notes for the ticket 42 checkout fix.");
  const goalId = second.result.parts[0]!.turn.goalId!;
  const skillActive = store.listActiveCapabilities(goalId).some((c) => c.kind === "skill" && c.name === "release-notes");
  assert(skillActive, "release-notes was not activated");
  assert(second.result.text.includes(SIGNATURE) && /RELEASE NOTES/.test(second.result.text), `answer: ${short(second.result.text)}`);
  const shelfBlocks = new Set(requests.map((r) => /<AVAILABLE_SKILLS>[\s\S]*?<\/AVAILABLE_SKILLS>/.exec(context(r))?.[0]).filter(Boolean));
  assert.equal(shelfBlocks.size, 1, "the shelf must stay byte-identical across turns");
  passed("the Skill pinned on the frozen shelf is activated and its instructions are followed", `${toolCalls(second.result.parts[0]!.turn.id).join(" → ")}; ${short(second.result.text)}`);

  // 3. A mutating MCP tool asks once per goal; the second call reuses the approval.
  const third = await ask("Add a note to the tracker notebook: \"checkout limit off-by-one confirmed\". Then add a second note: \"release notes drafted\".");
  const fourth = await ask("Add one more note to the tracker notebook: \"ready for review\".");
  const saved = readFileSync(notes, "utf8").split("\n").filter(Boolean);
  assert.equal(saved.length, 3, `notes: ${saved.join(" | ")}`);
  const noteApprovals = approvals.filter((a) => a.kind === "mcp_tool" && a.subject === "tracker.note_add");
  const goals = new Set([third, fourth].map((t) => t.result.parts[0]!.turn.goalId));
  assert.equal(noteApprovals.length, goals.size, `${noteApprovals.length} approvals across ${goals.size} goal(s)`);
  passed("a mutating MCP tool asks for approval once per goal", `${saved.length} notes saved, ${noteApprovals.length} approval(s) for ${goals.size} goal(s)`);

  // 4. The Skill's instructions are carried once: in ACTIVE_CAPABILITIES, never repeated by history.
  const phrase = `End with the exact line "${SIGNATURE}"`;
  for (const r of [...third.made, ...fourth.made]) {
    if (!context(r).includes("<ACTIVE_CAPABILITIES>")) continue;
    assert.equal(everything(r).split(phrase).length - 1, 1, "Skill instructions must appear exactly once");
  }
  assert(third.made.some((r) => context(r).includes(`Skill release-notes:\n# Release notes`)));
  passed("an active Skill's instructions appear exactly once in later requests");

  // 5. Restart: a new process and a new server process restore the goal's active tools.
  await socrates.close();
  await catalog.close();
  store.close();
  store = LedgerStore.open({ path: dbPath });
  await open();
  const fifth = await ask("Back on the checkout work: what is the status of ticket 7 in the tracker?");
  const restartTurn = fifth.result.parts[0]!.turn;
  assert(fifth.made[0]!.tools!.some((t) => t.name === "mcp__tracker__ticket_get"), "the active MCP tool must be restored after restart");
  assert(toolCalls(restartTurn.id).includes("mcp__tracker__ticket_get"), `tool calls: ${toolCalls(restartTurn.id).join(", ")}`);
  assert.match(fifth.result.text, /closed/i);
  passed("restart restores the active MCP tool with a fresh server process", short(fifth.result.text));

  // 6. Event-only replay of every projection, including the active capability set.
  const recovered = LedgerStore.open({ path: ":memory:" });
  recovered.restoreEvents(store.listEvents());
  for (const table of ["goals", "tasks", "chats", "turns", "evidence", "task_facts", "active_capabilities"]) {
    assert.deepEqual(recovered.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), table);
  }
  assert.deepEqual(recovered.skillShelf(goalId), store.skillShelf(goalId));
  assert.deepEqual(recovered.mcpToolSnapshots(), store.mcpToolSnapshots());
  recovered.close();
  const warnings = store.listEvents({ type: "agent_warning" }).map((e) => e.payload as EventPayloads["agent_warning"]);
  passed("event-only replay of every projection, the shelf and the tool snapshots", `${warnings.length} operational warning(s)`);

  writeFileSync(path.join(dir, "results.json"), JSON.stringify({ provider, main: main.id, router: routerModel.id, dir, usage, approvals, warnings, assertions: rows }, null, 2));
  await socrates.close();
  await catalog.close();
  store.close();
  console.log(`${rows.length}/${rows.length} capability scenarios passed; ${usage.requests} model calls. Report: ${path.join(dir, "results.json")}`);
}

run().catch(async (error) => {
  writeFileSync(path.join(dir, "results.json"), JSON.stringify({ provider, dir, usage, approvals, assertions: rows, failure: error instanceof Error ? error.message : String(error) }, null, 2));
  console.error(error instanceof Error ? error.message : "Capabilities acceptance failed.");
  try {
    await socrates.close();
    await catalog.close();
    store.close();
  } catch {}
  process.exitCode = 1;
});
