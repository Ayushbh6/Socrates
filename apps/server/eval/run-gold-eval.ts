/** The gold-standard live evaluation: models build a mockup from its image alone.
 *
 * Each model gets its own real Socrates server and an empty folder, and the
 * picture of a task board. It must look at the picture, scaffold a React and
 * TypeScript app with the interactive `npm create vite@latest` wizard (a real
 * terminal), install packages, run the dev server, open the page in a browser
 * through the Playwright MCP server, compare what it sees with the picture,
 * and keep fixing until they match. Nobody steps in. Afterwards this script
 * opens the page itself and checks the text, the interactions and a
 * side-by-side picture, and writes `results.json`.
 *
 * Everything it creates lives in one folder, `.socrates/evals/gold`: data
 * homes, projects, npm caches and temporary files. `--clean` deletes it.
 *
 *   SOCRATES_ENV_FILE=.env pnpm eval:gold [--only deepseek|glm] [--minutes 60]
 *   pnpm eval:gold --inspect glm        (open a finished project again; no model runs)
 *   pnpm eval:gold --clean
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_DEFAULTS, type Provider } from "@socrates/providers";
import WebSocket from "ws";
import { loadEvaluationEnvironment } from "../../../packages/router/eval/environment";
import { KEY_NAMES } from "../src";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const gold = path.join(root, ".socrates/evals/gold");
const args = process.argv.slice(2);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

/** Playwright's browser sockets need a short path (a unix socket's limit is about 100 bytes), so they live here, not under the gold folder. */
const sockets = (name: string) => `/tmp/gold-pw-${name}`;

if (args.includes("--clean")) {
  rmSync(gold, { recursive: true, force: true });
  for (const name of ["deepseek", "glm"]) rmSync(sockets(name), { recursive: true, force: true });
  console.log(`Deleted ${gold}`);
  process.exit(0);
}

loadEvaluationEnvironment();
const MINUTES = Number(option("--minutes") ?? 60);
const REFERENCE = path.join(root, "apps/server/eval/gold/task-board.webp");

/** The models under test; each has its own server port and its own dev server port. */
const MODELS = {
  deepseek: { provider: "deepseek" as Provider, model: "deepseek-flash", effort: "high", port: 4277, dev: 5181 },
  glm: { provider: "openrouter" as Provider, model: "z-ai/glm-5.3-flash", effort: "high", port: 4278, dev: 5182 },
};
type Name = keyof typeof MODELS;
const only = option("--only") as Name | undefined;
if (only && !MODELS[only]) throw new Error(`--only takes ${Object.keys(MODELS).join(" or ")}.`);
const names = (only ? [only] : Object.keys(MODELS)) as Name[];

// Anything a process here puts in a temporary folder goes in the gold folder instead.
const tmp = path.join(gold, "tmp");
mkdirSync(tmp, { recursive: true });
process.env.TMPDIR = tmp;

const tools = path.join(gold, "tools");
const playwrightMcp = path.join(tools, "node_modules/@playwright/mcp/cli.js");
const toolsCache = path.join(gold, "npm-cache");

/** The browser tool is installed once, pinned, into the gold folder; its npm cache is there too. */
function installBrowserTool(): void {
  if (existsSync(playwrightMcp)) return;
  mkdirSync(tools, { recursive: true });
  writeFileSync(path.join(tools, "package.json"), JSON.stringify({ name: "gold-tools", private: true }));
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "@playwright/mcp@0.0.83"], { cwd: tools, env: { ...process.env, npm_config_cache: toolsCache }, encoding: "utf8" });
  if (install.status !== 0) throw new Error(`Installing the Playwright MCP server failed: ${install.stderr}`);
}

const PROMPT = (dev: number) => `Build the page in the attached image as a real, working web app, from scratch in this folder, which is empty.

- Start it with the official Vite React + TypeScript template, using the interactive \`npm create vite@latest\` wizard in a terminal: answer its questions as they appear; do not pass flags that skip them.
- Install whatever else you need, and run the dev server as a background terminal on port ${dev}.
- Open the running page in the browser tool and look at it. Compare what you see with the attached image and keep fixing until they match closely: layout, spacing, colours, fonts, icons, avatars, text and numbers.
- Make the obvious things work: the Board, List and Timeline tabs switch views, the search box filters the tasks, the checklist items can be ticked, and New task adds a card to To do.
- You decide when it is finished. End with a short summary of what you built and how well it matches.`;

const results: Record<string, unknown>[] = [];

async function runOne(name: Name): Promise<void> {
  const m = MODELS[name];
  const defaults = PROVIDER_DEFAULTS[m.provider]!;
  const keyName = defaults.keys.find((k) => process.env[k]);
  if (!keyName) throw new Error(`Set ${defaults.keys.join(" or ")} (SOCRATES_ENV_FILE) for ${name}.`);
  const key = process.env[keyName]!;

  const dir = path.join(gold, name);
  // A rerun starts clean, but keeps the downloaded packages (the npm cache) so it need not fetch them again.
  for (const entry of existsSync(dir) ? readdirSync(dir) : []) if (entry !== "npm-cache") rmSync(path.join(dir, entry), { recursive: true, force: true });
  const [home, project, shots, cache, temp] = ["home", "project", "shots", "npm-cache", "tmp"].map((d) => path.join(dir, d)) as [string, string, string, string, string];
  for (const d of [home, project, shots, cache, temp]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { playwright: { command: process.execPath, cwd: shots, args: [playwrightMcp, "--browser", "chrome", "--headless", "--isolated", "--output-dir", shots, "--viewport-size", "1280x900"], env: { TMPDIR: temp, PWTEST_SOCKETS_DIR: sockets(name) } } } }, null, 2));

  const log = (line: string) => console.log(`[${name} ${((Date.now() - began) / 60_000).toFixed(1)}m] ${line}`);
  const transcript = (entry: object) => appendFileSync(path.join(dir, "transcript.jsonl"), `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
  const began = Date.now();

  const env: Record<string, string | undefined> = { ...process.env, SOCRATES_HOME: home, SOCRATES_PORT: String(m.port), NODE_OPTIONS: "--disable-warning=ExperimentalWarning", TMPDIR: temp, npm_config_cache: cache, npm_config_update_notifier: "false" };
  for (const k of KEY_NAMES) delete env[k];
  let output = "";
  const server: ChildProcess = spawn(process.execPath, ["--import", "tsx", path.join(root, "apps/server/src/main.ts")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const logFile = path.join(dir, "server.log");
  for (const stream of [server.stdout!, server.stderr!]) stream.on("data", (chunk) => { output += chunk; appendFileSync(logFile, chunk); });
  const http = `http://127.0.0.1:${m.port}`;
  let token = "";
  for (let i = 0; i < 600 && !token; i++) {
    token = /token=([\w-]+)/.exec(output)?.[1] ?? "";
    if (server.exitCode !== null) throw new Error(`The ${name} server did not start: ${output}`);
    if (!token) await new Promise((done) => setTimeout(done, 100));
  }
  if (!token) throw new Error(`The ${name} server did not start in time.`);

  const api = async (route: string, method = "GET", body?: unknown, raw?: Buffer, type?: string) => {
    const response = await fetch(`${http}${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(type ? { "content-type": type } : {}) }, ...(raw ? { body: raw } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    if (text.includes(key)) throw new Error("A provider key appeared in an API response.");
    if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };

  const metrics = { toolCalls: 0, toolErrors: 0, approvals: 0, playwrightCalls: 0, screenshots: 0, terminalRuns: 0, terminalInputs: 0, edits: 0, drafts: 0 };
  let firstToolMs: number | null = null;
  let finalText = "";
  let status: "finished" | "timed_out" | "failed" = "failed";
  let failure: string | null = null;
  const socket = new WebSocket(`ws://127.0.0.1:${m.port}/api/live`, { headers: { authorization: `Bearer ${token}`, origin: http } });
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "hello" }));
    await api(`/api/keys/${keyName}`, "PUT", { value: key });
    const workspace = await api("/api/workspaces", "POST", { path: project });
    await api("/api/settings", "PUT", {
      chat: { provider: m.provider, model: m.model, effort: m.effort },
      router: { provider: m.provider, model: m.model },
      workingFolder: workspace.id,
      access: { approvals: "auto" },
    });
    const ready = await api("/api/status");
    if (!ready.ready) throw new Error(`Not ready: ${JSON.stringify(ready.setup)}`);
    const image = await api("/api/attachments?name=task-board.webp", "POST", undefined, readFileSync(REFERENCE), "image/webp");

    const id = `gold-${name}`;
    const finished = new Promise<{ text: string }>((resolve, reject) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "draft") metrics.drafts++;
        if (message.type === "approval") {
          metrics.approvals++;
          socket.send(JSON.stringify({ type: "approve", approval: message.id, granted: true }));
          transcript({ approval: message.detail });
        }
        if (message.type === "activity" && message.kind === "tool_started") {
          metrics.toolCalls++;
          firstToolMs ??= Date.now() - began;
          const call = message.call as { kind: string; verb: string; target: string };
          if (call.target.startsWith("mcp__playwright")) metrics.playwrightCalls++;
          if (call.target.endsWith("browser_take_screenshot")) metrics.screenshots++;
          if (call.kind === "terminal" && (call.verb === "Ran" || call.verb === "Started")) metrics.terminalRuns++;
          if (call.kind === "terminal" && (call.verb === "Typed" || call.verb === "Pressed")) metrics.terminalInputs++;
          if (call.kind === "edit") metrics.edits++;
          transcript({ tool: `${call.verb} ${call.target}`, kind: call.kind });
        }
        if (message.type === "activity" && message.kind === "tool_finished") {
          if (message.status === "error") metrics.toolErrors++;
          transcript({ result: message.result.summary, status: message.status, text: String(message.result.preview).slice(0, 300) });
        }
        if (message.type === "activity" && message.kind === "step" && message.text) transcript({ said: message.text.slice(0, 400) });
        if (message.type === "result" && message.id === id) resolve({ text: message.result.text });
        if (message.type === "error" && (message.id === id || !message.id)) reject(new Error(`${message.code}: ${message.message}`));
      });
    });
    const beat = setInterval(() => log(`${metrics.toolCalls} tool calls, ${metrics.screenshots} screenshots, ${metrics.toolErrors} errors`), 60_000);
    socket.send(JSON.stringify({ type: "send", id, to: "main", text: PROMPT(m.dev), attachments: [{ id: image.id, name: "task-board.webp" }] }));
    log("sent the picture and the task");
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), MINUTES * 60_000));
    const outcome = await Promise.race([finished, timeout]);
    clearInterval(beat);
    if (outcome === "timeout") {
      status = "timed_out";
      socket.send(JSON.stringify({ type: "cancel", conversation: "main" }));
      await new Promise((done) => setTimeout(done, 5_000));
    } else {
      status = "finished";
      finalText = outcome.text;
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    log(`failed: ${failure}`);
  }
  const workedMs = Date.now() - began;
  rmSync(sockets(name), { recursive: true, force: true });
  log(`${status} after ${(workedMs / 60_000).toFixed(1)} minutes`);

  // Open what it built, the way a person would, while its dev server is still running.
  const check = await inspect(name, m.dev, project, dir, cache, temp).catch((error) => ({ error: String(error) }));
  writeFileSync(path.join(dir, "final-answer.md"), finalText);

  socket.close();
  server.kill("SIGINT");
  await Promise.race([once(server, "exit"), new Promise((done) => setTimeout(done, 20_000))]);
  if (server.exitCode === null) server.kill("SIGKILL");
  results.push({ name, model: `${m.provider}:${m.model}`, effort: m.effort, status, failure, minutes: Number((workedMs / 60_000).toFixed(1)), firstToolSeconds: firstToolMs === null ? null : Math.round(firstToolMs / 1000), ...metrics, check });
}

/** Run in the page: this script has no DOM types, so these are source strings. */
/** What a person reads on the page, including the hint inside an empty search box. */
const BODY_TEXT = "document.body.innerText + ' ' + [...document.querySelectorAll('[placeholder]')].map((e) => e.placeholder).join(' ')";
const BODY_LENGTH = "document.body.innerText.length";

/** The page's text, interactions and a side-by-side picture, from this script's own browser. */
async function inspect(name: Name, devPort: number, project: string, dir: string, cache: string, temp: string): Promise<Record<string, unknown>> {
  // Installed beside the browser tool, so it is not a dependency of Socrates.
  const { chromium } = createRequire(path.join(tools, "package.json"))("playwright-core") as { chromium: { launch(options: object): Promise<any> } };
  const url = `http://127.0.0.1:${devPort}/`;
  let started: ChildProcess | null = null;
  const alive = async () => fetch(url).then((r) => r.ok, () => false);
  if (!(await alive()) && existsSync(path.join(project, "package.json"))) {
    // The agent stopped its server: start the project's own, to look at it.
    started = spawn("npm", ["run", "dev", "--", "--port", String(devPort), "--host", "127.0.0.1"], { cwd: project, env: { ...process.env, npm_config_cache: cache, TMPDIR: temp }, stdio: "ignore" });
    for (let i = 0; i < 60 && !(await alive()); i++) await new Promise((done) => setTimeout(done, 500));
  }
  const reachable = await alive();
  const out: Record<string, unknown> = { reachable, serverWasRunning: started === null };
  if (!reachable) return out;
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1586, height: 992 } });
    const problems: string[] = [];
    page.on("pageerror", (e: Error) => problems.push(e.message));
    page.on("console", (c: { type(): string; text(): string }) => c.type() === "error" && problems.push(c.text()));
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: path.join(dir, "result.png") });
    await page.screenshot({ path: path.join(dir, "result-full.png"), fullPage: true });
    const text = await page.evaluate(BODY_TEXT);
    const expected = [
      "Workspace", "Overview", "Projects", "Tasks", "Calendar", "Settings", "Alex Morgan",
      "My tasks", "Keep your projects moving forward.", "Filter", "New task",
      "In progress", "12", "Completed", "28", "Due this week", "5",
      "Board", "List", "Timeline", "Search tasks", "To do", "Done",
      "Update landing page", "Review onboarding flow", "Write release notes", "Build analytics dashboard", "Design settings page", "Set up design tokens", "Fix mobile navigation",
      "Design", "Product", "Engineering", "Revise hero section", "Go through the new user journey", "Draft notes for v1.2", "Implement key charts", "Create high-fidelity designs", "Define color, typography", "Resolve menu overflow",
      "Oct 8", "Oct 10", "Oct 3", "Oct 5", "60%", "Account preferences", "Notification settings", "Add task",
    ];
    const missing = expected.filter((t) => !text.toLowerCase().includes(t.toLowerCase()));
    out.text = { expected: expected.length, found: expected.length - missing.length, missing };

    const attempt = async (label: string, work: () => Promise<boolean>): Promise<[string, boolean]> => [label, await work().catch(() => false)];
    const interactions = [
      await attempt("search filters the cards", async () => {
        const box = page.getByPlaceholder(/search/i).first();
        await box.fill("analytics");
        await page.waitForTimeout(300);
        const filtered = await page.evaluate(BODY_TEXT);
        await box.fill("");
        await page.waitForTimeout(300);
        return filtered.includes("Build analytics dashboard") && !filtered.includes("Update landing page");
      }),
      await attempt("tabs switch the view", async () => {
        const before = await page.evaluate(BODY_TEXT);
        await page.getByText("List", { exact: true }).first().click();
        await page.waitForTimeout(400);
        const list = await page.evaluate(BODY_TEXT);
        await page.getByText("Board", { exact: true }).first().click();
        await page.waitForTimeout(400);
        return list !== before;
      }),
      await attempt("a checklist item can be ticked", async () => {
        // As a person would: click the item's text. The box is a labelled input (often hidden behind a styled one) or an ARIA checkbox.
        const state = (async () => {
          const checked = await page.evaluate("[...document.querySelectorAll('input[type=checkbox], [role=checkbox]')].map((e) => e.checked ?? e.getAttribute('aria-checked')).join()");
          return checked as string;
        });
        const before = await state();
        await page.getByText(/Notification settings/i).first().click();
        await page.waitForTimeout(200);
        return (await state()) !== before;
      }),
      await attempt("New task adds something", async () => {
        const before = await page.evaluate(BODY_LENGTH);
        await page.getByRole("button", { name: /New task/i }).first().click();
        await page.waitForTimeout(500);
        return (await page.evaluate(BODY_LENGTH)) !== before || (await page.getByRole("dialog").count()) > 0;
      }),
    ];
    out.interactions = Object.fromEntries(interactions);
    out.consoleProblems = problems.slice(0, 5);

    // The reference and the result side by side, for the eye.
    const reference = readFileSync(REFERENCE).toString("base64");
    const result = readFileSync(path.join(dir, "result.png")).toString("base64");
    await page.setViewportSize({ width: 1600, height: 560 });
    await page.setContent(`<body style="margin:0;display:flex;gap:8px;background:#222"><img style="width:796px" src="data:image/webp;base64,${reference}"><img style="width:796px" src="data:image/png;base64,${result}"></body>`);
    await page.screenshot({ path: path.join(dir, "compare.png") });
  } finally {
    await browser.close();
    started?.kill("SIGTERM");
  }
  console.log(`[${name}] checked the page: ${JSON.stringify((out.text as { found: number; expected: number }))}`);
  return out;
}

installBrowserTool();
if (option("--inspect")) {
  // Look at a finished project again without running a model: `--inspect glm`.
  const inspected = option("--inspect")!;
  const model = inspected.replace(/-.*$/, "") as Name;
  const dir = path.join(gold, inspected);
  console.log(JSON.stringify(await inspect(model, MODELS[model].dev, path.join(dir, "project"), dir, path.join(dir, "npm-cache"), path.join(dir, "tmp")), null, 2));
  process.exit(0);
}
await Promise.all(names.map((n) => runOne(n)));
writeFileSync(path.join(gold, "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log(`\nResults, pictures and transcripts are in ${gold}. Delete it all with: pnpm eval:gold --clean`);
process.exit(0);
