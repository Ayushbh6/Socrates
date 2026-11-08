/**
 * Phase D of docs/multitasking-plan.md: one conversation, several strands, with
 * real models, against the real server built in-process over a disposable copy
 * of the user's data (never the data itself). The scenario interleaves four
 * messages the way a user would type them:
 *
 *   A  a project task that takes a while (read a file, list its headings)
 *   B  an unrelated question sent while A works      → placed beside A (a lane)
 *   C  a follow-up for A sent while A still works     → folded into A (steering), or run after it
 *   D  "how is A going?" sent while A works           → general, answered from what it sees of A
 *
 * Scored per run: where each message went and how fast, whether B ran beside A,
 * whether C was folded into A or at least kept A's task, whether D was answered
 * without disturbing A, and no cross-talk between answers. Reported cost comes
 * from the copy's calls.db.
 *
 *   SOCRATES_ENV_FILE=.env pnpm eval:multitask
 *   MULTITASK_RUNS=3            repeat on fresh copies
 *   MULTITASK_ROUTER=deepseek   route with deepseek-flash at Socrates' default thinking (low); deepseek-off: thinking off; luna
 *   MULTITASK_KEEP=1            keep the copy for inspection (it holds the keys; delete it afterwards)
 *   MULTITASK_SOURCE_HOME=…     copy another data folder (default ~/.socrates-v2)
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { loadEvaluationEnvironment } from "../../../packages/router/eval/environment";
import { Runtime, buildServer, resolveConfig, sessionToken } from "../src";

loadEvaluationEnvironment();
const root = fileURLToPath(new URL("../../../", import.meta.url));
const source = process.env.MULTITASK_SOURCE_HOME ?? path.join(homedir(), ".socrates-v2");
const runs = Number(process.env.MULTITASK_RUNS ?? "1");
const routerChoice = process.env.MULTITASK_ROUTER ?? null;
const base = path.join(root, ".socrates/evals");
mkdirSync(base, { recursive: true });

const MESSAGES = {
  a: "In the Socrates repo at ~/Documents/Work/Ayush-Personal/Socrates, read architecture/Goal-router.md and list its level-2 section headings (the lines starting with '## ') in order, as a numbered list.",
  b: "Also, while that runs: what date is next Monday?",
  c: "For that headings list, add the line number of each heading next to it.",
  d: "How is the headings list going?",
};

interface Observed {
  sentAt: number;
  routedAt?: number;
  placedAt?: number;
  resultAt?: number;
  goal?: string;
  task?: string;
  lane: number | null;
  placement?: { lane: number; reason: string };
  stages: string[];
  result?: { text: string; parts: { status: string; toolCalls: number; task: string }[]; notices: string[] };
  error?: string;
}

interface RunReport {
  run: number;
  router: string;
  observed: Record<string, Observed>;
  steered: boolean;
  checks: { name: string; pass: boolean; detail: string }[];
  costUsd: number;
  calls: number;
}

function copyHome(): string {
  const dir = realpathSync(mkdtempSync(path.join(base, "multitask-")));
  const home = path.join(dir, "home");
  mkdirSync(home);
  for (const db of ["ledger.db", "calls.db"]) {
    // A read-only backup: the live data is never opened for writing.
    execFileSync("sqlite3", [`file:${path.join(source, db)}?mode=ro`, `.backup '${path.join(home, db)}'`]);
  }
  for (const file of ["settings.json", ".env"]) if (existsSync(path.join(source, file))) cpSync(path.join(source, file), path.join(home, file));
  if (existsSync(path.join(source, "ledger.db.lance"))) cpSync(path.join(source, "ledger.db.lance"), path.join(home, "ledger.db.lance"), { recursive: true });
  if (routerChoice) {
    const settings = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"));
    // "deepseek" is Socrates' own default for a DeepSeek router: thinking low. "deepseek-off" disables thinking, which made it a poor router (trial log entry 90).
    settings.router = routerChoice === "deepseek" ? { provider: "deepseek", model: "deepseek-flash", effort: "low" }
      : routerChoice === "deepseek-off" ? { provider: "deepseek", model: "deepseek-flash", effort: "off" }
      : routerChoice === "luna" ? { provider: "openrouter", model: "openai/gpt-6-luna", effort: "off" } : settings.router;
    writeFileSync(path.join(home, "settings.json"), JSON.stringify(settings, null, 2));
  }
  return home;
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function runOnce(run: number): Promise<RunReport> {
  const home = copyHome();
  const port = await freePort();
  const settings = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"));
  const router = `${settings.router?.provider ?? "chat"}/${settings.router?.model ?? "default"}`;
  const logs: string[] = [];
  const rt = await Runtime.open(resolveConfig({ SOCRATES_HOME: home, SOCRATES_PORT: String(port) }), { log: (m) => logs.push(m) });
  const token = sessionToken();
  const app = await buildServer({ runtime: rt, token, webRoot: null });
  await app.listen({ host: "127.0.0.1", port });
  const observed: Record<string, Observed> = {};
  const steers: string[] = [];
  const approvals: string[] = [];
  const received: Record<string, any>[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { headers: { authorization: `Bearer ${token}` } });
  const waiters: { match: (m: Record<string, any>) => boolean; resolve: (m: Record<string, any>) => void }[] = [];
  const next = (match: (m: Record<string, any>) => boolean, timeoutMs: number): Promise<Record<string, any>> => {
    const already = received.find(match);
    if (already) return Promise.resolve(already);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.splice(waiters.findIndex((w) => w.resolve === done), 1); reject(new Error("timed out waiting for a live message")); }, timeoutMs);
      const done = (m: Record<string, any>) => { clearTimeout(timer); resolve(m); };
      waiters.push({ match, resolve: done });
    });
  };
  const turnOf = new Map<string, string>();
  socket.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    received.push(m);
    const now = Date.now();
    if (m.type === "progress" && observed[m.id]) observed[m.id]!.stages = m.trail.map((t: { stage: string }) => t.stage);
    if (m.type === "handed_off" && observed[m.id]) { observed[m.id]!.placedAt = now; observed[m.id]!.placement = { lane: m.lane, reason: m.reason }; }
    if (m.type === "result" && observed[m.id]) {
      observed[m.id]!.resultAt = now;
      observed[m.id]!.result = { text: m.result.text ?? "", parts: (m.result.parts ?? []).map((p: any) => ({ status: p.status, toolCalls: p.toolCalls, task: p.task })), notices: m.result.notices ?? [] };
      for (const p of m.result.parts ?? []) turnOf.set(p.turnId, m.id);
    }
    if (m.type === "error" && observed[m.id]) observed[m.id]!.error = `${m.code}: ${m.message}`;
    if (m.type === "activity" && m.kind === "steered") steers.push(m.text);
    if (m.type === "approval") {
      // Reads and commands may go on in the disposable copy; nothing may change files in the real repository.
      const granted = !/^(edit|apply_patch)$/.test(m.tool);
      approvals.push(`${granted ? "approved" : "refused"} ${m.tool}: ${m.detail}`);
      socket.send(JSON.stringify({ type: "approve", approval: m.id, granted }));
    }
    for (const w of [...waiters]) if (w.match(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
  socket.send(JSON.stringify({ type: "hello" }));
  await next((m) => m.type === "state", 10_000);
  const send = (id: keyof typeof MESSAGES) => {
    observed[id] = { sentAt: Date.now(), lane: null, stages: [] };
    socket.send(JSON.stringify({ type: "send", id, text: MESSAGES[id], to: "main" }));
  };
  // Where each message was routed, from the saved turn once its result is in.
  const place = (id: string) => {
    const o = observed[id]!;
    const seq = (received.find((m) => m.type === "accepted" && m.id === id) ?? {}).seq;
    const routed = received.find((m) => m.type === "activity" && m.kind === "routed" && (m.messageSeq === seq || (seq === undefined && m.original?.message === MESSAGES[id as keyof typeof MESSAGES])))
      ?? received.find((m) => m.type === "activity" && m.kind === "routed" && received.some((x) => x.type === "activity" && x.kind === "message" && x.text === MESSAGES[id as keyof typeof MESSAGES] && x.seq === m.messageSeq));
    if (routed) { o.goal = routed.goal.title; o.task = routed.task.title; o.lane = routed.lane; o.routedAt ??= Date.parse(routed.at); }
  };

  const started = Date.now();
  try {
    send("a");
    await next((m) => m.type === "progress" && m.id === "a" && m.trail.some((t: { stage: string }) => t.stage === "starting"), 120_000);
    await sleep(1_500);
    send("b");
    await Promise.race([next((m) => (m.type === "handed_off" || m.type === "result") && m.id === "b", 90_000), sleep(20_000)]);
    send("c");
    await sleep(4_000);
    send("d");
    for (const id of ["a", "b", "c", "d"]) await next((m) => (m.type === "result" || m.type === "error") && m.id === id, 480_000).catch(() => { observed[id]!.error ??= "no result within 8 minutes"; });
    await sleep(500);
    for (const id of ["a", "b", "c", "d"]) place(id);
  } finally {
    socket.close();
    await app.close();
    await rt.close();
  }

  const calls = new DatabaseSync(path.join(home, "calls.db"), { readOnly: true });
  const since = new Date(started - 5_000).toISOString();
  const row = calls.prepare("select count(*) as n, coalesce(sum(cost_usd), 0) as cost from calls where started_at >= ?").get(since) as { n: number; cost: number };
  calls.close();
  // MULTITASK_KEEP=1 leaves the copy (it holds the keys: delete it after reading its calls.db).
  if (process.env.MULTITASK_KEEP) console.log(`  kept: ${path.dirname(home)}`);
  else rmSync(path.dirname(home), { recursive: true, force: true });

  const a = observed.a!, b = observed.b!, c = observed.c!, d = observed.d!;
  const steered = steers.some((t) => t === MESSAGES.c);
  const checks: RunReport["checks"] = [];
  const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });
  check("A routed to a project task", !!a.task && !/^General/.test(a.goal ?? "") && !a.error, `${a.goal ?? "?"} / ${a.task ?? "?"}${a.error ? ` (${a.error})` : ""}`);
  check("B placed beside A in a lane", b.placement?.reason === "parallel", b.placement ? `lane ${b.placement.lane}, ${b.placement.reason}` : b.error ?? "not placed in a lane");
  check("B answered while A still worked", !!b.resultAt && !!a.resultAt && b.resultAt < a.resultAt, b.resultAt && a.resultAt ? `B ${Math.round((b.resultAt - b.sentAt) / 1000)}s, A ${Math.round((a.resultAt - a.sentAt) / 1000)}s` : "missing a result");
  check("B went to General", /^General/.test(b.goal ?? "") || /^General/.test(b.task ?? ""), `${b.goal ?? "?"} / ${b.task ?? "?"}`);
  check("C kept A's task", !!c.task && c.task === a.task, `${c.task ?? "?"}${steered ? " (folded into A)" : c.resultAt && a.resultAt && c.resultAt >= a.resultAt ? " (ran after A)" : ""}`);
  check("C folded into A's running turn", steered, steered ? "turn_steered recorded" : `not folded; stages ${c.stages.join(" → ") || "none"}`);
  check("D went to General and was answered", /^General/.test(d.goal ?? "") && !!d.result && !d.error, `${d.goal ?? "?"} / ${d.task ?? "?"}: ${(d.result?.text ?? d.error ?? "").replace(/\s+/g, " ").slice(0, 120)}`);
  check("D spoke about the headings work", /heading|Goal-router|section/i.test(d.result?.text ?? ""), (d.result?.text ?? "").replace(/\s+/g, " ").slice(0, 160));
  // Answering from <LANES> may open the running turn's exact work with context_retrieve (two or three lookups); more means it started work of its own.
  check("D only looked things up (at most 4 tool calls)", (d.result?.parts ?? []).every((p) => p.toolCalls <= 4), `${(d.result?.parts ?? []).map((p) => p.toolCalls).join(",") || "?"} tool calls`);
  check("No cross-talk: A's answer has no Monday, B's no headings", !/monday/i.test(a.result?.text ?? "") && !/heading/i.test(b.result?.text ?? ""), "");
  check("Every message answered", ["a", "b", "c", "d"].every((id) => observed[id]!.result && !observed[id]!.error), ["a", "b", "c", "d"].map((id) => `${id}:${observed[id]!.result ? observed[id]!.result!.parts.map((p) => p.status).join("/") : observed[id]!.error ?? "none"}`).join(" "));
  if (approvals.length) console.log(`  approvals: ${approvals.join("; ")}`);
  return { run, router, observed, steered, checks, costUsd: row.cost, calls: row.n };
}

const reports: RunReport[] = [];
for (let run = 1; run <= runs; run++) {
  console.log(`\n=== run ${run} of ${runs}${routerChoice ? ` (router ${routerChoice})` : ""} ===`);
  const report = await runOnce(run);
  reports.push(report);
  console.log(`router: ${report.router}`);
  for (const id of ["a", "b", "c", "d"] as const) {
    const o = report.observed[id]!;
    const t = (at?: number) => (at ? `${((at - o.sentAt) / 1000).toFixed(1)}s` : "—");
    console.log(`  ${id}: placed ${t(o.placedAt ?? o.routedAt)} · answered ${t(o.resultAt)} · ${o.goal ?? "?"} / ${o.task ?? "?"}${o.placement ? ` · lane ${o.placement.lane} (${o.placement.reason})` : o.lane ? ` · lane ${o.lane}` : ""}${o.error ? ` · ERROR ${o.error}` : ""}`);
    console.log(`     stages: ${o.stages.join(" → ") || "none"}`);
    console.log(`     answer: ${(o.result?.text ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
  }
  for (const c of report.checks) console.log(`  ${c.pass ? "PASS" : "FAIL"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  console.log(`  cost: $${report.costUsd.toFixed(4)} over ${report.calls} model calls`);
}
console.log("\n=== summary ===");
const names = reports[0]!.checks.map((c) => c.name);
for (const name of names) {
  const passed = reports.filter((r) => r.checks.find((c) => c.name === name)!.pass).length;
  console.log(`${passed}/${reports.length}  ${name}`);
}
console.log(`total cost: $${reports.reduce((n, r) => n + r.costUsd, 0).toFixed(4)}`);
const out = path.join(base, `multitask-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(reports.map((r) => ({ ...r, observed: Object.fromEntries(Object.entries(r.observed).map(([k, o]) => [k, { ...o, result: o.result ? { ...o.result, text: o.result.text.slice(0, 2000) } : undefined }])) })), null, 2));
console.log(`written: ${path.relative(root, out)}`);
