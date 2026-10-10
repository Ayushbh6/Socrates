import { describe, expect, it } from "vitest";
import { createGoal, continueTask, general } from "../../router/test/helpers";
import { validateFinalAnswer } from "../src";
import { contextParts, final, world } from "./helpers";

/** The stable first part of a request, where `<MEMORY>` lives. */
const firstPart = (request: Parameters<typeof contextParts>[0]) => contextParts(request)[0]!.text;
const memoryOf = (text: string) => /<MEMORY>\n([\s\S]*?)\n<\/MEMORY>/.exec(text)?.[1] ?? null;

describe("memory", () => {
  it("keeps what the answer saves, shows the always-on entries in every goal's first part, and forgets on request", async () => {
    const w = await world();
    const { socrates, model } = w.socrates([continueTask(), createGoal("Holiday", "Plan the trip"), continueTask()], [
      final({ full_answer: "Noted.", memory: { save: [
        { text: "Prefers pnpm over npm.", kind: "preference", scope: "user" },
        { text: "Uses tabs in this repository.", kind: "preference", scope: "goal" },
        { text: "Their OpenAI key is sk-proj-abcdefghijklmnopqrstuvwx.", kind: "about", scope: "user" },
      ], forget: ["m99"] } }),
      final(),
      final({ full_answer: "Forgotten.", memory: { save: [{ text: "The Berlin trip is on 14 March.", kind: "knowledge", scope: "user" }], forget: ["m1"] } }),
      final(),
    ]);
    await socrates.handle("Remember: pnpm, tabs here, my key, and the trip.");
    expect(w.store.listMemories().map((m) => [m.handle, m.text, m.goalId ? "goal" : "user", m.by])).toEqual([
      ["m2", "Uses tabs in this repository.", "goal", "agent"],
      ["m1", "Prefers pnpm over npm.", "user", "agent"],
    ]);
    const warnings = w.store.listEvents({ type: "agent_warning" }).map((e) => (e.payload as { detail: string }).detail);
    expect(warnings).toEqual([expect.stringContaining("does not remember secrets"), "memory.forget m99: there is no such memory here."]);
    // The source turn is kept, so the page can say where it was said.
    expect(w.store.getMemoryByNumber(1)!.sourceTurnId).toBe(w.store.turnsForTask(w.taskId).at(-1)!.id);

    // Another goal sees what applies everywhere, not this goal's own, and never knowledge (that is searched for).
    await socrates.handle("Plan the Berlin trip.");
    const elsewhere = memoryOf(firstPart(model.requests.at(-1)!))!;
    expect(elsewhere).toBe("How they like to work:\n- Prefers pnpm over npm. [m1]");

    await socrates.handle("Forget the pnpm thing.", { target: { taskId: w.taskId }, pinned: true });
    expect(memoryOf(firstPart(model.requests.at(-1)!))).toBe("How they like to work:\n- Prefers pnpm over npm. [m1]\nIn this goal only:\n- Uses tabs in this repository. [m2]");
    expect(w.store.getMemoryByNumber(1)!.forgottenAt).not.toBeNull();
    expect(w.store.getMemoryByNumber(3)).toMatchObject({ kind: "knowledge", goalId: null });
    await socrates.handle("And now?", { target: { taskId: w.taskId }, pinned: true });
    expect(memoryOf(firstPart(model.requests.at(-1)!))).toBe("In this goal only:\n- Uses tabs in this repository. [m2]");
  });

  it("saves the same words once, keeps a general-conversation memory everywhere, and follows the user's switches", async () => {
    const w = await world();
    const settings = { save: true, use: true };
    const pnpm = { text: "Prefers pnpm over npm.", kind: "preference" as const, scope: "goal" as const };
    const { socrates, model } = w.socrates([general(), general(), general(), general()], [
      final({ memory: { save: [pnpm], forget: [] } }),
      final({ memory: { save: [{ ...pnpm, text: "prefers  PNPM over npm.", scope: "user" }], forget: [] } }),
      final({ memory: { save: [{ text: "Lives in Berlin.", kind: "about", scope: "user" }], forget: [] } }),
      final(),
    ], { memory: () => settings });
    await socrates.handle("I prefer pnpm.");
    expect(w.store.listMemories()).toMatchObject([{ handle: "m1", goalId: null }]);
    await socrates.handle("Really, pnpm.");
    expect(w.store.listMemories()).toHaveLength(1);

    settings.save = false;
    await socrates.handle("I live in Berlin.");
    expect(w.store.listMemories()).toHaveLength(1);
    expect(memoryOf(firstPart(model.requests.at(-1)!))).toContain("Saving new memories is turned off by the user");

    settings.use = false;
    await socrates.handle("What do you know about me?");
    expect(memoryOf(firstPart(model.requests.at(-1)!))).toBe("Saving new memories is turned off by the user: leave memory.save out, and if asked to remember something, say it is off.");
    settings.save = true;
    expect(memoryOf(firstPart(model.requests.at(-1)!))).not.toContain("pnpm");
  });

  it("is optional in the final answer, and validated when present", () => {
    expect(validateFinalAnswer(final().text).ok).toBe(true);
    expect(validateFinalAnswer(final({ memory: null }).text).ok).toBe(true);
    expect(validateFinalAnswer(JSON.stringify({ ...JSON.parse(final().text), memory: { save: [{ text: "Likes tea.", kind: "about", scope: "user" }] } })).ok).toBe(true);
    const bad = (memory: unknown) => validateFinalAnswer(JSON.stringify({ ...JSON.parse(final().text), memory }));
    expect(bad({ save: [{ text: "Likes tea.", kind: "mood", scope: "user" }] })).toMatchObject({ ok: false, errors: [expect.stringContaining("memory.save.0.kind")] });
    expect(bad({ save: Array(4).fill({ text: "Likes tea.", kind: "about", scope: "user" }) })).toMatchObject({ ok: false });
    expect(bad({ save: [{ text: "x".repeat(281), kind: "about", scope: "user" }] })).toMatchObject({ ok: false });
    expect(bad({ forget: ["4"] })).toMatchObject({ ok: false, errors: [expect.stringContaining("m4")] });
  });
});
