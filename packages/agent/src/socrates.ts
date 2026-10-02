import { statSync } from "node:fs";
import type { AnchorProposal, EventRefs, ModelClient, TurnStop } from "@socrates/contracts";
import { TokenCalibration } from "@socrates/providers";
import { GoalRouter, type RoutedPart } from "@socrates/router";
import type { Goal, LedgerStore, Task, Turn } from "@socrates/store";
import { type Approve, type CapabilityCatalog, RunState, type SupervisorOptions, ToolRunner, WorkspaceRoot } from "@socrates/tools";
import { assembleContext } from "./context";
import { fallbackAnswer, mechanicalNote } from "./final";
import { type AgentLimits, DEFAULT_LIMITS, type RunOutcome, runAgent } from "./loop";
import { AGENT_SYSTEM_PROMPT } from "./prompt";

/** A goal holds at most this many provisional and active anchors. */
export const MAX_GOAL_ANCHORS = 8;
/** Paths that are temporary or generated output and never become anchors. */
const TEMPORARY_PATH = /(^|\/)(node_modules|dist|build|out|coverage|tmp|temp|\.cache|\.next|target|__pycache__)(\/|$)|\.(log|tmp|lock|map)$/i;

export interface SocratesOptions {
  store: LedgerStore;
  /** The working agent's model. */
  model: ModelClient;
  /** The Goal Router's model; defaults to the working agent's. */
  routerModel?: ModelClient;
  /** IANA time zone of the user. */
  timeZone: string;
  /** The application's approval callback; each message may supply its own. */
  approve: Approve;
  /**
   * The application's workspace for a goal that has none yet, such as the
   * folder Socrates was launched in. Socrates binds it to the goal before the
   * agent runs, permanently. Without it, such a goal works without files and
   * the agent asks where the work belongs.
   */
  resolveWorkspace?: (goal: Goal) => { name: string; rootPath: string } | null;
  catalog?: CapabilityCatalog;
  limits?: Partial<AgentLimits>;
  terminals?: SupervisorOptions;
  maxOutputTokens?: number;
  retryDelaysMs?: number[];
  /** Wall clock in milliseconds, for the per-turn time limit. */
  now?: () => number;
  /** Internal diagnostics. Never shown to a model. */
  log?: (message: string) => void;
}

export interface HandleOptions {
  signal?: AbortSignal;
  approve?: Approve;
  /** Receives the one-line plan of a compound message before part 1 starts. */
  onAcknowledgment?: (text: string) => void;
}

export interface PartResult {
  order: number;
  turn: Turn;
  task: Task;
  status: "completed" | "interrupted";
  stop: TurnStop | null;
  /** What the user sees for this part. */
  answer: string;
  toolCalls: number;
}

export type HandleResult =
  | { kind: "clarify"; text: string }
  | { kind: "answered"; text: string; acknowledgment: string | null; parts: PartResult[] };

/**
 * One Socrates conversation (agent-harness.md, "Exact per-turn lifecycle"):
 * persist the message, route and bind it, then run the working agent once per
 * routed part and persist its final result. Messages are handled one at a time.
 */
export class Socrates {
  readonly store: LedgerStore;
  readonly router: GoalRouter;
  readonly runner: ToolRunner;
  readonly calibration = new TokenCalibration();
  private readonly limits: AgentLimits;
  private approveCurrent: Approve;
  private busy = false;

  constructor(private readonly options: SocratesOptions) {
    this.store = options.store;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.approveCurrent = options.approve;
    this.router = new GoalRouter({ store: options.store, routerModel: options.routerModel ?? options.model, mainModel: options.model, timeZone: options.timeZone });
    this.runner = new ToolRunner({
      store: options.store,
      timeZone: options.timeZone,
      approve: (request) => this.approveCurrent(request),
      ...(options.catalog ? { catalog: options.catalog } : {}),
      ...(options.terminals ? { terminals: options.terminals } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
  }

  async handle(message: string, options: HandleOptions = {}): Promise<HandleResult> {
    if (this.busy) throw new Error("Socrates is already handling a message.");
    this.busy = true;
    try {
      const signal = options.signal ?? new AbortController().signal;
      this.approveCurrent = options.approve ?? this.options.approve;
      const routed = await this.router.route(message, signal);
      if (routed.kind === "clarify") return { kind: "clarify", text: routed.text };
      if (routed.acknowledgment) options.onAcknowledgment?.(routed.acknowledgment);

      const results: PartResult[] = [];
      let stopped = false;
      for (const part of routed.parts) {
        // A part runs only after every earlier part finished with an answer.
        results.push(stopped || signal.aborted ? this.skipPart(part) : await this.runPart(part, routed.parts, signal));
        if (results.at(-1)!.status === "interrupted") stopped = true;
      }
      const text =
        results.length === 1
          ? results[0]!.answer
          : [routed.acknowledgment, ...results.map((r) => `**${r.order}. ${r.task.title}**\n\n${r.answer}`)].filter(Boolean).join("\n\n");
      return { kind: "answered", text, acknowledgment: routed.acknowledgment, parts: results };
    } finally {
      this.approveCurrent = this.options.approve;
      this.busy = false;
    }
  }

  async close(): Promise<void> {
    await this.runner.close();
  }

  private async runPart(part: RoutedPart, parts: RoutedPart[], signal: AbortSignal): Promise<PartResult> {
    const { store } = this;
    const turn = part.turn;
    const goal = store.requireGoal(turn.goalId!);
    const workspace = this.workspaceFor(goal);
    const mcp = (await this.runner.mcpDefinitions(goal.id)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const skills = (await this.runner.capabilities.activeSkills(goal.id)).skills;
    const context = assembleContext({
      store,
      turn,
      capabilities: { skills, mcpTools: mcp.map((d) => d.name) },
      dependsOn: part.dependsOn.map((order) => ({ order, turn: parts.find((p) => p.order === order)!.turn })),
      part: parts.length > 1 ? { order: part.order, count: parts.length } : null,
      now: store.clock.now(),
      timeZone: this.options.timeZone,
    });
    const outcome = await runAgent({
      model: this.options.model,
      runner: this.runner,
      calibration: this.calibration,
      system: AGENT_SYSTEM_PROMPT,
      tools: [...this.runner.definitions, ...mcp],
      context,
      scope: { binding: { goalId: goal.id, taskId: turn.taskId!, chatId: turn.chatId, turnId: turn.id }, workspace, run: new RunState(), signal },
      limits: this.limits,
      ...(this.options.maxOutputTokens ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
      ...(this.options.retryDelaysMs ? { retryDelaysMs: this.options.retryDelaysMs } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    return this.persist(part, goal, workspace, outcome);
  }

  /**
   * Persist one part's outcome (agent-harness.md, "Final result"): models
   * propose, the harness disposes. Only a valid final answer may change the
   * goal note, the task status, or the anchors.
   */
  private persist(part: RoutedPart, goal: Goal, workspace: WorkspaceRoot | null, outcome: RunOutcome): PartResult {
    const { store } = this;
    const turn = part.turn;
    const task = store.requireTask(turn.taskId!);
    const refs: EventRefs = { goal_id: goal.id, task_id: task.id, chat_id: turn.chatId, turn_id: turn.id };
    const result = (status: PartResult["status"], stop: TurnStop | null, answer: string): PartResult => ({
      order: part.order,
      turn: store.requireTurn(turn.id),
      task: store.requireTask(task.id),
      status,
      stop,
      answer,
      toolCalls: outcome.toolCalls,
    });

    if (outcome.kind === "interrupted") {
      if (outcome.reason === "failed") store.recordWarning(refs, { kind: "model_error", detail: outcome.detail ?? "The model request failed." });
      const what = outcome.reason === "cancelled" ? "Interrupted by the user" : "Stopped by a model failure";
      store.interruptTurn(turn.id, { reason: outcome.reason, toolCalls: outcome.toolCalls, continuationNote: mechanicalNote(what, outcome.toolCalls) });
      const answer = outcome.reason === "cancelled" ? `Stopped after ${outcome.toolCalls} tool call${outcome.toolCalls === 1 ? "" : "s"}.` : "I could not finish this because the model request failed. Ask me to continue and I will pick up from here.";
      return result("interrupted", null, answer);
    }

    if (outcome.kind === "invalid") {
      store.recordWarning(refs, { kind: "final_answer_invalid", detail: outcome.errors.join("; ") });
      const answer = fallbackAnswer(outcome.text);
      const response = store.recordResponse(answer, refs);
      store.completeTurn(turn.id, { responseEventId: response.id, continuationNote: mechanicalNote("Ended without a valid final answer", outcome.toolCalls), stop: outcome.stop });
      return result("completed", outcome.stop, answer);
    }

    const { answer } = outcome;
    const response = store.recordResponse(answer.full_answer, refs);
    this.applyAnchors(goal, workspace, answer.anchors, refs);
    store.completeTurn(turn.id, {
      responseEventId: response.id,
      continuationNote: answer.continuation_note,
      // The general conversation has no durable goal state and no completion.
      goalNote: goal.general ? null : answer.goal_note,
      ...(task.general ? {} : { taskComplete: answer.task_complete !== null, taskCompleteReason: answer.task_complete?.reason ?? null }),
      stop: outcome.stop,
    });
    return result("completed", outcome.stop, answer.full_answer);
  }

  /** A part that never ran because an earlier part was interrupted or the message was cancelled. */
  private skipPart(part: RoutedPart): PartResult {
    this.store.interruptTurn(part.turn.id, { reason: "cancelled", toolCalls: 0, continuationNote: mechanicalNote("Not started; an earlier part of the message was interrupted", 0) });
    return { order: part.order, turn: this.store.requireTurn(part.turn.id), task: this.store.requireTask(part.task.id), status: "interrupted", stop: null, answer: "Not started.", toolCalls: 0 };
  }

  /**
   * Validate anchor proposals (Goal-router.md, "Anchor lifecycle"): an
   * existing, durable file of the goal's workspace, within the anchor budget,
   * that does not silently change an existing anchor. Accepted proposals
   * become provisional; rejections are recorded as warnings.
   */
  private applyAnchors(goal: Goal, workspace: WorkspaceRoot | null, proposals: AnchorProposal[], refs: EventRefs): void {
    for (const p of proposals) {
      const reject = (why: string) => this.store.recordWarning(refs, { kind: "anchor_rejected", detail: `${p.path} (${p.role}): ${why}` });
      if (goal.general || !workspace) {
        reject("this work has no workspace");
        continue;
      }
      let rel: string;
      try {
        const file = workspace.resolve(p.path);
        if (!statSync(file.abs).isFile()) throw new Error("not a file");
        rel = file.rel;
      } catch {
        reject("not an existing file of the workspace");
        continue;
      }
      if (TEMPORARY_PATH.test(rel)) {
        reject("temporary or generated files are not anchors");
        continue;
      }
      const anchors = this.store.listAnchors(goal.id);
      const same = anchors.find((a) => a.path === rel);
      if (same?.role === p.role) continue;
      if (same) {
        reject(`already anchored as ${same.role}; changing an anchor's role needs the user`);
        continue;
      }
      if (anchors.length >= MAX_GOAL_ANCHORS) {
        reject(`the goal already has ${MAX_GOAL_ANCHORS} anchors`);
        continue;
      }
      this.store.upsertAnchor({ goalId: goal.id, path: rel, role: p.role, summary: p.reason, status: "provisional" });
    }
  }

  private workspaceFor(goal: Goal): WorkspaceRoot | null {
    if (!goal.workspaceId && !goal.general) {
      const chosen = this.options.resolveWorkspace?.(goal);
      const existing = chosen ? this.store.findWorkspaceByName(chosen.name) : null;
      if (chosen && existing && existing.rootPath !== chosen.rootPath) {
        this.options.log?.(`workspace name ${chosen.name} already belongs to another folder; goal g${goal.number} stays without a workspace`);
      } else if (chosen) {
        goal = this.store.bindGoalWorkspace(goal.id, (existing ?? this.store.createWorkspace(chosen.name, chosen.rootPath)).id);
      }
    }
    const workspace = goal.workspaceId ? this.store.getWorkspace(goal.workspaceId) : null;
    if (!workspace?.rootPath) return null;
    try {
      return WorkspaceRoot.open(workspace.name, workspace.rootPath);
    } catch (error) {
      this.options.log?.(`workspace ${workspace.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
