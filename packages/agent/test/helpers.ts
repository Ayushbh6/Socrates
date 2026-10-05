import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FinalAnswer, ModelRequest, TextPart } from "@socrates/contracts";
import { ScriptedModel, type ScriptedStep } from "@socrates/providers";
import { fixedClock } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import type { SemanticIndex } from "@socrates/retrieval";
import type { AccessPolicy, ApprovalRequest, CapabilityCatalog, ShelfOptions } from "@socrates/tools";
import { afterEach } from "vitest";
import { type AgentLimits, type ContextBudgets, Socrates, type SocratesOptions } from "../src";
import { createGoal, exchange } from "../../router/test/helpers";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "socrates-agent-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
}

/** A valid final answer as the model writes it. */
export function final(partial: Partial<FinalAnswer> = {}): { text: string } {
  return { text: JSON.stringify({ full_answer: "Done.", continuation_note: "Work verified.", goal_note: null, task_complete: null, anchors: [], ...partial }) };
}

export const call = (name: string, input: unknown) => ({ name, input });

export interface World {
  store: LedgerStore;
  clock: ReturnType<typeof fixedClock>;
  root: string;
  goalId: string;
  taskId: string;
  approvals: ApprovalRequest[];
  /** Build a Socrates over scripted router and agent models. */
  socrates(
    router: ScriptedStep[],
    agent: ScriptedStep[],
    options?: { limits?: Partial<AgentLimits>; approve?: boolean; now?: () => number; resolveWorkspace?: SocratesOptions["resolveWorkspace"]; budgets?: Partial<ContextBudgets>; compactor?: ScriptedStep[]; catalog?: CapabilityCatalog; shelf?: ShelfOptions; semantic?: SemanticIndex; access?: () => AccessPolicy | null; profile?: () => { name: string | null }; attachments?: string },
  ): { socrates: Socrates; routerModel: ScriptedModel; model: ScriptedModel; compactor: ScriptedModel };
}

/**
 * A store with one goal and task bound to a temporary workspace, created by
 * one completed routed exchange so later messages can continue it.
 */
export async function world(options: { files?: Record<string, string | Buffer>; workspace?: boolean } = {}): Promise<World> {
  const root = tempDir();
  writeFiles(root, options.files ?? {});
  const clock = fixedClock("2026-09-01T10:00:00Z");
  const store = LedgerStore.open({ path: ":memory:", clock });
  const first = await exchange(store, "Start the project work.", createGoal("Project work", "Fix the server"), "Started.", "Started the server work.");
  if (first.kind !== "routed") throw new Error("expected a routed exchange");
  const goalId = first.parts[0]!.goal.id;
  const taskId = first.parts[0]!.task.id;
  if (options.workspace ?? true) store.bindGoalWorkspace(goalId, store.createWorkspace("project", root).id);
  const approvals: ApprovalRequest[] = [];
  const w: World = {
    store,
    clock,
    root,
    goalId,
    taskId,
    approvals,
    socrates(routerSteps, agentSteps, o = {}) {
      const routerModel = new ScriptedModel("test:router", routerSteps);
      const model = new ScriptedModel("test:agent", agentSteps);
      const compactor = new ScriptedModel("test:compactor", o.compactor ?? []);
      const socrates = new Socrates({
        store,
        model,
        routerModel,
        timeZone: "UTC",
        approve: async (r) => {
          approvals.push(r);
          return o.approve ?? true;
        },
        retryDelaysMs: [0, 0],
        ...(o.limits ? { limits: o.limits } : {}),
        ...(o.now ? { now: o.now } : {}),
        ...(o.resolveWorkspace ? { resolveWorkspace: o.resolveWorkspace } : {}),
        ...(o.budgets ? { budgets: o.budgets } : {}),
        ...(o.catalog ? { catalog: o.catalog } : {}),
        ...(o.shelf ? { shelf: o.shelf } : {}),
        ...(o.semantic ? { semantic: o.semantic } : {}),
        ...(o.access ? { access: o.access } : {}),
        ...(o.profile ? { profile: o.profile } : {}),
        ...(o.attachments ? { attachments: o.attachments } : {}),
        compactorModel: compactor,
      });
      cleanups.push(() => socrates.close());
      return { socrates, routerModel, model, compactor };
    },
  };
  cleanups.push(() => store.close());
  return w;
}

/** The assembled context of a recorded request as one string. */
export function contextText(request: ModelRequest): string {
  const content = request.messages[0]!.content;
  return typeof content === "string" ? content : content.map((p) => p.text).join("");
}

export function contextParts(request: ModelRequest): TextPart[] {
  return request.messages[0]!.content as TextPart[];
}
