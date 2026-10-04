import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { countTokens, fixedClock } from "@socrates/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { LedgerStore, parseGoalSelector, parseTaskSelector, renderLedgerRow, runLedgerQuery, toFtsQuery } from "../src";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/schema";

const TZ = "UTC";

function openStore() {
  const clock = fixedClock("2026-09-01T10:00:00Z");
  return { store: LedgerStore.open({ path: ":memory:", clock }), clock };
}

describe("event log", () => {
  it("is append-only", () => {
    const { store } = openStore();
    const event = store.recordUserMessage("hello");
    expect(() => store.db.exec(`UPDATE events SET type = 'x' WHERE id = '${event.id}'`)).toThrow(/append-only/);
    expect(() => store.db.exec(`DELETE FROM events WHERE id = '${event.id}'`)).toThrow(/append-only/);
    expect(store.getEvent(event.id)?.payload).toEqual({ text: "hello" });
  });

  it("rolls back every write of a failed transaction", () => {
    const { store } = openStore();
    const before = store.listEvents().length;
    expect(() =>
      store.transaction(() => {
        store.createGoal({ title: "Doomed" });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.listEvents().length).toBe(before);
    expect(store.listGoals()).toHaveLength(0);
  });
});

describe("ledger", () => {
  let store: LedgerStore;
  let clock: ReturnType<typeof fixedClock>;
  beforeEach(() => ({ store, clock } = openStore()));

  it("numbers goals globally and tasks per goal", () => {
    const g1 = store.createGoal({ title: "Website" });
    const g2 = store.createGoal({ title: "German" });
    const t1 = store.createTask(g1.id, { title: "Hero" });
    const t2 = store.createTask(g1.id, { title: "Nav" });
    const t3 = store.createTask(g2.id, { title: "Day 1" });
    expect([g1.number, g2.number]).toEqual([1, 2]);
    expect([t1.number, t2.number, t3.number]).toEqual([1, 2, 1]);
  });

  it("appends a revision for every task change and keeps prior revisions", () => {
    const goal = store.createGoal({ title: "Website" });
    const task = store.createTask(goal.id, { title: "Hero", objective: "Fix the hero on mobile." });
    store.reviseTask(task.id, { continuationNote: "Heading reduced." });
    const done = store.reviseTask(task.id, { status: "completed", continuationNote: "Verified at 375px." });
    expect(done.revision).toBe(3);
    expect(done.completedAt).not.toBeNull();
    expect(store.listTaskRevisions(task.id).map((r) => r.continuationNote)).toEqual([null, "Heading reduced.", "Verified at 375px."]);
    expect(() => store.db.exec("DELETE FROM task_revisions")).toThrow(/append-only/);
  });

  it("keeps goal-note history", () => {
    const goal = store.createGoal({ title: "German" });
    store.reviseGoalNote(goal.id, "Toward B1.");
    const g = store.reviseGoalNote(goal.id, "Toward B1. Day 9 done.");
    expect(g.note).toBe("Toward B1. Day 9 done.");
    expect(store.listGoalNoteRevisions(goal.id).map((r) => r.revision)).toEqual([1, 2]);
  });

  it("binds a workspace permanently", () => {
    const ws = store.createWorkspace("website-x");
    const other = store.createWorkspace("personal");
    const goal = store.bindGoalWorkspace(store.createGoal({ title: "Website" }).id, ws.id);
    expect(goal.workspaceId).toBe(ws.id);
    expect(() => store.bindGoalWorkspace(goal.id, other.id)).toThrow(/already bound/);
  });

  it("creates exactly one general goal and task", () => {
    const a = store.ensureGeneral();
    const b = store.ensureGeneral();
    expect(a.goal.id).toBe(b.goal.id);
    expect(a.task.id).toBe(b.task.id);
    expect(a.goal.general && a.task.general).toBe(true);
  });
});

describe("turns and exchanges", () => {
  it("binds turns, completes them, and tracks the current binding", () => {
    const { store } = openStore();
    expect(store.currentBinding()).toBeNull();
    const goal = store.createGoal({ title: "Website" });
    const task = store.createTask(goal.id, { title: "Hero" });
    const msg = store.recordUserMessage("Fix the hero on mobile");
    const turn = store.bindTurn({ userEventId: msg.id, taskId: task.id, route: "create_new" });
    expect(turn.projectTurn).toBe(1);
    expect(store.currentBinding()?.task.id).toBe(task.id);

    const response = store.recordResponse("Fixed.", { turn_id: turn.id });
    store.completeTurn(turn.id, { responseEventId: response.id, continuationNote: "Hero fixed.", goalNote: "Website polish." });
    expect(store.requireTask(task.id).continuationNote).toBe("Hero fixed.");
    expect(store.requireGoal(goal.id).note).toBe("Website polish.");
    expect(() => store.completeTurn(turn.id, { responseEventId: response.id })).toThrow(/already completed/);

    const [exchange] = [...store.recentExchanges()];
    expect(exchange).toMatchObject({ userMessage: "Fix the hero on mobile", response: "Fixed.", projectTurns: [1] });
  });

  it("stores a compound message once and links it to every part", () => {
    const { store } = openStore();
    const goal = store.createGoal({ title: "Socrates development" });
    const a = store.createTask(goal.id, { title: "Issue #42" });
    const b = store.createTask(goal.id, { title: "Security review" });
    const msg = store.recordUserMessage("Post the update, then audit the endpoints");
    const p1 = store.bindTurn({ userEventId: msg.id, taskId: a.id, partOrder: 1, route: "compound" });
    const p2 = store.bindTurn({ userEventId: msg.id, taskId: b.id, partOrder: 2, route: "compound" });
    const response = store.recordResponse("1. Posted. 2. Audit done.");
    store.completeTurn(p1.id, { responseEventId: response.id });
    store.completeTurn(p2.id, { responseEventId: response.id });

    const exchanges = [...store.recentExchanges()];
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.projectTurns).toEqual([1, 2]);
    expect(exchanges[0]!.bindings.map((x) => x.taskId)).toEqual([a.id, b.id]);
    expect(store.listEvents({ type: "user_message" })).toHaveLength(1);
  });

  it("records clarifications outside every task", () => {
    const { store } = openStore();
    const msg = store.recordUserMessage("Let's continue the project from yesterday.");
    const turn = store.recordClarification(msg.id, "Which one?");
    expect(turn.kind).toBe("clarification");
    expect(turn.taskId).toBeNull();
    expect(store.currentBinding()).toBeNull();
    expect([...store.recentExchanges()][0]).toMatchObject({ kind: "clarification", response: "Which one?" });
  });
});

describe("ledger queries", () => {
  function seed() {
    const { store, clock } = openStore();
    const web = store.createWorkspace("website-x");
    const personal = store.createWorkspace("personal");
    const site = store.createGoal({ title: "Andy Website development", workspaceId: web.id });
    clock.set("2026-08-12T09:00:00Z");
    const pay = store.createTask(site.id, { title: "Payment integration" });
    store.reviseTask(pay.id, { continuationNote: "Sandbox works, live keys pending." });
    const german = store.createGoal({ title: "Ongoing German learning", workspaceId: personal.id });
    store.reviseGoalNote(german.id, "German lessons toward B1 following the 30-day plan.");
    clock.set("2026-08-05T09:00:00Z");
    const day8 = store.createTask(german.id, { title: "German Day 8" });
    store.reviseTask(day8.id, { continuationNote: "Subordinate clauses.", status: "completed" });
    return { store, site, german };
  }

  it("filters by date range and renders selectors", () => {
    const { store } = seed();
    const rows = runLedgerQuery(store, { from: "2026-08-01", to: "2026-08-31" }, TZ);
    expect(rows.map(renderLedgerRow)).toEqual([
      "2026-08-12  website-x    g1 Andy Website development · g1/t1 Payment integration — open — Sandbox works, live keys pending.",
      "2026-08-05  personal     g2 Ongoing German learning · g2/t1 German Day 8 — completed — Subordinate clauses.",
    ]);
  });

  it("matches stemmed words in goal notes and task metadata", () => {
    const { store } = seed();
    expect(runLedgerQuery(store, { match: "lesson" }, TZ).map((r) => r.taskSelector)).toEqual(["g2/t1"]);
    expect(runLedgerQuery(store, { match: "payments" }, TZ).map((r) => r.taskSelector)).toEqual(["g1/t1"]);
  });

  it("applies status, workspace, goal, and task filters", () => {
    const { store } = seed();
    expect(runLedgerQuery(store, { status: "completed" }, TZ).map((r) => r.taskSelector)).toEqual(["g2/t1"]);
    expect(runLedgerQuery(store, { workspace: "website-x" }, TZ).map((r) => r.taskSelector)).toEqual(["g1/t1"]);
    expect(runLedgerQuery(store, { goal: "g2" }, TZ).map((r) => r.taskSelector)).toEqual(["g2/t1"]);
    expect(runLedgerQuery(store, { goal: "website" }, TZ).map((r) => r.taskSelector)).toEqual(["g1/t1"]);
    expect(runLedgerQuery(store, { task: "g1/t1" }, TZ).map((r) => r.taskSelector)).toEqual(["g1/t1"]);
    expect(runLedgerQuery(store, { limit: 1 }, TZ)).toHaveLength(1);
  });

  it("rejects inverted ranges and empty matches with corrective errors", () => {
    const { store } = seed();
    expect(() => runLedgerQuery(store, { from: "2026-09-01", to: "2026-08-01" }, TZ)).toThrow(/after/);
    expect(() => runLedgerQuery(store, { match: "the and of" }, TZ)).toThrow(/no searchable words/);
  });
});

describe("helpers", () => {
  it("parses selectors", () => {
    expect(parseGoalSelector("g12")).toBe(12);
    expect(parseGoalSelector("older_1")).toBeNull();
    expect(parseTaskSelector("g12/t4")).toEqual({ goal: 12, task: 4 });
  });

  it("builds injection-safe FTS queries", () => {
    expect(toFtsQuery('Okay, let\'s start today\'s lesson "NEAR"')).toBe('"start" OR "lesson" OR "near"');
    expect(toFtsQuery("hi how are you")).toBe("");
  });
});

describe("event-only recovery", () => {
  it("reconstructs every implemented projection, revisions, links and FTS without consulting the source database", () => {
    const {store, clock} = openStore();
    const ws = store.createWorkspace("sample", "/tmp/synthetic");
    const goal = store.createGoal({title: "Checkout", objective: "Keep checkout reliable for every customer."});
    store.bindGoalWorkspace(goal.id, ws.id);
    store.reviseGoalNote(goal.id, "Keep checkout reliable.");
    const task = store.createTask(goal.id, {title: "Retry discount", objective: "Preserve the discount on retries.", completionCriteria: "A retried payment keeps its discount."});
    store.reviseTask(task.id, {completionCriteria: "A retried payment keeps its discount in an end-to-end test."});
    store.upsertAnchor({goalId: goal.id, path: "plan.md", role: "goal_plan", summary: "Original", status: "provisional"});
    clock.advance(1000);
    store.upsertAnchor({goalId: goal.id, path: "plan.md", role: "goal_plan", summary: "Updated", status: "active"});
    const user = store.recordUserMessage("Fix yesterday's checkout retry.");
    const question = store.recordClarification(user.id, "Which checkout?");
    clock.advance(1000);
    const answer = store.recordUserMessage("The sample one.");
    const turn = store.bindTurn({userEventId: answer.id, taskId: task.id, route: "resume", requestEventId: user.id, clarificationTurnId: question.id, workspaceConfidence: "low", gateArmed: true});
    const reply = store.recordResponse("Discount preserved.");
    store.completeTurn(turn.id, {responseEventId: reply.id, taskComplete: true, continuationNote: "Verified retry."});
    store.reviseTask(task.id, {status: "open"});
    store.openChat(task.id, {continuationOf: turn.chatId, handoverRef: "shelf/example"});
    store.ensureGeneral();
    const events = store.listEvents();
    const recovered = LedgerStore.open({path: ":memory:"});
    recovered.restoreEvents(JSON.parse(JSON.stringify(events)));
    for (const table of ["events", "workspaces", "goals", "tasks", "goal_note_revisions", "task_revisions", "chats", "turns", "anchors", "task_facts"]) {
      expect(recovered.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), table).toEqual(store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    }
    expect(recovered.requestForTurn(turn.id)).toEqual(store.requestForTurn(turn.id));
    expect(recovered.requestForTurn(turn.id).clarification?.answer).toBe("The sample one.");
    expect([...recovered.recentExchanges()]).toEqual([...store.recentExchanges()]);
    expect(runLedgerQuery(recovered, {match: "discount"}, TZ)).toEqual(runLedgerQuery(store, {match: "discount"}, TZ));
    expect(() => recovered.restoreEvents(events)).toThrow(/empty store/);
    recovered.close(); store.close();
  });

  it("rolls back restoration of an incomplete legacy log", () => {
    const {store} = openStore();
    const source = openStore().store;
    source.createWorkspace("broken");
    const events = source.listEvents();
    delete (events[0]!.payload as {workspace_id?: string}).workspace_id;
    expect(() => store.restoreEvents(events)).toThrow(/no identity/);
    expect(store.listEvents()).toEqual([]);
    expect(store.findWorkspaceByName("broken")).toBeNull();
  });
});

describe("canonical timestamps and metadata budgets", () => {
  it("uses event timestamps for exact recovery even when the clock advances on every read", () => {
    let time = Date.parse("2026-10-01T10:00:00Z");
    const store = LedgerStore.open({path: ":memory:", clock: {now: () => new Date(time++)}});
    const ws = store.createWorkspace("timestamp-test");
    const goal = store.createGoal({title: "Goal"});
    store.bindGoalWorkspace(goal.id, ws.id);
    store.reviseGoalNote(goal.id, "Goal note.");
    const task = store.createTask(goal.id, {title: "Task"});
    store.upsertAnchor({goalId: goal.id, path: "plan.md", role: "plan", summary: "Anchor"});
    const user = store.recordUserMessage("Request");
    store.recordClarification(user.id, "Question");
    const turn = store.bindTurn({taskId: task.id, userEventId: user.id, route: "continue"});
    const response = store.recordResponse("Response");
    store.completeTurn(turn.id, {responseEventId: response.id, taskComplete: true, continuationNote: "Done."});
    const recovered = LedgerStore.open({path: ":memory:"}); recovered.restoreEvents(store.listEvents());
    for (const table of ["workspaces", "goals", "tasks", "chats", "turns", "anchors", "task_revisions", "goal_note_revisions"]) {
      expect(recovered.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), table).toEqual(store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    }
    recovered.close(); store.close();
  });

  it("bounds both creation and every revision without shortening exact user messages", async () => {
    const {countTokens} = await import("@socrates/shared");
    const {store} = openStore(); const text = "Long acceptance criterion. ".repeat(200);
    const event = store.recordUserMessage(text);
    const goal = store.createGoal({title: text});
    const task = store.createTask(goal.id, {title: text, objective: text});
    const revised = store.reviseTask(task.id, {title: text, objective: text, continuationNote: text});
    const noted = store.reviseGoalNote(goal.id, text);
    expect(countTokens(goal.title)).toBeLessThanOrEqual(15);
    expect(countTokens(revised.title)).toBeLessThanOrEqual(15);
    expect(countTokens(revised.objective)).toBeLessThanOrEqual(25);
    expect(countTokens(revised.continuationNote!)).toBeLessThanOrEqual(100);
    expect(countTokens(noted.note!)).toBeLessThanOrEqual(150);
    expect(store.getEvent(event.id)?.payload).toEqual({text});
  });
});

describe("goal objectives and task completion criteria", () => {
  it("stores bounded definitions and keeps criteria history in revisions", () => {
    const { store } = openStore();
    const goal = store.createGoal({ title: "German", objective: "Reach B1 German. ".repeat(30) });
    expect(countTokens(goal.objective!)).toBeLessThanOrEqual(40);
    const task = store.createTask(goal.id, { title: "Day 10", objective: "Work through Day 10.", completionCriteria: "Exercises done. ".repeat(30) });
    expect(countTokens(task.completionCriteria!)).toBeLessThanOrEqual(35);
    const revised = store.reviseTask(task.id, { completionCriteria: "All Day 10 exercises are reviewed." });
    expect(revised.completionCriteria).toBe("All Day 10 exercises are reviewed.");
    expect(store.reviseTask(task.id, { continuationNote: "Halfway." }).completionCriteria).toBe("All Day 10 exercises are reviewed.");
    expect(runLedgerQuery(store, { match: "reviewed" }, TZ).map((r) => r.taskSelector)).toEqual(["g1/t1"]);
    store.close();
  });

  it("migrates a version 1 store in place without losing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "socrates-migrate-"));
    const path = join(dir, "v1.db");
    const v1 = SCHEMA_SQL.replace(/^\s*objective\s+TEXT,\n/m, "").replace(/^\s*completion_criteria TEXT,\n/gm, "").replace(/^\s*lane_id\s+TEXT,\n/m, "");
    expect(v1).not.toContain("completion_criteria");
    const raw = new DatabaseSync(path);
    raw.exec(v1);
    raw.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
    raw.exec(`INSERT INTO goals (id, goal_number, title, status, is_general, note_revision, created_at, updated_at)
              VALUES ('goal_old', 1, 'Old goal', 'open', 0, 0, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`);
    raw.close();

    const store = LedgerStore.open({ path });
    expect(store.getMeta("schema_version")).toBe(String(SCHEMA_VERSION));
    expect(store.requireGoal("goal_old")).toMatchObject({ title: "Old goal", objective: null });
    const task = store.createTask("goal_old", { title: "New task", completionCriteria: "It works." });
    expect(task.completionCriteria).toBe("It works.");
    store.close();
    expect(LedgerStore.open({ path }).getMeta("schema_version")).toBe(String(SCHEMA_VERSION));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("tool evidence", () => {
  function boundTask(store: LedgerStore) {
    const goal = store.createGoal({ title: "Website" });
    const task = store.createTask(goal.id, { title: "Fix hero" });
    const user = store.recordUserMessage("Fix the hero.");
    const turn = store.bindTurn({ userEventId: user.id, taskId: task.id, route: "create_new" });
    return { goal, task, turn, refs: { goal_id: goal.id, task_id: task.id, chat_id: turn.chatId, turn_id: turn.id } };
  }

  function completed(handle: string, overrides: Partial<Parameters<LedgerStore["recordToolResult"]>[1]> = {}) {
    return { call_id: `call_${handle}`, handle, tool: "edit", status: "ok" as const, content: "{}", result: { changed: true }, error: null, diagnostics: null, observed: [], facts: [], wall_time_ms: 5, ...overrides };
  }

  it("numbers calls per task permanently and refuses a second result for one call", () => {
    const { store } = openStore();
    const a = boundTask(store);
    const first = store.recordToolCall(a.refs, { callId: "call_e1", tool: "read", input: { path: "a.ts" } });
    const second = store.recordToolCall(a.refs, { callId: "call_e2", tool: "edit", input: { path: "a.ts" } });
    expect([first.handle, second.handle]).toEqual(["e1", "e2"]);
    const otherGoal = store.createGoal({ title: "German" });
    const other = store.createTask(otherGoal.id, { title: "Day 1" });
    expect(store.recordToolCall({ goal_id: otherGoal.id, task_id: other.id }, { callId: "x", tool: "read", input: {} }).handle).toBe("e1");
    store.recordToolResult(a.refs, completed("e2", { observed: [{ path: "a.ts", hash: "h1" }], facts: [{ kind: "file_changed", value: "a.ts" }] }));
    expect(() => store.recordToolResult(a.refs, completed("e2"))).toThrow(/already recorded/);
    expect(store.getEvidence(a.task.id, 2)).toMatchObject({ handle: "e2", tool: "edit", status: "ok", input: { path: "a.ts" } });
    expect(store.getEvidence(a.task.id, 1)).toMatchObject({ status: null, result: null });
    expect(store.observedHash(a.task.id, "a.ts")).toEqual({ hash: "h1" });
    expect(store.evidenceForTurn(a.turn.id).map((e) => e.handle)).toEqual(["e1", "e2"]);
  });

  it("rebuilds evidence, observations, facts, capabilities, and the Q&A index from events alone", () => {
    const { store } = openStore();
    const a = boundTask(store);
    store.recordToolCall(a.refs, { callId: "c1", tool: "edit", input: { path: "a.ts" } });
    store.recordToolResult(a.refs, completed("e1", { observed: [{ path: "a.ts", hash: "h2" }], facts: [{ kind: "file_changed", value: "a.ts" }] }));
    store.activateCapability(a.goal.id, { kind: "skill", name: "pdf", version: "v1", digest: "d" }, a.refs);
    store.activateCapability(a.goal.id, { kind: "mcp", name: "github.get_issue", version: "v2", digest: "d2" }, a.refs);
    store.deactivateCapability(a.goal.id, "pdf", a.refs);
    const reply = store.recordResponse("Hero overflow fixed at 375px.", a.refs);
    store.completeTurn(a.turn.id, { responseEventId: reply.id, continuationNote: "Fixed." });

    const recovered = LedgerStore.open({ path: ":memory:" });
    recovered.restoreEvents(store.listEvents());
    expect(recovered.getEvidence(a.task.id, 1)).toMatchObject({ handle: "e1", status: "ok" });
    expect(recovered.observedHash(a.task.id, "a.ts")).toEqual({ hash: "h2" });
    expect(recovered.taskFacts(a.task.id).map((f) => f.value)).toEqual(["a.ts"]);
    expect(recovered.listActiveCapabilities(a.goal.id).map((c) => c.name)).toEqual(["github.get_issue"]);
    expect(recovered.searchExchanges({ fts: toFtsQuery("hero overflow"), limit: 5 }).map((h) => h.projectTurn)).toEqual([1]);
  });

  it("backfills the Q&A index when a version 2 store is opened", () => {
    const dir = mkdtempSync(join(tmpdir(), "socrates-migrate-"));
    const path = join(dir, "v2.db");
    const original = LedgerStore.open({ path });
    const a = boundTask(original);
    const reply = original.recordResponse("Hero overflow fixed.", a.refs);
    original.completeTurn(a.turn.id, { responseEventId: reply.id });
    original.db.exec("DELETE FROM exchange_fts");
    // A version 2 store predates each turn's lane.
    original.db.exec("ALTER TABLE turns DROP COLUMN lane_id");
    original.setMeta("schema_version", "2");
    original.close();
    const upgraded = LedgerStore.open({ path });
    expect(upgraded.getMeta("schema_version")).toBe(String(SCHEMA_VERSION));
    expect(upgraded.searchExchanges({ fts: toFtsQuery("overflow"), limit: 5 })).toHaveLength(1);
    upgraded.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("arms the first-mutation gate only for low-confidence bindings until a mutation is approved", () => {
    const { store } = openStore();
    const goal = store.createGoal({ title: "Website" });
    const task = store.createTask(goal.id, { title: "Fix hero" });
    expect(store.firstMutationGatePending(task.id)).toBe(false);
    const user = store.recordUserMessage("Fix it.");
    store.bindTurn({ userEventId: user.id, taskId: task.id, route: "resume_existing", workspaceConfidence: "low", gateArmed: true });
    expect(store.firstMutationGatePending(task.id)).toBe(true);
    store.recordApproval({ goal_id: goal.id, task_id: task.id }, { kind: "first_mutation", granted: false, detail: "edit a.ts" });
    expect(store.firstMutationGatePending(task.id)).toBe(true);
    store.recordApproval({ goal_id: goal.id, task_id: task.id }, { kind: "first_mutation", granted: true, detail: "edit a.ts" });
    expect(store.firstMutationGatePending(task.id)).toBe(false);
  });
});

describe("lanes", () => {
  /** One completed exchange in a task, sent to the main conversation or a lane. */
  function turnIn(store: LedgerStore, taskId: string, text: string, laneId: string | null = null) {
    const user = store.recordUserMessage(text, laneId);
    const turn = store.bindTurn({ userEventId: user.id, taskId, route: "test" });
    store.completeTurn(turn.id, { responseEventId: store.recordResponse(`Re: ${text}`, { turn_id: turn.id }).id });
    return store.requireTurn(turn.id);
  }

  it("numbers lanes for good, keeps each conversation's current task and history apart, and rebuilds them from events", () => {
    const { store, clock } = openStore();
    const goal = store.createGoal({ title: "Shop" });
    const main = store.createTask(goal.id, { title: "Checkout" });
    const side = store.createTask(goal.id, { title: "Docs" });
    const a = store.openLane();
    const b = store.openLane();
    expect([a.number, b.number]).toEqual([1, 2]);

    turnIn(store, main.id, "Fix checkout.");
    const inLane = turnIn(store, side.id, "Write the docs.", a.id);
    expect(inLane.laneId).toBe(a.id);
    expect(store.currentBinding()!.task.id).toBe(main.id);
    expect(store.currentBinding(a.id)!.task.id).toBe(side.id);
    expect(store.currentBinding(b.id)).toBeNull();
    expect([...store.recentExchanges()].map((e) => e.userMessage)).toEqual(["Fix checkout."]);
    expect([...store.recentExchanges([null, a.id])].map((e) => e.userMessage)).toEqual(["Write the docs.", "Fix checkout."]);

    // A clarification belongs to the conversation that asked it.
    const question = store.recordUserMessage("Open the other one.", b.id);
    store.recordClarification(question.id, "Which one?");
    expect(store.pendingClarification()).toBeNull();
    expect(store.pendingClarification(b.id)?.laneId).toBe(b.id);

    // A main turn handed to a lane leaves main's current task as it was.
    const handed = turnIn(store, side.id, "Also add a changelog.");
    expect(store.currentBinding()!.task.id).toBe(side.id);
    expect(store.moveTurnToLane(handed.id, a.id).laneId).toBe(a.id);
    expect(store.currentBinding()!.task.id).toBe(main.id);

    store.closeLane(b.id);
    expect(store.listLanes().map((l) => l.number)).toEqual([1]);
    expect(store.openLane().number).toBe(3);

    const rebuilt = LedgerStore.open({ path: ":memory:", clock });
    rebuilt.restoreEvents(store.listEvents());
    expect(rebuilt.listLanes({ includeClosed: true })).toEqual(store.listLanes({ includeClosed: true }));
    expect(rebuilt.requireTurn(handed.id).laneId).toBe(a.id);
    expect(rebuilt.currentBinding()!.task.id).toBe(main.id);
    expect(rebuilt.pendingClarification(b.id)?.id).toBe(store.pendingClarification(b.id)?.id);
    rebuilt.close();
    store.close();
  });

  it("migrates a version 4 store: every existing turn belongs to the main conversation", () => {
    const dir = mkdtempSync(join(tmpdir(), "socrates-migrate-"));
    const path = join(dir, "v4.db");
    const original = LedgerStore.open({ path });
    const goal = original.createGoal({ title: "Old" });
    const task = original.createTask(goal.id, { title: "Old task" });
    turnIn(original, task.id, "Earlier work.");
    original.db.exec("ALTER TABLE turns DROP COLUMN lane_id");
    original.db.exec("DROP TABLE lanes");
    original.setMeta("schema_version", "4");
    original.close();

    const upgraded = LedgerStore.open({ path });
    expect(upgraded.getMeta("schema_version")).toBe(String(SCHEMA_VERSION));
    expect(upgraded.currentBinding()!.task.id).toBe(task.id);
    expect(upgraded.openLane().number).toBe(1);
    upgraded.close();
    rmSync(dir, { recursive: true, force: true });
  });
});


describe("handoff history boundaries", () => {
  it("does not resurrect a clarification after its answer moves to a lane, including replay", () => {
    const { store } = openStore();
    const goal = store.createGoal({ title: "Shop" });
    const task = store.createTask(goal.id, { title: "Checkout" });
    const lane = store.openLane();
    const question = store.recordClarification(store.recordUserMessage("Which?").id, "This one?");
    const answer = store.bindTurn({ userEventId: store.recordUserMessage("Yes").id, taskId: task.id, route: "test", clarificationTurnId: question.id });
    store.moveTurnToLane(answer.id, lane.id);
    expect(store.pendingClarification()).toBeNull();
    const replay = openStore().store;
    replay.restoreEvents(store.listEvents());
    expect(replay.pendingClarification()).toBeNull();
    replay.close(); store.close();
  });

  it("filters compound responses and bindings to the requested conversation", () => {
    const { store } = openStore();
    const goal = store.createGoal({ title: "Shop" });
    const first = store.createTask(goal.id, { title: "One" });
    const second = store.createTask(goal.id, { title: "Two" });
    const lane = store.openLane();
    const user = store.recordUserMessage("Do both");
    const a = store.bindTurn({ userEventId: user.id, taskId: first.id, route: "test", partOrder: 1 });
    const b = store.bindTurn({ userEventId: user.id, taskId: second.id, route: "test", partOrder: 2 });
    store.completeTurn(a.id, { responseEventId: store.recordResponse("MAIN ANSWER").id });
    store.completeTurn(b.id, { responseEventId: store.recordResponse("LANE ANSWER").id });
    store.moveTurnToLane(b.id, lane.id);
    const main = [...store.recentExchanges()][0]!;
    expect(main.response).toBe("MAIN ANSWER");
    expect(main.bindings.map((b) => b.taskId)).toEqual([first.id]);
    expect([...store.recentExchanges([lane.id])][0]!.response).toBe("LANE ANSWER");
    store.close();
  });
});

describe("event listeners", () => {
  it("announce events once durable: at once, or when their transaction commits; never rolled-back ones", () => {
    const { store } = openStore();
    const seen: string[] = [];
    const stop = store.onEvent((e) => seen.push(`${e.type}:${(e.payload as { text?: string }).text ?? ""}`));
    store.onEvent(() => { throw new Error("a broken listener changes nothing"); });
    store.recordUserMessage("one");
    store.transaction(() => {
      store.recordUserMessage("two");
      expect(seen).toEqual(["user_message:one"]);
      // A failed savepoint drops only its own events.
      expect(() => store.transaction(() => { store.recordUserMessage("lost"); throw new Error("no"); })).toThrow("no");
      store.recordUserMessage("three");
    });
    expect(seen).toEqual(["user_message:one", "user_message:two", "user_message:three"]);
    expect(() => store.transaction(() => { store.recordUserMessage("rolled back"); throw new Error("no"); })).toThrow("no");
    stop();
    store.recordUserMessage("after unsubscribe");
    expect(seen).toHaveLength(3);
    const rebuilt = LedgerStore.open({ path: ":memory:" });
    const restored: string[] = [];
    rebuilt.onEvent((e) => restored.push(e.type));
    rebuilt.restoreEvents(store.listEvents());
    expect(restored).toEqual([]);
    rebuilt.close();
    store.close();
  });
});
