/** Live acceptance run: real router + real scoped worker, disposable artifacts,
 * disk persistence/restart, clarification handoff, and event-only recovery.
 * This is an evaluation harness, not the future full coding-agent runtime. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ModelClient, ModelMessage, ModelRequest } from "@socrates/contracts";
import { makeModel, PROVIDER_DEFAULTS, type Provider } from "@socrates/providers";
import { countTokens, fixedClock } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { GoalRouter, type RoutingResult } from "../src";
import { extractJson } from "../src/validate";
import { Q11_SCENARIO, seedExchange } from "./fixtures";
import { loadEvaluationEnvironment } from "./environment";
import { verifyProviderToolRoundTrip } from "../../providers/eval/tool-round-trip";

loadEvaluationEnvironment();
const provider = process.env.SOCRATES_PROVIDER ?? "gemini";
const defaults = PROVIDER_DEFAULTS[provider as Provider];
if (!defaults) throw new Error("Unknown evaluation provider.");
const modelName = process.env.SOCRATES_ROUTER_MODEL ?? defaults.router;
const live = makeModel(provider, modelName);
const evaluationDirectory = fileURLToPath(new URL("../../../.socrates/evals/", import.meta.url));
mkdirSync(evaluationDirectory, { recursive: true });
const root = mkdtempSync(join(evaluationDirectory, `socrates-goal-${provider}-`));
const clock = fixedClock("2026-10-01T12:00:00Z");
const path = join(root, "ledger.db");
let store = LedgerStore.open({ path, clock });
let requests = 0;
let tokens = 0;
const measured: ModelClient = {
  id: live.id,
  async complete(request: ModelRequest) {
    requests++;
    const result = await live.complete(request);
    tokens += result.usage.promptTokens + result.usage.outputTokens;
    return result;
  },
};
const rows: {name: string; pass: boolean; details?: string}[] = [];
const workerOutput = z.object({
  response: z.string().min(1),
  continuation_note: z.string(),
  task_complete: z.boolean(),
  artifacts: z.array(z.object({name: z.string().regex(/^[a-z0-9-]+\.md$/), content: z.string().min(1)})),
});
const histories = new Map<string, ModelMessage[]>();

function router(options: {historyBudgetTokens?: number; model?: ModelClient} = {}) {
  return new GoalRouter({store, routerModel: options.model ?? measured, timeZone: "UTC", ...(options.historyBudgetTokens === undefined ? {} : {historyBudgetTokens: options.historyBudgetTokens})});
}
function passed(name: string, details?: string) {rows.push({name, pass: true, ...(details ? {details} : {})}); console.log(`PASS ${name}${details ? ` — ${details}` : ""}`);}
function routed(result: RoutingResult) {
  assert.equal(result.kind, "routed");
  if (result.kind !== "routed") throw new Error("Unexpected clarification.");
  assert.equal(result.fallback, null, "A live acceptance route may not silently pass via fallback.");
  return result;
}

async function work(result: RoutingResult, allowedArtifacts: string[]): Promise<void> {
  if (result.kind !== "routed") return;
  const answers: string[] = [];
  const outputs: z.infer<typeof workerOutput>[] = [];
  for (const part of result.parts) {
    const history = histories.get(part.task.id) ?? [];
    const artifacts = allowedArtifacts.filter(name => existsSync(join(root, name))).map(name => ({name, content: readFileSync(join(root, name), "utf8")}));
    const input = {goal: part.goal.title, task: part.task.title, objective: part.task.objective, note: part.task.continuationNote, request: part.request, clarification: part.clarification, artifacts, previousPartResponses: part.dependsOn.map(order => answers[order - 1]), allowedArtifactNames: allowedArtifacts};
    history.push({role: "user", content: JSON.stringify(input)});
    const response = await measured.complete({
      system: "You are the working agent in a synthetic goal acceptance test. Carry out the routed request using the provided task context and artifact contents. Return only JSON {response:string,continuation_note:string,task_complete:boolean,artifacts:[{name:string,content:string}]}. Produce useful complete Markdown artifacts when requested; output ONLY allowedArtifactNames, retaining previous cases when revising. Include stable CASE-1, CASE-2, CASE-3, CASE-4 markers for the discount cases in that order. Artifacts are written by the harness after validation. Never claim an external action occurred. General conversation needs no artifacts. Keep the continuation note within 100 tokens. Set task_complete true when the requested deliverable is ready. When responding to clarification, carry out the ORIGINAL request for the subject selected by the user's answer. Keep replies concise.",
      messages: history,
      maxOutputTokens: 5000,
    });
    assert.notEqual(response.stopReason, "max_tokens");
    const output = workerOutput.parse(extractJson(response.text));
    if (!part.goal.general) assert(output.continuation_note.trim().length, "Work tasks need a continuation note.");
    for (const artifact of output.artifacts) assert(allowedArtifacts.includes(artifact.name), "Worker attempted an unexpected artifact.");
    for (const artifact of output.artifacts) writeFileSync(join(root, artifact.name), artifact.content);
    history.push({role: "assistant", content: response.text, ...(response.raw ? {raw: response.raw} : {})});
    histories.set(part.task.id, history);
    answers.push(output.response); outputs.push(output);
  }
  const reply = store.recordResponse(answers.join("\n\n"));
  for (const [i,part] of result.parts.entries()) store.completeTurn(part.turn.id, {responseEventId: reply.id, continuationNote: outputs[i]!.continuation_note, taskComplete: outputs[i]!.task_complete});
}

async function main() {
  await verifyProviderToolRoundTrip(measured); passed("native signed tool continuation on the real provider");
  console.log(`Live goal acceptance: ${live.id}\nArtifacts and database: ${root}`);
  const first = routed(await router().route("For our Storefront quality project, create a Markdown regression checklist for preserving discount codes across failed payment retries. Include successful retry, duplicate retry and expired code cases. Save it as discount-retry-checklist.md."));
  assert(first.parts[0]!.created.goal && first.parts[0]!.created.task);
  const goalId = first.parts[0]!.goal.id, taskId = first.parts[0]!.task.id;
  const ws = store.createWorkspace("storefront-eval", root);
  store.bindGoalWorkspace(goalId, ws.id);
  await work(first, ["discount-retry-checklist.md"]);
  const initial = readFileSync(join(root, "discount-retry-checklist.md"), "utf8");
  for (const marker of ["CASE-1", "CASE-2", "CASE-3"]) assert(initial.includes(marker));
  assert(/expir/i.test(initial));
  passed("new durable goal, real deliverable, task completion");

  clock.advance(60_000);
  const second = routed(await router().route("Add a fourth case for two tabs retrying the same payment; keep the earlier cases unchanged."));
  assert.equal(second.parts[0]!.task.id, taskId); assert.equal(second.parts[0]!.task.status, "open");
  await work(second, ["discount-retry-checklist.md"]);
  const updated = readFileSync(join(root, "discount-retry-checklist.md"), "utf8");
  for (const marker of ["CASE-1", "CASE-2", "CASE-3", "CASE-4"]) assert(updated.includes(marker));
  assert(/tab/i.test(updated));
  passed("elliptical continuation reopens the same completed task");

  clock.advance(60_000);
  const nav = routed(await router().route("Now create a separate Markdown test matrix for mobile navigation accessibility in the same Storefront project. Cover keyboard focus, Escape, screen-reader labels and touch targets. Save it as mobile-nav-matrix.md."));
  assert.equal(nav.parts[0]!.goal.id, goalId); assert(nav.parts[0]!.created.task);
  await work(nav, ["mobile-nav-matrix.md"]);
  assert(/Escape/i.test(readFileSync(join(root, "mobile-nav-matrix.md"), "utf8")));
  passed("independent deliverable creates a task inside the same project");

  clock.advance(60_000);
  const aside = routed(await router().route("Hi, how are you?"));
  assert(aside.parts[0]!.goal.general);
  await work(aside, []); passed("unrelated greeting uses the general singleton");

  // Restart the disk-backed store before returning to the older task.
  store.close(); store = LedgerStore.open({path, clock}); histories.clear();
  clock.advance(60_000);
  const resume = routed(await router().route("Go back to the discount retry checklist. The expired-code case is incomplete: cover a code expiring between the first payment attempt and the retry. Update the same file."));
  assert.equal(resume.parts[0]!.goal.id, goalId); assert.equal(resume.parts[0]!.task.id, taskId);
  await work(resume, ["discount-retry-checklist.md"]);
  assert(/between|first.{0,40}retry|retry.{0,40}expir/is.test(readFileSync(join(root, "discount-retry-checklist.md"), "utf8")));
  passed("restart, older task selection and regression correction");

  clock.advance(60_000);
  const compound = routed(await router().route("Create a standalone release readiness checklist as release-readiness.md, then create a separate rollback drill as rollback-drill.md using that release checklist."));
  assert.equal(compound.parts.length, 2);
  assert.notEqual(compound.parts[0]!.task.id, compound.parts[1]!.task.id);
  for (const part of compound.parts) assert.equal(part.goal.id, goalId);
  assert.deepEqual(compound.parts[1]!.dependsOn, [1]);
  await work(compound, ["release-readiness.md", "rollback-drill.md"]);
  assert(existsSync(join(root, "release-readiness.md"))); assert(existsSync(join(root, "rollback-drill.md")));
  passed("ordered compound tasks, explicit dependency and two real artifacts");

  // A separate synthetic workspace exercises pending clarification with an
  // action, not just 'continue'. Both router and worker calls remain real.
  const saved = store;
  store = LedgerStore.open({path: join(root, "clarification.db"), clock});
  Q11_SCENARIO.seed!(store, clock); clock.set("2026-09-02T09:00:00Z");
  const original = "Review yesterday's project and produce a short checklist of its remaining work. Save it as remaining-work.md.";
  const clarification = await router().route(original);
  assert.equal(clarification.kind, "clarify");
  store.close(); store = LedgerStore.open({path: join(root, "clarification.db"), clock});
  const selected = routed(await router().route("The German one."));
  assert(/German/i.test(selected.parts[0]!.goal.title));
  assert.equal(selected.parts[0]!.request, original);
  assert.equal(selected.parts[0]!.clarification?.answer, "The German one.");
  await work(selected, ["remaining-work.md"]);
  assert(/German|dative|Day 10/i.test(readFileSync(join(root, "remaining-work.md"), "utf8")));
  passed("clarification survives restart and worker receives the original action");
  store.close(); store = saved;

  // Historical target is absent from the tiny exact-history budget and the
  // known goal shortlist. It can be selected only after real ledger_query.
  clock.set("2026-07-15T10:00:00Z");
  const oldWs = store.createWorkspace("archive-eval", join(root, "archive"));
  const oldGoal = store.createGoal({title: "Invoice ledger", workspaceId: oldWs.id});
  const oldTask = store.createTask(oldGoal.id, {title: "Invoice reconciliation"});
  seedExchange(store, oldTask.id, "Reconcile invoices.", "Reconciliation finished.", "Check duplicate invoice identifiers.");
  store.reviseTask(oldTask.id, {status: "completed"});
  clock.set("2026-10-01T13:00:00Z");
  seedExchange(store, compound.parts[1]!.task.id, "Continue the rollback drill.", "Rollback drill is ready.");
  const historical = routed(await router({historyBudgetTokens: 30}).route("Resume the project we completed on 15 July 2026 and explain its remaining checks."));
  assert.equal(historical.parts[0]!.task.id, oldTask.id);
  const event = store.listEvents({type: "routing_completed"}).at(-1)!;
  assert((event.payload as {ledger_queries: number}).ledger_queries > 0);
  await work(historical, []); passed("historical retrieval through actual model tool calls");

  // Deliberately corrupt two final answers from a real small-model attempt.
  // The escalation itself is a real call and must resolve using the retained
  // tool/repair transcript. Fault injection is explicit in the report.
  let corrupted = 0;
  const faulty: ModelClient = {id: `fault-injected:${measured.id}`, async complete(request) {
    const response = await measured.complete(request);
    if (response.toolCalls.length) return response;
    corrupted++;
    return {...response, text: "deliberately invalid JSON for escalation acceptance", raw: {provider: "fault-injection", content: []}};
  }};
  const escalation = routed(await new GoalRouter({store, routerModel: faulty, mainModel: measured, timeZone: "UTC"}).route("Go back to the Storefront discount retry checklist and explain how its expired-code case works."));
  assert.equal(corrupted, 2); assert(escalation.escalated);
  assert.equal(escalation.parts[0]!.task.id, taskId);
  await work(escalation, []);
  passed("real model escalation after two deliberately invalid answers");

  const recovered = LedgerStore.open({path: join(root, "recovered.db"), clock});
  recovered.restoreEvents(store.listEvents());
  for (const table of ["goals", "tasks", "chats", "turns", "task_revisions", "goal_note_revisions", "workspaces", "anchors"]) {
    assert.deepEqual(recovered.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  }
  assert.deepEqual([...recovered.recentExchanges()], [...store.recentExchanges()]);
  assert.equal(store.db.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
  for (const {task} of store.allTasks()) {
    assert(countTokens(task.objective) <= 25);
    assert(task.continuationNote === null || countTokens(task.continuationNote) <= 100);
  }
  recovered.close(); passed("event-only recovery, SQLite integrity and bounded metadata");
  const report = {provider, model: modelName, root, requests, providerReportedTokens: tokens, assertions: rows, artifacts: readdirSync(root).filter(n => n.endsWith(".md"))};
  writeFileSync(join(root, "acceptance-results.json"), JSON.stringify(report, null, 2));
  store.close(); console.log(`${rows.length}/${rows.length} acceptance scenarios passed; ${requests} real model calls. Report: ${join(root, "acceptance-results.json")}`);
}
main().catch(error => {writeFileSync(join(root, "acceptance-results.json"), JSON.stringify({provider, model: modelName, root, requests, assertions: rows, failure: error instanceof Error ? error.message : String(error)}, null, 2)); console.error(error instanceof Error ? error.message : "Acceptance failed."); try {store.close();} catch {} process.exitCode = 1;});
