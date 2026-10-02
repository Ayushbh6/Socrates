import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixedClock } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { afterEach } from "vitest";
import { type ApprovalRequest, type CapabilityCatalog, RunState, type ToolBinding, ToolRunner, WorkspaceRoot } from "../src";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

export function tempDir(prefix = "socrates-tools-"): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write files relative to a root; parent directories are created. */
export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export interface Harness {
  store: LedgerStore;
  clock: ReturnType<typeof fixedClock>;
  runner: ToolRunner;
  root: string;
  workspace: WorkspaceRoot;
  binding: ToolBinding;
  run: RunState;
  approvals: ApprovalRequest[];
  /** Call one tool and parse its model-facing JSON (or keep the text for read). */
  call(name: string, input: unknown, options?: { signal?: AbortSignal; binding?: ToolBinding; workspace?: WorkspaceRoot | null }): Promise<Result>;
  /** Bind a new turn of the same task. */
  nextTurn(): void;
}

export interface Result {
  isError: boolean;
  handle: string;
  content: string;
  /** Parsed JSON content; for read the raw text is in `content`. */
  json: any;
}

export function harness(options: { files?: Record<string, string | Buffer>; approve?: boolean | ((r: ApprovalRequest) => boolean); catalog?: CapabilityCatalog; gateArmed?: boolean } = {}): Harness {
  const root = tempDir();
  writeFiles(root, options.files ?? {});
  const clock = fixedClock("2026-09-01T10:00:00Z");
  const store = LedgerStore.open({ path: ":memory:", clock });
  const approvals: ApprovalRequest[] = [];
  const decide = options.approve ?? true;
  const runner = new ToolRunner({
    store,
    timeZone: "UTC",
    ...(options.catalog ? { catalog: options.catalog } : {}),
    approve: async (r) => {
      approvals.push(r);
      return typeof decide === "function" ? decide(r) : decide;
    },
  });
  cleanups.push(async () => {
    await runner.close();
    store.close();
  });
  const workspace = WorkspaceRoot.open("project", root);
  const goal = store.createGoal({ title: "Project work", objective: "Ship the project." });
  const task = store.createTask(goal.id, { title: "Fix the server", objective: "Make the server start." });
  const bind = () => {
    const user = store.recordUserMessage("Please fix the server.");
    const turn = store.bindTurn({ userEventId: user.id, taskId: task.id, route: "continue_current", gateArmed: options.gateArmed ?? false, workspaceConfidence: options.gateArmed ? "low" : "high" });
    return { goalId: goal.id, taskId: task.id, chatId: turn.chatId, turnId: turn.id };
  };
  const h: Harness = {
    store,
    clock,
    runner,
    root,
    workspace,
    binding: bind(),
    run: new RunState(),
    approvals,
    async call(name, input, o = {}) {
      clock.advance(1000);
      const result = await runner.run(
        { id: `call_${Math.random().toString(36).slice(2)}`, name, input },
        { binding: o.binding ?? h.binding, workspace: o.workspace === undefined ? workspace : o.workspace, run: h.run, signal: o.signal ?? new AbortController().signal },
      );
      let json: unknown = null;
      try {
        json = JSON.parse(result.content);
      } catch {
        // read returns rendered text.
      }
      return { isError: result.isError, handle: result.handle, content: result.content, json };
    },
    nextTurn() {
      h.binding = bind();
      h.run = new RunState();
    },
  };
  return h;
}
