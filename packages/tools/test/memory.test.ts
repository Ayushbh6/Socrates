import { countTokens } from "@socrates/shared";
import { describe, expect, it } from "vitest";
import { type LoadedMcpTool, type LoadedSkill, RESULT_CEILING_TOKENS, StaticCatalog } from "../src";
import { type Harness, harness } from "./helpers";

/** Complete the harness's current turn with a visible response, then bind a fresh one. */
function finish(h: Harness, response: string, note = "Progress noted.") {
  const reply = h.store.recordResponse(response, { goal_id: h.binding.goalId, task_id: h.binding.taskId, turn_id: h.binding.turnId });
  h.store.completeTurn(h.binding.turnId!, { responseEventId: reply.id, continuationNote: note });
  h.nextTurn();
}

/** A second goal with one completed exchange, as another part of the user's history. */
function otherGoal(h: Harness) {
  const goal = h.store.createGoal({ title: "German learning", objective: "Reach B1 German." });
  const task = h.store.createTask(goal.id, { title: "Dative prepositions", objective: "Learn dative prepositions." });
  const user = h.store.recordUserMessage("I keep confusing accusative and dative after two-way prepositions.");
  const turn = h.store.bindTurn({ userEventId: user.id, taskId: task.id, route: "create_new" });
  const reply = h.store.recordResponse("Decide from motion versus location, not from the verb.", { task_id: task.id, turn_id: turn.id });
  h.store.completeTurn(turn.id, { responseEventId: reply.id, continuationNote: "Explained two-way prepositions." });
  return { goal, task, turn };
}

describe("context_retrieve", () => {
  it("ledger_search discovers goals and tasks by metadata, scoped to the current goal by default", async () => {
    const h = harness();
    otherGoal(h);
    h.store.createTask(h.binding.goalId, { title: "Mobile layout", objective: "Fix the mobile hero layout." });
    const local = await h.call("context_retrieve", { action: "ledger_search", query: "mobile layout" });
    expect(local.json.results).toEqual([expect.objectContaining({ kind: "task", selector: "g1/t2", title: "Mobile layout", goal: "g1 — Project work" })]);
    const none = await h.call("context_retrieve", { action: "ledger_search", query: "dative" });
    expect(none.json.results).toEqual([]);
    const all = await h.call("context_retrieve", { action: "ledger_search", query: "dative", scope: "all_goals" });
    expect(all.json.results.map((r: any) => r.selector)).toEqual(["g2/t1"]);
    const goals = await h.call("context_retrieve", { action: "ledger_search", scope: "all_goals", entity: "goals" });
    expect(goals.json.results.map((r: any) => r.selector).sort()).toEqual(["g1", "g2"]);
    const paged = await h.call("context_retrieve", { action: "ledger_search", scope: "all_goals", limit: 1 });
    expect(paged.json.more_matches).toBe(true);
    const next = await h.call("context_retrieve", { action: "ledger_search", scope: "all_goals", limit: 1, cursor: paged.json.next_cursor });
    expect(next.json.results[0].selector).not.toBe(paged.json.results[0].selector);
  });

  it("search finds exact Q&A pairs within the target and issues short refs", async () => {
    const h = harness();
    otherGoal(h);
    finish(h, "The server crashes because PORT is unset; I added a default.");
    const current = await h.call("context_retrieve", { action: "search", query: "server crashes port" });
    expect(current.json.results).toEqual([
      expect.objectContaining({ ref: "r1", project_turn: 1, goal: "Project work", user_message: "Please fix the server.", complete: true, omitted: null }),
    ]);
    expect(current.json.results[0].socrates_response).toContain("PORT is unset");
    const elsewhere = await h.call("context_retrieve", { action: "search", query: "dative prepositions" });
    expect(elsewhere.json.results).toEqual([]);
    const everywhere = await h.call("context_retrieve", { action: "search", query: "dative prepositions", target: "all_goals" });
    expect(everywhere.json.results[0]).toMatchObject({ ref: "r2", goal: "German learning" });
    const exact = await h.call("context_retrieve", { action: "search", query: "PORT is unset", match: "exact", target: "current_goal" });
    expect(exact.json.results).toHaveLength(1);
    const byDate = await h.call("context_retrieve", { action: "search", from: "2026-09-01", to: "2026-09-01", target: "all_goals" });
    expect(byDate.json.returned).toBe(2);
    expect((await h.call("context_retrieve", { action: "search" })).json.error.code).toBe("query_or_range_required");
  });

  it("never widens a bare task selector to other goals", async () => {
    const h = harness();
    otherGoal(h);
    const bare = await h.call("context_retrieve", { action: "search", query: "dative", target: "t5" });
    expect(bare.json.error.code).toBe("task_not_found_in_current_goal");
    expect(bare.json.error.correction).toContain("gN/tN");
    const local = await h.call("context_retrieve", { action: "search", query: "server", target: "t1" });
    expect(local.json.resolved_target).toEqual({ goal: "g1 — Project work", task: "g1/t1 — Fix the server" });
    expect(local.json.scope_note).toContain("current goal");
    const explicit = await h.call("context_retrieve", { action: "search", query: "dative", target: "g2/t1" });
    expect(explicit.json.returned).toBe(1);
  });

  it("inspects goals, tasks, turns, search refs, and evidence handles", async () => {
    const h = harness({ files: { "a.ts": "const a = 1;\n" } });
    await h.call("read", { path: "a.ts" });
    await h.call("edit", { path: "a.ts", old_text: "const a = 1;", new_text: "const a = 2;" });
    finish(h, "Changed a to 2.");

    const goal = await h.call("context_retrieve", { action: "inspect", ref: "g1" });
    expect(goal.json.goal).toMatchObject({ selector: "g1", title: "Project work", objective: "Ship the project." });
    expect(goal.json.tasks).toEqual([expect.objectContaining({ selector: "g1/t1" })]);

    const task = await h.call("context_retrieve", { action: "inspect", ref: "t1" });
    expect(task.json.task).toMatchObject({ selector: "g1/t1", note: "Progress noted." });
    expect(task.json.files_changed).toEqual(["a.ts"]);
    expect(task.json.turns).toEqual([1, 2]);

    const turn = await h.call("context_retrieve", { action: "inspect", turn_number: 1 });
    expect(turn.json.user_message).toMatchObject({ content: "Please fix the server.", complete: true });
    expect(turn.json.final_response.content).toBe("Changed a to 2.");
    expect(turn.json.tool_activity.map((t: any) => [t.ref, t.tool, t.status])).toEqual([["e1", "read", "ok"], ["e2", "edit", "ok"]]);

    const evidence = await h.call("context_retrieve", { action: "inspect", ref: "e2" });
    expect(evidence.json.evidence).toMatchObject({ ref: "e2", tool: "edit", status: "ok", project_turn: 1 });
    expect(evidence.json.output.content).toContain("const a = 2;");

    await h.call("context_retrieve", { action: "search", query: "changed" });
    const viaRef = await h.call("context_retrieve", { action: "inspect", ref: "r1" });
    expect(viaRef.json.turn).toMatchObject({ ref: "r1", project_turn: 1 });
  });

  it("fails closed with corrective errors for unknown and foreign references", async () => {
    const h = harness();
    const other = otherGoal(h);
    const e = (await h.call("context_retrieve", { action: "inspect", ref: "e9" })).json.error;
    expect(e.code).toBe("evidence_not_found");
    expect((await h.call("context_retrieve", { action: "inspect", ref: "hc-3" })).json.error.code).toBe("checkpoint_not_found");
    expect((await h.call("context_retrieve", { action: "inspect", ref: "r4" })).json.error.code).toBe("unknown_reference");
    expect((await h.call("context_retrieve", { action: "inspect", ref: "g99" })).json.error.code).toBe("goal_not_found");
    const turn = (await h.call("context_retrieve", { action: "inspect", turn_number: 99 })).json.error;
    expect(turn.code).toBe("turn_not_found");
    expect(turn.correction).toContain("between 1 and 2");
    expect((await h.call("context_retrieve", { action: "inspect", ref: "g1", turn_number: 1 })).json.error.code).toBe("one_reference_required");
    // A turn of another task shows its activity without handles that would resolve against the wrong task.
    const foreign = await h.call("context_retrieve", { action: "inspect", turn_number: other.turn.projectTurn });
    expect(foreign.json.turn.goal).toBe("German learning");
  });

  it("bounds an oversized turn with explicit omissions", async () => {
    const h = harness({ files: { "huge.txt": `${"a".repeat(120)}\n`.repeat(4000) } });
    for (let i = 0; i < 6; i++) await h.call("read", { path: "huge.txt", offset: 1 + i * 500, limit: 500 });
    const reply = h.store.recordResponse(`Summary. ${"detail ".repeat(8000)}`, { task_id: h.binding.taskId, turn_id: h.binding.turnId });
    h.store.completeTurn(h.binding.turnId!, { responseEventId: reply.id, continuationNote: "n" });
    h.nextTurn();
    const r = await h.call("context_retrieve", { action: "inspect", turn_number: 1 });
    expect(countTokens(r.content)).toBeLessThanOrEqual(RESULT_CEILING_TOKENS);
    expect(Buffer.byteLength(r.content)).toBeLessThanOrEqual(50 * 1024);
    expect(r.json.final_response.complete).toBe(false);
    expect(r.json.final_response.omitted).toContain("omitted");
    expect(r.json.tool_activity).toHaveLength(6);
  });
});

const PDF_SKILL: LoadedSkill = { version: "v3", instructions: "# PDF\nUse pdftotext to read PDFs.", resourceBase: { kind: "directory", path: "/skills/pdf" }, dependencies: ["github.get_issue"] };
const ISSUE_TOOL: LoadedMcpTool = { schemaVersion: "v2", description: "Read one GitHub issue", inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] }, connection: "connected" };

function catalog() {
  return new StaticCatalog(
    [
      { kind: "skill", name: "pdf", description: "Read, render, inspect, and create PDF files.", tags: ["documents"], aliases: ["pdf-tools"], provider: "workspace", availability: "available" },
      { kind: "skill", name: "spreadsheets", description: "Analyze and edit spreadsheet files.", tags: ["excel"], aliases: [], provider: "workspace", availability: "available" },
      { kind: "mcp", name: "github.get_issue", server: "github", tool: "get_issue", description: "Read one GitHub issue", tags: ["github", "issues"], aliases: [], availability: "available" },
      { kind: "mcp", name: "github.create_issue", server: "github", tool: "create_issue", description: "Create a GitHub issue", tags: ["github", "issues"], aliases: [], availability: "available" },
      { kind: "mcp", name: "linear.get_issue", server: "linear", tool: "get_issue", description: "Read one Linear issue", tags: ["issues"], aliases: [], availability: "authentication_required" },
    ],
    { pdf: PDF_SKILL },
    { "github.get_issue": ISSUE_TOOL },
  );
}

describe("capability_search and capability_control", () => {
  it("ranks exact names first and reserves room for both kinds", async () => {
    const h = harness({ catalog: catalog() });
    const exact = await h.call("capability_search", { query: "pdf" });
    expect(exact.json.matches[0]).toMatchObject({ ref: "c1", name: "pdf", kind: "skill", active: false });
    const issues = await h.call("capability_search", { query: "read a github issue pdf", limit: 2 });
    expect(issues.json.matches.map((m: any) => m.kind).sort()).toEqual(["mcp", "skill"]);
    const onlyMcp = await h.call("capability_search", { query: "issue", kind: "mcp", limit: 5 });
    expect(onlyMcp.json.matches.every((m: any) => m.kind === "mcp")).toBe(true);
    expect(onlyMcp.json.matches.find((m: any) => m.name === "linear.get_issue").availability).toBe("authentication_required");
    const empty = await h.call("capability_search", { query: "quantum chemistry" });
    expect(empty.json).toMatchObject({ matches: [], returned: 0 });
    expect(empty.json.note).toBeTruthy();
  });

  it("activates a Skill with its full instructions once, and reports dependencies without activating them", async () => {
    const h = harness({ catalog: catalog() });
    const ref = (await h.call("capability_search", { query: "pdf" })).json.matches[0].ref;
    const first = await h.call("capability_control", { action: "activate", ref });
    expect(first.json).toMatchObject({ kind: "skill", name: "pdf", status: "activated", version: "v3", instructions: PDF_SKILL.instructions });
    expect(first.json.dependencies).toEqual([{ kind: "mcp", name: "github.get_issue", status: "inactive" }]);
    const again = await h.call("capability_control", { action: "activate", ref });
    expect(again.json).toEqual({ kind: "skill", name: "pdf", status: "already_active", version: "v3" });
    expect(h.store.listActiveCapabilities(h.binding.goalId).map((c) => c.name)).toEqual(["pdf"]);
  });

  it("activates an MCP tool for the goal and exposes its schema to the next request", async () => {
    const h = harness({ catalog: catalog() });
    const ref = (await h.call("capability_search", { query: "github.get_issue" })).json.matches[0].ref;
    const r = await h.call("capability_control", { action: "activate", ref });
    expect(r.json).toMatchObject({ kind: "mcp", status: "activated", public_name: "mcp__github__get_issue", available_on_next_step: true });
    expect(h.runner.mcpDefinitions(h.binding.goalId)).toEqual([{ name: "mcp__github__get_issue", description: "Read one GitHub issue", inputSchema: ISSUE_TOOL.inputSchema }]);
    const listed = await h.call("capability_control", { action: "list" });
    expect(listed.json.active).toEqual([{ kind: "mcp", name: "github.get_issue", version: "v2", public_name: "mcp__github__get_issue" }]);
    const off = await h.call("capability_control", { action: "deactivate", name: "mcp__github__get_issue" });
    expect(off.json.status).toBe("deactivated");
    expect(h.runner.mcpDefinitions(h.binding.goalId)).toEqual([]);
  });

  it("fails truthfully for stale refs, authentication, and inactive names", async () => {
    const h = harness({ catalog: catalog() });
    expect((await h.call("capability_control", { action: "activate", ref: "c7" })).json.error.code).toBe("unknown_capability_ref");
    const linear = (await h.call("capability_search", { query: "linear.get_issue" })).json.matches[0].ref;
    const auth = await h.call("capability_control", { action: "activate", ref: linear });
    expect(auth.json.error).toMatchObject({ code: "authentication_required", retryable: false });
    expect(auth.json.error.correction).toContain("do not ask for credentials");
    expect((await h.call("capability_control", { action: "deactivate", name: "pdf" })).json.error.code).toBe("capability_not_active");
  });
});
