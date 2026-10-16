import { ScriptedModel } from "@socrates/providers";
import { LedgerStore } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { RECORDED_CASES, runRecordedCase } from "../eval/recorded-fixtures";
import { ROUTER_NATIVE_SYSTEM_PROMPT } from "../src/prompt";
import { GoalRouter } from "../src";

const correct = {
  decision: "resume_existing", goal_label: "current", task_decision: "resume_task", task_label: "current",
  new_goal_title: null, new_task_title: null, new_goal_objective: null, new_task_objective: null,
  new_task_completion_criteria: null, workspace_confidence: "high", reopen_task: false, parts: null,
  reason: "Return to the task that owns the referenced subject.",
};

describe("recorded image/context routing regressions", () => {
  for (const fixture of RECORDED_CASES) {
    it(`${fixture.id}: sends the recorded context with current production prompt/tools`, async () => {
      const model = new ScriptedModel("openrouter:oracle", [{ toolCalls: [{ name: "routing_result", input: correct }] }]);
      expect((await runRecordedCase(model, fixture, "off")).passed).toBe(true);
      const request = model.requests[0]!;
      expect(request.system).toBe(ROUTER_NATIVE_SYSTEM_PROMPT);
      expect(request.messages).toEqual([{ role: "user", content: fixture.input }]);
      expect(request.tools?.map(t => t.name)).toEqual(["ledger_query", "ask_user", "routing_result"]);
      expect(request.effort).toBe("off");
      expect(request.toolChoice).toBe("required");
      expect(fixture.input.match(/^# CURRENT_REQUEST$/gm)).toHaveLength(1);
      expect(fixture.input).toContain("older_history_omitted: false");
      expect(fixture.input).not.toContain("/Users/");
      expect(fixture.input).toContain(`goal_ref: ${fixture.goalRef}\ntask_ref: ${fixture.taskRef}`);
    });
  }

  it("matches production model-facing settings for native and other providers", async () => {
    for (const id of ["openrouter:oracle", "openai:oracle", "gemini:oracle"]) {
      const store = LedgerStore.open({ path: ":memory:" });
      try {
        const model = new ScriptedModel(id, [{ toolCalls: [{ name: "routing_result", input: {
          ...correct, goal_label: "general", task_decision: null, task_label: null, reopen_task: null,
        } }] }]);
        await new GoalRouter({ store, routerModel: model, timeZone: "UTC", effort: "off" }).route("Hello");
        const recorded = new ScriptedModel(id, [{ toolCalls: [{ name: "routing_result", input: correct }] }]);
        await runRecordedCase(recorded, RECORDED_CASES[0]!, "off");
        const live = model.requests[0]!, replay = recorded.requests[0]!;
        for (const key of ["system", "tools", "toolChoice", "maxOutputTokens", "temperature", "effort"] as const) {
          expect(replay[key], key).toEqual(live[key]);
        }
      } finally { store.close(); }
    }
  });

  it("counts the original wrong destinations as failures even when the reason names the right subject", async () => {
    for (const fixture of RECORDED_CASES) {
      const wrong = fixture.id === "R-Q6"
        ? { goal_label: "current", task_label: "task_1", reason: "The question refers to 4x + 8 = 24 in the completed linear-equations task." }
        : { goal_label: "older_1", task_label: "latest", reason: "The user explicitly returns to the German website image." };
      const model = new ScriptedModel("wrong", [{ toolCalls: [{ name: "routing_result", input: { ...correct, ...wrong } }] }]);
      expect((await runRecordedCase(model, fixture)).passed).toBe(false);
      expect(model.requests).toHaveLength(1);
    }
  });

  it("keeps Q6 unresolved after a passing sample and rejects reopening, malformed or non-routing answers", async () => {
    const fixture = RECORDED_CASES.find(f => f.id === "R-Q6")!;
    expect(fixture.status).toBe("unresolved");
    for (const input of [{ ...correct, reopen_task: true }, { ...correct, task_decision: "create_task" }, {}]) {
      const model = new ScriptedModel("invalid", [{ toolCalls: [{ name: "routing_result", input }] }]);
      expect((await runRecordedCase(model, fixture)).passed).toBe(false);
    }
    const prose = new ScriptedModel("prose", [{ text: "Continue the linear-equations task." }]);
    expect((await runRecordedCase(prose, fixture)).passed).toBe(false);
    const pass = new ScriptedModel("correct", [{ toolCalls: [{ name: "routing_result", input: correct }] }]);
    expect((await runRecordedCase(pass, fixture)).passed).toBe(true);
    expect(fixture.status).toBe("unresolved");
  });
});
