import type { AskUserInput, RoutePart, RouterDecision } from "@socrates/contracts";
import type { LedgerStore } from "@socrates/store";
import type { RoutingResult } from "../src";

/**
 * The routing validation fixtures from Goal-router.md (Q1–Q12, T1–T10),
 * expressed as data. Each step carries:
 * - `expect`: what correct routing does, graded by effect (which goal/task
 *   the message lands in), not by label spelling;
 * - `oracle`: a correct router answer, used by the deterministic test to
 *   prove the expected decision is valid in the exact context the router sees.
 * Live evals send the same messages to a real model and grade `expect`.
 */

export type Expectation =
  | { kind: "general" }
  | { kind: "new_goal" }
  | { kind: "new_task"; goal: string }
  | { kind: "task"; task: string }
  | { kind: "clarify" }
  | { kind: "compound"; parts: number };

export type Oracle = { decision: RouterDecision } | { ask: AskUserInput };

export interface FixtureStep {
  id: string;
  message: string;
  /** The canned visible answer stored after routing, standing in for the working agent. */
  response: string;
  /** The canned continuation note stored with the response. */
  note?: string;
  expect: Expectation;
  oracle: Oracle;
}

export interface Scenario {
  name: string;
  /** ISO start time. Each step advances the clock by two minutes. */
  start: string;
  seed?: (store: LedgerStore, clock: { set(d: string): void }) => void;
  steps: FixtureStep[];
}

// ── Oracle builders ──────────────────────────────────────────────────────

const base = {
  goal_label: null,
  new_goal_title: null,
  task_decision: null,
  task_label: null,
  new_task_title: null,
  workspace_confidence: "high" as const,
  parts: null,
  reason: "Fixture oracle.",
};

const general = (): Oracle => ({ decision: { ...base, decision: "resume_existing", goal_label: "general", workspace_confidence: null } });
const continueTask = (): Oracle => ({
  decision: { ...base, decision: "continue_current", goal_label: "current", task_decision: "continue_task", task_label: "current" },
});
const createTask = (title: string): Oracle => ({
  decision: { ...base, decision: "continue_current", goal_label: "current", task_decision: "create_task", new_task_title: title },
});
const createGoal = (goal: string, task: string): Oracle => ({
  decision: { ...base, decision: "create_new", new_goal_title: goal, task_decision: "create_task", new_task_title: task },
});
const resume = (goal: string, task: string): Oracle => ({
  decision: { ...base, decision: "resume_existing", goal_label: goal, task_decision: "resume_task", task_label: task },
});
const part = (order: number, request: string, p: Partial<RoutePart> & Pick<RoutePart, "decision">, dependsOn: number[] = []): RoutePart => ({
  order,
  request,
  goal_label: null,
  new_goal_title: null,
  task_decision: null,
  task_label: null,
  new_task_title: null,
  workspace_confidence: "high",
  reason: "Fixture oracle.",
  depends_on: dependsOn,
  ...p,
});

// ── Seeding helpers ──────────────────────────────────────────────────────

/** Store one completed exchange bound to a task, as if routed and answered earlier. */
export function seedExchange(store: LedgerStore, taskId: string, user: string, response: string, note?: string): void {
  const msg = store.recordUserMessage(user);
  const turn = store.bindTurn({ userEventId: msg.id, taskId, route: "seed" });
  const reply = store.recordResponse(response, { turn_id: turn.id });
  store.completeTurn(turn.id, { responseEventId: reply.id, continuationNote: note ?? null });
}

// ── Q1–Q10: one continuous flow inside Socrates development ──────────────

const Q10 = "Post the implementation summary and test results on GitHub issue #42, then audit every API endpoint touched by that fix for authentication and authorization problems.";

export const Q_SCENARIO: Scenario = {
  name: "Q1–Q10 Socrates development flow",
  start: "2026-09-01T09:00:00Z",
  steps: [
    {
      id: "Q1",
      message: "Hi, how are you?",
      response: "Doing well, thanks! What would you like to work on?",
      note: "No technical work is active.",
      expect: { kind: "general" },
      oracle: general(),
    },
    {
      id: "Q2",
      message: "Can you review the memory system in Socrates and explain how it currently works?",
      response: "The memory system stores exact exchanges in an event log and keeps a short continuation note per task...",
      note: "Reviewed the memory system. Exact exchanges are stored separately from the short continuation note.",
      expect: { kind: "new_goal" },
      oracle: createGoal("Socrates development", "Review Socrates memory system"),
    },
    {
      id: "Q3",
      message: "What is the biggest architectural weakness in it?",
      response: "The biggest weakness is that compaction can drop large tool results without keeping a source reference.",
      note: "Weakness identified: compaction can drop large tool results without a source reference.",
      expect: { kind: "task", task: "Review Socrates memory system" },
      oracle: continueTask(),
    },
    {
      id: "Q4",
      message: "Fix that and run the relevant tests.",
      response: "I added source references to compacted records; the focused memory tests pass.",
      note: "Compaction provenance fix implemented. Focused memory tests pass.",
      expect: { kind: "task", task: "Review Socrates memory system" },
      oracle: continueTask(),
    },
    {
      id: "Q5",
      message: "Does GitHub issue #42 still reproduce against the current code?",
      response: "Yes. Issue #42 (terminal reconnect drops output) still reproduces on main.",
      note: "Issue #42 reproduces: terminal reconnect drops output.",
      expect: { kind: "new_task", goal: "Socrates development" },
      oracle: createTask("Investigate GitHub issue #42"),
    },
    {
      id: "Q6",
      message: "If it does, fix it and draft a concise update for the issue.",
      response: "Fixed the reconnect path and drafted the issue update; tests pass.",
      note: "Terminal reconnect fix implemented. Tests pass. Issue update drafted.",
      expect: { kind: "task", task: "Investigate GitHub issue #42" },
      oracle: continueTask(),
    },
    {
      id: "Q7",
      message: "Could that memory fix lose information during compaction?",
      response: "One path could: oversized tool results in the in-flight turn. Everything else keeps a source reference.",
      note: "Remaining risk: oversized in-flight tool results during compaction.",
      expect: { kind: "task", task: "Review Socrates memory system" },
      oracle: resume("current", "task_1"),
    },
    {
      id: "Q8",
      message: "How far is our onboarding page from the latest Socrates design in Figma?",
      response: "The onboarding page differs in layout, typography, and the step indicator.",
      note: "Gap analysis against Figma done: layout, typography, step indicator.",
      expect: { kind: "new_task", goal: "Socrates development" },
      oracle: createTask("Align onboarding page with Figma"),
    },
    {
      id: "Q9",
      message: "Bring it in line with the design, but keep our existing colour palette.",
      response: "Updated layout, typography, and step indicator; kept the existing palette.",
      note: "Onboarding aligned with Figma except colours (user wants the existing palette).",
      expect: { kind: "task", task: "Align onboarding page with Figma" },
      oracle: continueTask(),
    },
    {
      id: "Q10",
      message: Q10,
      response: "1. Posted the summary and test results on #42. 2. Audited the touched endpoints; no auth gaps found.",
      expect: { kind: "compound", parts: 2 },
      oracle: {
        decision: {
          ...base,
          decision: "compound",
          workspace_confidence: null,
          parts: [
            part(1, "Post the implementation summary and test results on GitHub issue #42.", {
              decision: "resume_existing",
              goal_label: "current",
              task_decision: "resume_task",
              task_label: "task_2",
            }),
            part(
              2,
              "Audit every API endpoint touched by that fix for authentication and authorization problems.",
              { decision: "continue_current", goal_label: "current", task_decision: "create_task", new_task_title: "Security review of issue #42 API changes" },
              [1],
            ),
          ],
        },
      },
    },
  ],
};

// ── Q11–Q12: ambiguous temporal reference across two workspaces ──────────

export const Q11_SCENARIO: Scenario = {
  name: "Q11–Q12 constructive clarify",
  start: "2026-09-02T09:00:00Z",
  seed: (store, clock) => {
    const web = store.createWorkspace("website-x");
    const personal = store.createWorkspace("personal");
    clock.set("2026-09-01T10:00:00Z");
    const german = store.createGoal({ title: "Ongoing German learning", workspaceId: personal.id });
    store.reviseGoalNote(german.id, "German lessons toward B1 following the 30-day plan.");
    const day10 = store.createTask(german.id, { title: "Complete the Day 10 lesson", objective: "Work through Day 10 (dative prepositions)." });
    seedExchange(store, day10.id, "Let's start the Day 10 lesson.", "Day 10 covers dative prepositions...", "Day 10 in progress: dative prepositions.");
    clock.set("2026-09-01T12:00:00Z");
    const { task: generalTask } = store.ensureGeneral();
    seedExchange(store, generalTask.id, "Who won the UFC fight last night?", "I can't check live results, but here is how to find them...");
    clock.set("2026-09-01T18:00:00Z");
    const site = store.createGoal({ title: "Website X", workspaceId: web.id });
    const checkout = store.createTask(site.id, { title: "Checkout flow fix", objective: "Fix the discount code being dropped on retry." });
    seedExchange(store, checkout.id, "Can you review the checkout flow in Website X?", "The checkout path drops the discount code on retry...", "Retry bug found; fix not started.");
  },
  steps: [
    {
      id: "Q11",
      message: "Let's continue the project from yesterday.",
      response: "",
      expect: { kind: "clarify" },
      oracle: {
        ask: {
          question: "Yesterday you worked on three things — which should we continue with?",
          candidates: [
            { label: "Website X", detail: "checkout flow fix, most recent", suggested: true },
            { label: "German lessons", detail: "Day 10 lesson, dative prepositions" },
            { label: "UFC chat", detail: "fight discussion" },
          ],
          allow_new: true,
        },
      },
    },
    {
      id: "Q12",
      message: "The German one.",
      response: "Great — picking up Day 10 with dative prepositions.",
      expect: { kind: "task", task: "Complete the Day 10 lesson" },
      oracle: resume("older_1", "latest"),
    },
  ],
};

// ── T1–T10: task boundaries inside Andy Website development ──────────────

export const T_SCENARIO: Scenario = {
  name: "T1–T10 task boundaries",
  start: "2026-09-03T09:00:00Z",
  seed: (store) => {
    const ws = store.createWorkspace("andy-site");
    const goal = store.createGoal({ title: "Andy Website development", workspaceId: ws.id });
    store.reviseGoalNote(goal.id, "Building and polishing Andy's marketing website.");
    const setup = store.createTask(goal.id, { title: "Set up the site skeleton", objective: "Scaffold pages and deploy a preview." });
    seedExchange(store, setup.id, "Set up the basic site skeleton and deploy a preview.", "Done — preview deployed.", "Skeleton and preview deployed.");
    store.reviseTask(setup.id, { status: "completed" });
  },
  steps: [
    { id: "T1", message: "Fix the homepage hero on mobile", response: "Fixed the hero layout under 480px.", note: "Hero fixed under 480px.", expect: { kind: "new_task", goal: "Andy Website development" }, oracle: createTask("Fix homepage hero on mobile") },
    { id: "T2", message: "Make the heading smaller", response: "Reduced the hero heading to 2rem on mobile.", note: "Heading reduced.", expect: { kind: "task", task: "Fix homepage hero on mobile" }, oracle: continueTask() },
    { id: "T3", message: "Test it on an iPhone-sized viewport", response: "Checked at 390×844; looks right.", note: "Verified at 390×844.", expect: { kind: "task", task: "Fix homepage hero on mobile" }, oracle: continueTask() },
    { id: "T4", message: "The image still overflows", response: "Constrained the hero image width; no overflow now.", note: "Image overflow fixed.", expect: { kind: "task", task: "Fix homepage hero on mobile" }, oracle: continueTask() },
    { id: "T5", message: "Now fix the mobile navigation menu", response: "The menu now collapses into a drawer under 768px.", note: "Nav drawer implemented in components/Nav.tsx.", expect: { kind: "new_task", goal: "Andy Website development" }, oracle: createTask("Fix mobile navigation menu") },
    { id: "T6", message: "What file was that again?", response: "components/Nav.tsx.", expect: { kind: "task", task: "Fix mobile navigation menu" }, oracle: continueTask() },
    { id: "T7", message: "Who won the UFC fight last night?", response: "I can't check live results.", expect: { kind: "general" }, oracle: general() },
    { id: "T8", message: "Actually go back to the hero, it regressed", response: "Restored the hero image constraint that the nav change overrode.", note: "Hero regression fixed.", expect: { kind: "task", task: "Fix homepage hero on mobile" }, oracle: resume("older_1", "task_1") },
    {
      id: "T10",
      message: "Post the summary on issue #42, then audit the touched endpoints",
      response: "1. Posted. 2. Audit done.",
      expect: { kind: "compound", parts: 2 },
      oracle: {
        decision: {
          ...base,
          decision: "compound",
          workspace_confidence: null,
          parts: [
            part(1, "Post the summary on issue #42", { decision: "continue_current", goal_label: "current", task_decision: "create_task", new_task_title: "Post summary on issue #42" }),
            part(2, "audit the touched endpoints", { decision: "continue_current", goal_label: "current", task_decision: "create_task", new_task_title: "Audit endpoints touched by issue #42" }, [1]),
          ],
        },
      },
    },
  ],
};

export const T9_SCENARIO: Scenario = {
  name: "T9 first message ever",
  start: "2026-09-04T09:00:00Z",
  steps: [{ id: "T9", message: "Hi, how are you?", response: "Doing well!", expect: { kind: "general" }, oracle: general() }],
};

export const SCENARIOS: Scenario[] = [Q_SCENARIO, Q11_SCENARIO, T_SCENARIO, T9_SCENARIO];

// ── Grading ──────────────────────────────────────────────────────────────

export function describeExpectation(e: Expectation): string {
  switch (e.kind) {
    case "general":
      return "general task";
    case "new_goal":
      return "new goal";
    case "new_task":
      return `new task in "${e.goal}"`;
    case "task":
      return `task "${e.task}"`;
    case "clarify":
      return "clarify";
    case "compound":
      return `compound (${e.parts} parts)`;
  }
}

export function describeResult(r: RoutingResult): string {
  if (r.kind === "clarify") return "clarify";
  const parts = r.parts.map((p) => {
    if (p.goal.general) return "general task";
    if (p.created.goal) return `new goal "${p.goal.title}"`;
    if (p.created.task) return `new task "${p.task.title}" in "${p.goal.title}"`;
    return `task "${p.task.title}"`;
  });
  return parts.length > 1 ? `compound: ${parts.join(" + ")}` : parts[0]!;
}

export function grade(e: Expectation, r: RoutingResult): boolean {
  if (e.kind === "clarify") return r.kind === "clarify";
  if (r.kind !== "routed") return false;
  if (e.kind === "compound") return r.parts.length === e.parts;
  if (r.parts.length !== 1) return false;
  const p = r.parts[0]!;
  switch (e.kind) {
    case "general":
      return p.goal.general;
    case "new_goal":
      return p.created.goal;
    case "new_task":
      return p.created.task && !p.created.goal && p.goal.title === e.goal;
    case "task":
      return !p.created.task && p.task.title === e.task;
  }
}

/** Store the canned answer for a routed step, standing in for the working agent. */
export function completeStep(store: LedgerStore, step: FixtureStep, result: RoutingResult): void {
  if (result.kind !== "routed") return;
  const reply = store.recordResponse(step.response);
  for (const p of result.parts) store.completeTurn(p.turn.id, { responseEventId: reply.id, continuationNote: step.note ?? null });
}
