import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Socrates } from "../src";
import { LedgerStore } from "@socrates/store";
import { ScriptedModel } from "@socrates/providers";
import { continueTask } from "../../router/test/helpers";
import { call, final, world } from "./helpers";

const proposal = (file = "PLAN.md", role = "goal_plan") => ({ path: file, role, reason: "Durable project authority." });
const setup = () => world({ files: { "PLAN.md": "Original plan", "NEW.md": "New plan", "SPEC.md": "Spec", "NEXT.md": "New spec" } });

describe("anchor authority lifecycle", () => {
  it("promotes a provisional anchor on direct user approval without requiring another model proposal", async () => {
    const w = await setup();
    const h = w.socrates([continueTask(), continueTask()], [final({ anchors: [proposal()] }), final()]);
    const first = await h.socrates.handle("Plan the work");
    expect(first.kind === "answered" && first.parts[0]!.anchorChanges).toEqual([{ path: "PLAN.md", role: "goal_plan", status: "provisional" }]);
    await h.socrates.handle("I approve PLAN.md as the active canonical goal plan.");
    expect(w.store.listAnchors(w.goalId)).toMatchObject([{ path: "PLAN.md", status: "active" }]);
  });

  it("honors an explicit canonical declaration for a new file", async () => {
    const w = await setup();
    const h = w.socrates([continueTask()], [final()]);
    await h.socrates.handle('Use "PLAN.md" as the canonical goal plan.');
    expect(w.store.listAnchors(w.goalId)).toMatchObject([{ path: "PLAN.md", role: "goal_plan", status: "active" }]);
  });

  it.each(["Do not approve PLAN.md as the canonical goal plan.", 'The file says: "I approve PLAN.md as the canonical goal plan."', "Would you approve PLAN.md as the canonical goal plan?"])("does not infer authority from negation, quotations or questions: %s", async text => {
    const w = await setup();
    const h = w.socrates([continueTask()], [final({ anchors: [proposal()] })]);
    await h.socrates.handle(text);
    expect(w.store.listAnchors(w.goalId)[0]!.status).toBe("provisional");
  });

  it("batches conflicts into one end-of-work question and applies explicit confirmation after event replay", async () => {
    const w = await setup();
    w.store.upsertAnchor({ goalId: w.goalId, path: "PLAN.md", role: "goal_plan", summary: "Plan", status: "active" });
    w.store.upsertAnchor({ goalId: w.goalId, path: "SPEC.md", role: "spec", summary: "Spec", status: "active" });
    const h = w.socrates([continueTask()], [final({ full_answer: "Safe work finished.", anchors: [proposal("NEW.md"), proposal("NEXT.md", "spec")] })]);
    const r = await h.socrates.handle("Update the project references");
    expect(r.text).toMatch(/^Safe work finished\.\n\nShould I replace/);
    expect(r.text.match(/\?/g)).toHaveLength(1);
    expect(w.store.listAnchors(w.goalId).map(a => a.path)).toEqual(["PLAN.md", "SPEC.md"]);
    const restored = LedgerStore.open({ path: ":memory:" });
    restored.restoreEvents(w.store.listEvents());
    const resumed = new Socrates({ store: restored, routerModel: new ScriptedModel("router", [continueTask()]), model: new ScriptedModel("agent", [final()]), timeZone: "UTC", approve: async () => true });
    try {
      await resumed.handle("Yes, please.");
      expect(restored.listAnchors(w.goalId).map(a => [a.path, a.status])).toEqual([["NEW.md", "active"], ["NEXT.md", "active"]]);
      const replayed = LedgerStore.open({ path: ":memory:" });
      try { replayed.restoreEvents(restored.listEvents()); expect(replayed.listAnchors(w.goalId)).toEqual(restored.listAnchors(w.goalId)); }
      finally { replayed.close(); }
    } finally { await resumed.close(); restored.close(); }
  });

  it.each(["No.", "Continue the code work."])("suppresses a declined or ignored proposal until its content changes: %s", async reply => {
    const w = await setup();
    w.store.upsertAnchor({ goalId: w.goalId, path: "PLAN.md", role: "goal_plan", summary: "Plan", status: "active" });
    const proposed = final({ anchors: [proposal("NEW.md")] });
    const h = w.socrates([continueTask(), continueTask(), continueTask(), continueTask()], [proposed, proposed, proposed, proposed]);
    expect((await h.socrates.handle("Consider a new plan")).text).toContain("Should I replace");
    expect((await h.socrates.handle(reply)).text).not.toContain("Should I replace");
    expect((await h.socrates.handle("Continue")).text).not.toContain("Should I replace");
    writeFileSync(path.join(w.root, "NEW.md"), "Materially revised plan");
    expect((await h.socrates.handle("Review the changed plan")).text).toContain("Should I replace");
  });

  it("does not apply old approval after the proposed bytes change", async () => {
    const w = await setup();
    w.store.upsertAnchor({ goalId: w.goalId, path: "PLAN.md", role: "goal_plan", summary: "Plan", status: "active" });
    const h = w.socrates([continueTask(), continueTask()], [final({ anchors: [proposal("NEW.md")] }), final()]);
    await h.socrates.handle("Consider a new plan");
    writeFileSync(path.join(w.root, "NEW.md"), "Changed after the question");
    await h.socrates.handle("Yes");
    expect(w.store.listAnchors(w.goalId).map(a => a.path)).toEqual(["PLAN.md"]);
    expect(w.store.listEvents({ type: "agent_warning" }).at(-1)!.payload).toMatchObject({ detail: expect.stringContaining("approval was not applied") });
  });

  it("does not treat a yes to another part's question as anchor approval", async () => {
    const w = await setup();
    w.store.upsertAnchor({ goalId: w.goalId, path: "PLAN.md", role: "goal_plan", summary: "Plan", status: "active" });
    const h = w.socrates([continueTask(), continueTask()], [final({ anchors: [proposal("NEW.md")] }), final()]);
    await h.socrates.handle("Consider a new plan");
    const other = w.store.turnsForTask(w.taskId)[0]!;
    w.store.recordResponse("Should I deploy the change?", { turn_id: other.id });
    await h.socrates.handle("Yes");
    expect(w.store.listAnchors(w.goalId).map(a => a.path)).toEqual(["PLAN.md"]);
  });

  it("promotes after successful use on distinct completed turns, not multiple reads in one turn", async () => {
    const w = await setup();
    const read = call("read", { path: "PLAN.md" });
    const h = w.socrates([continueTask(), continueTask(), continueTask()], [final({ anchors: [proposal()] }), { toolCalls: [read, read] }, final(), { toolCalls: [read] }, final()]);
    await h.socrates.handle("Plan the work");
    await h.socrates.handle("Use the plan");
    expect(w.store.listAnchors(w.goalId)[0]!.status).toBe("provisional");
    await h.socrates.handle("Use it again");
    expect(w.store.listAnchors(w.goalId)[0]!.status).toBe("active");
  });

  it("supports scoped application decisions for role replacement and reversible removal", async () => {
    const w = await setup();
    w.store.upsertAnchor({ goalId: w.goalId, path: "PLAN.md", role: "draft", summary: "Draft", status: "provisional" });
    const h = w.socrates([continueTask(), continueTask(), continueTask()], [final(), final(), final()]);
    await h.socrates.handle("Approve the plan", { anchorDecisions: [{ goalId: "another-goal", path: "PLAN.md", role: "goal_plan", decision: "approve" }] });
    expect(w.store.listAnchors(w.goalId)[0]!.role).toBe("draft");
    await h.socrates.handle("Approve the plan", { anchorDecisions: [{ goalId: w.goalId, path: "PLAN.md", role: "goal_plan", decision: "approve" }] });
    expect(w.store.listAnchors(w.goalId)).toMatchObject([{ role: "goal_plan", status: "active" }]);
    await h.socrates.handle("Remove the reference", { anchorDecisions: [{ goalId: w.goalId, path: "PLAN.md", role: "goal_plan", decision: "supersede" }] });
    expect(w.store.listAnchors(w.goalId)).toEqual([]);
    expect(readFileSync(path.join(w.root, "PLAN.md"), "utf8")).toBe("Original plan");
  });

  it("does not apply user decisions when the turn is cancelled or final output invalid", async () => {
    const w = await setup();
    const controller = new AbortController();
    const h = w.socrates([continueTask(), continueTask()], [{ text: "Bad" }, { text: "Still bad" }, () => { controller.abort(); return final(); }]);
    const decision = { goalId: w.goalId, path: "PLAN.md", role: "goal_plan", decision: "approve" as const };
    await h.socrates.handle("Approve the plan", { anchorDecisions: [decision] });
    await h.socrates.handle("Approve the plan", { anchorDecisions: [decision], signal: controller.signal });
    expect(w.store.listAnchors(w.goalId)).toEqual([]);
  });
});


it("keeps a main anchor confirmation pending while another lane exchanges messages", async () => {
  const w = await setup();
  w.store.upsertAnchor({ goalId: w.goalId, path: "PLAN.md", role: "goal_plan", summary: "Plan", status: "active" });
  const h = w.socrates([continueTask(), continueTask(), continueTask()], [final({ anchors: [proposal("NEW.md")] }), final(), final()]);
  await h.socrates.handle("Consider a new plan");
  await h.socrates.handle("Unrelated work", { lane: "new" });
  await h.socrates.handle("Yes");
  expect(w.store.listAnchors(w.goalId).find((a) => a.path === "NEW.md")?.status).toBe("active");
});

it("a yes in another lane cannot approve main's anchor replacement", async () => {
  const w = await setup();
  w.store.upsertAnchor({ goalId: w.goalId, path: "PLAN.md", role: "goal_plan", summary: "Plan", status: "active" });
  const h = w.socrates([continueTask(), continueTask()], [final({ anchors: [proposal("NEW.md")] }), final()]);
  await h.socrates.handle("Consider a new plan");
  await h.socrates.handle("Yes", { lane: "new" });
  expect(w.store.listAnchors(w.goalId).find((a) => a.path === "PLAN.md")?.status).toBe("active");
  expect(w.store.listAnchors(w.goalId).find((a) => a.path === "NEW.md")).toBeUndefined();
});
