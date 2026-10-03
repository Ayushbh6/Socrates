import { renameSync, symlinkSync } from "node:fs";
import path from "node:path";
import { HashEmbedder } from "@socrates/providers";
import { Retrieval, type SemanticHit, type SemanticIndex, fileSections, sectionHash } from "@socrates/retrieval";
import { countTokens } from "@socrates/shared";
import { WorkspaceRoot } from "@socrates/tools";
import { describe, expect, it } from "vitest";
import { continueTask } from "../../router/test/helpers";
import { ANCHOR_WHOLE_MAX_TOKENS, projectContext } from "../src";
import { contextText, final, tempDir, world, writeFiles } from "./helpers";

/** A 30-day plan well over the whole-file limit, one section per day. */
const PLAN = `# 30-day German plan\nReach B1 through daily lessons.\n\n${Array.from({ length: 30 }, (_, i) => `## Day ${i + 1}\nLesson ${i + 1}: ${["dative prepositions mit nach bei", "accusative articles", "modal verbs", "separable verbs", "perfect tense"][i % 5]} with twenty practice sentences, a listening exercise, a short review of earlier vocabulary words, and a dialogue to read aloud twice before writing a summary of it.\nHomework: ten new nouns with their articles and plurals.\n`).join("\n")}`;

/** A meaning match on the section of `content` with this heading, or its first section. */
function hit(path: string, content: string, heading?: string, similarity = 0.5): SemanticHit {
  const sections = fileSections(path, content);
  const section = heading ? sections.find((s) => s.heading === heading)! : sections[0]!;
  return { kind: "file_section", sourceId: `ws:${path}`, goalId: null, taskId: null, turnId: null, projectTurn: null, workspaceId: "ws", path, hash: sectionHash(path, section), at: "2026-09-01T00:00:00.000Z", similarity };
}

async function anchored(files: Record<string, string>, anchors: { path: string; role: string }[]) {
  const w = await world({ files });
  for (const a of anchors) w.store.upsertAnchor({ goalId: w.goalId, path: a.path, role: a.role, summary: "", status: "active" });
  return { w, workspace: WorkspaceRoot.open("project", w.root) };
}

describe("<PROJECT_CONTEXT>", () => {
  it("shows a small anchor whole, and a large one as an outline with the sections the task's note points to", async () => {
    expect(countTokens(PLAN)).toBeGreaterThan(ANCHOR_WHOLE_MAX_TOKENS);
    const { w } = await anchored({ "learning/30-day-plan.md": PLAN, "learning/rules.md": "Always answer in German first." }, [
      { path: "learning/30-day-plan.md", role: "goal_plan" },
      { path: "learning/rules.md", role: "style" },
    ]);
    const t = w.store.bindTurn({ userEventId: w.store.recordUserMessage("Finish Day 9.").id, taskId: w.taskId, route: "continue" });
    w.store.completeTurn(t.id, { responseEventId: w.store.recordResponse("Done.", { turn_id: t.id }).id, continuationNote: "Day 9 completed. Day 10 is next." });
    const { socrates, model } = w.socrates([continueTask()], [final()]);
    await socrates.handle("Okay, let's start today's lesson.");
    const text = contextText(model.requests[0]!);
    const block = text.slice(text.indexOf("<PROJECT_CONTEXT>"), text.indexOf("</PROJECT_CONTEXT>"));
    // After the retrieved history and before the current message.
    expect(text.indexOf("<PROJECT_CONTEXT>")).toBeGreaterThan(text.indexOf("<CURRENT_TASK>"));
    expect(text.indexOf("</PROJECT_CONTEXT>")).toBeLessThan(text.indexOf("<CURRENT_USER_MESSAGE>"));
    expect(block).toContain("anchor learning/rules.md — style (whole file)\nAlways answer in German first.");
    expect(block).toContain("anchor learning/30-day-plan.md — goal_plan (");
    expect(block).toContain("- Day 10 (line ");
    expect(block).toMatch(/--- learning\/30-day-plan\.md › Day 10 \(lines \d+–\d+\)\n## Day 10\nLesson 10/);
    expect(block).not.toContain("› Day 25");
  });

  it("selects a section by meaning, ignores a vector of content that has since changed, and always shows the file as it is now", async () => {
    const plan = PLAN.replace("Lesson 17:", "Lesson 17: ordering food at a restaurant;");
    const { w, workspace } = await anchored({ "plan.md": plan }, [{ path: "plan.md", role: "goal_plan" }]);
    const fresh = hit("plan.md", plan, "Day 17");
    const stale = hit("plan.md", PLAN, "Day 23");
    // "Day 23" was edited after it was indexed: its old vector no longer selects it.
    const edited = plan.replace("Lesson 23:", "Lesson 23: weather small talk;");
    writeFiles(w.root, { "plan.md": edited });
    const text = projectContext({ store: w.store, goalId: w.goalId, workspace, query: "How do I ask for the bill?", semantic: { anchors: [fresh, stale], related: [] }, maxTokens: 3_000 })!;
    expect(text).toContain("› Day 17");
    expect(text).toContain("ordering food at a restaurant");
    expect(text).not.toContain("› Day 23");
  });

  it("adds at most two strongly related sections of other files, never an anchor's or a secret file's", async () => {
    const cart = "export function canCheckout(items: string[]) {\n  return items.length <= 50;\n}\n";
    const { w, workspace } = await anchored({ "plan.md": "# Plan\nShip checkout fixes.", "src/cart.ts": cart, "src/a.ts": "a", "src/b.ts": "b", ".env": "KEY=1" }, [{ path: "plan.md", role: "goal_plan" }]);
    const related = [hit("plan.md", "# Plan\nShip checkout fixes."), hit(".env", "KEY=1"), hit("src/cart.ts", cart), hit("src/a.ts", "a"), hit("src/b.ts", "b")];
    const text = projectContext({ store: w.store, goalId: w.goalId, workspace, query: "big baskets fail", semantic: { anchors: [], related }, maxTokens: 3_000 })!;
    expect(text).toContain("--- src/cart.ts (lines 1–3) — related file\nexport function canCheckout");
    expect(text).toContain("--- src/a.ts (lines 1–1) — related file");
    expect(text).not.toContain("src/b.ts");
    expect(text).not.toContain("KEY=1");
    expect(text.match(/--- plan\.md/g)).toBeNull();
  });

  it("stays within its budget, reports a missing anchor, never shows a secret one, and is omitted without a workspace", async () => {
    const { w, workspace } = await anchored({ "learning/30-day-plan.md": PLAN, ".env": "KEY=secret" }, [{ path: "learning/30-day-plan.md", role: "goal_plan" }, { path: "gone.md", role: "notes" }, { path: ".env", role: "config" }]);
    const text = projectContext({ store: w.store, goalId: w.goalId, workspace, query: "Day 10 Day 11 Day 12 lesson", maxTokens: 500 })!;
    expect(countTokens(text)).toBeLessThanOrEqual(500);
    expect(text).toContain("anchor gone.md — notes: not found in the workspace");
    expect(text).toContain("anchor .env — config: not shown, it may hold credentials");
    expect(text).not.toContain("KEY=secret");
    expect(projectContext({ store: w.store, goalId: w.goalId, workspace: null, query: "Day 10", maxTokens: 3_000 })).toBeNull();
    const bare = await world();
    expect(projectContext({ store: bare.store, goalId: bare.goalId, workspace: WorkspaceRoot.open("p", tempDir()), query: "anything", maxTokens: 3_000 })).toBeNull();
  });

  it("end to end: the background index finds a related workspace file by meaning alone", async () => {
    const w = await world({ files: { "src/cart.ts": "// Shopping basket rules.\nexport const BASKET_LIMIT = 50;\n", "src/server.ts": "// HTTP listener on port 8080.\nexport const PORT = 8080;\n" } });
    const retrieval = await Retrieval.open({ store: w.store, embedder: new HashEmbedder({ concepts: [["basket", "cart", "purchase", "buy", "shopping"]] }), uri: tempDir(), thresholds: { strong: 0.3 } });
    await retrieval.idle();
    const { socrates, model } = w.socrates([continueTask()], [final()], { semantic: retrieval });
    await socrates.handle("Why can't people purchase a big cart?");
    const text = contextText(model.requests[0]!);
    expect(text).toContain("--- src/cart.ts (lines 1–2) — related file\n// Shopping basket rules.");
    expect(text).not.toContain("src/server.ts");
  });
});


describe("E2 context boundaries", () => {
  it("does not reveal an anchor replaced by a secret-file symlink", async () => {
    const { w, workspace } = await anchored({ "plan.md": "original", ".env": "SECRET_CANARY" }, [{ path: "plan.md", role: "plan" }]);
    renameSync(path.join(w.root, "plan.md"), path.join(w.root, "old-plan.md"));
    symlinkSync(".env", path.join(w.root, "plan.md"));
    const text = projectContext({ store: w.store, goalId: w.goalId, workspace, query: "plan", maxTokens: 3000 });
    expect(text).not.toContain("SECRET_CANARY");
    expect(text).not.toContain("whole file");
  });

  it("uses task context for anchors but only the current request to qualify other files", async () => {
    const w = await world({ files: { "plan.md": "# Plan\nShip checkout." } });
    w.store.upsertAnchor({ goalId: w.goalId, path: "plan.md", role: "plan", summary: "", status: "active" });
    w.store.reviseTask(w.taskId, { continuationNote: "Checkout failed in src/cart.js." });
    const queries: { query: string; anchors: boolean }[] = [];
    const semantic: SemanticIndex = { async search(query, filter) {
      if (filter.kinds.includes("file_section")) queries.push({ query, anchors: !!filter.paths });
      return [];
    }, scheduleSync() {}, async close() {} };
    const { socrates } = w.socrates([continueTask()], [final()], { semantic });
    const request = "Draft a welcome sentence.";
    await socrates.handle(request);
    expect(queries.find((q) => q.anchors)!.query).toContain("Checkout failed");
    expect(queries.find((q) => !q.anchors)!.query).toBe(request);
    await socrates.close();
  });
});
