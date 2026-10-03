import type { EventRefs, ModelClient, TurnStop } from "@socrates/contracts";
import { abortable } from "@socrates/shared";
import { TokenCalibration } from "@socrates/providers";
import { GoalRouter, type RoutedPart } from "@socrates/router";
import type { Goal, LedgerStore, Task, Turn } from "@socrates/store";
import type { SemanticHit, SemanticIndex } from "@socrates/retrieval";
import { type Approve, type CapabilityCatalog, RunState, type ShelfOptions, type SupervisorOptions, ToolRunner, WorkspaceRoot, capabilityCandidates, skillShelf } from "@socrates/tools";
import { taskHistory } from "./history";
import { assembleContext } from "./context";
import { fallbackAnswer, mechanicalNote } from "./final";
import { type AgentLimits, DEFAULT_LIMITS, type RunOutcome, runAgent } from "./loop";
import { AGENT_SYSTEM_PROMPT } from "./prompt";
import { type ContextBudgets, DEFAULT_BUDGETS } from "./budgets";
import { createCompactor } from "./compaction";
import { applyAnchors, type AnchorDecision, type AnchorChange } from "./anchors";
export { MAX_GOAL_ANCHORS } from "./anchors";

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
  /** Installed Skills and MCP servers; the application opens it and Socrates.close closes it. */
  catalog?: CapabilityCatalog;
  /**
   * The embedding index of Socrates' memory, for meaning-based retrieval in
   * routing, context_retrieve, `<RETRIEVED_HISTORY>`, and capability
   * candidates. The application opens it; Socrates refreshes it in the
   * background after every message and closes it in close(). Without it,
   * every search is keyword and recency only.
   */
  semantic?: SemanticIndex;
  /** The user's pinned and the deployment's default Skills, first on a new goal's shelf. */
  shelf?: ShelfOptions;
  limits?: Partial<AgentLimits>;
  /** Context budgets; production uses the defaults. */
  budgets?: Partial<ContextBudgets>;
  /** The model that writes history checkpoints and handover capsules; defaults to the working agent's. */
  compactorModel?: ModelClient;
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
  /** Explicit selections from the user, never inferred from model proposals. */
  anchorDecisions?: AnchorDecision[];
  /** Quiet status lines while work continues, such as a context refresh during rollover. */
  onStatus?: (text: string) => void;
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
  /** Quiet, reversible anchor notifications for the application. */
  anchorChanges?: AnchorChange[];
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
  private readonly budgets: ContextBudgets;
  private approveCurrent: Approve;
  private busy = false;

  constructor(private readonly options: SocratesOptions) {
    this.store = options.store;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.budgets = { ...DEFAULT_BUDGETS, ...options.budgets };
    this.approveCurrent = options.approve;
    this.router = new GoalRouter({ store: options.store, routerModel: options.routerModel ?? options.model, mainModel: options.model, timeZone: options.timeZone, ...(options.semantic ? { semantic: options.semantic } : {}) });
    this.runner = new ToolRunner({
      store: options.store,
      timeZone: options.timeZone,
      approve: (request) => this.approveCurrent(request),
      ...(options.catalog ? { catalog: options.catalog } : {}),
      ...(options.semantic ? { semantic: options.semantic } : {}),
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
      let setupError: { error: unknown } | null = null;
      try { if (routed.acknowledgment) options.onAcknowledgment?.(routed.acknowledgment); }
      catch (error) { setupError = { error }; }

      const results: PartResult[] = [];
      let stopped = false;
      for (const part of routed.parts) {
        // A part runs only after every earlier part finished with an answer.
        if (stopped || signal.aborted) results.push(this.skipPart(part));
        else {
          try {
            if (setupError) throw setupError.error;
            results.push(await this.runPart(part, routed.parts, signal, options));
          } catch (error) {
            const cancelled = signal.aborted;
            const refs = { goal_id: part.goal.id, task_id: part.task.id, turn_id: part.turn.id, chat_id: part.turn.chatId };
            if (!cancelled) {
              this.options.log?.(`agent part ${part.order} failed: ${error instanceof Error ? error.message : String(error)}`);
              this.store.recordWarning(refs, { kind: "agent_error", detail: "The agent could not finish setting up or running this part." });
            }
            const calls = this.store.evidenceForTurn(part.turn.id).length;
            this.store.interruptTurn(part.turn.id, { reason: cancelled ? "cancelled" : "failed", toolCalls: calls, continuationNote: mechanicalNote(cancelled ? "Interrupted by the user" : "Interrupted by an agent failure", calls) });
            results.push({ order: part.order, turn: this.store.requireTurn(part.turn.id), task: this.store.requireTask(part.task.id), status: "interrupted", stop: null, answer: cancelled ? `Stopped after ${calls} tool call${calls === 1 ? "" : "s"}.` : "I could not finish this part. The work so far is saved; ask me to continue.", toolCalls: calls });
          }
        }
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
      // Index what this message added, in the background; replies never wait for it.
      this.options.semantic?.scheduleSync();
    }
  }

  /** Stop terminals, every MCP server connection, and the embedding index. */
  async close(): Promise<void> {
    await this.runner.close();
    await this.runner.capabilities.catalog.close?.();
    await this.options.semantic?.close();
  }

  private async runPart(part: RoutedPart, parts: RoutedPart[], signal: AbortSignal, options: HandleOptions): Promise<PartResult> {
    const { store } = this;
    const turn = part.turn;
    const goal = store.requireGoal(turn.goalId!);
    const startedAt = (this.options.now ?? Date.now)();
    const workspace = this.workspaceFor(goal);
    const capabilities = this.runner.capabilities;
    capabilities.beginTurn(goal.id);
    const tools = async (signal: AbortSignal) => [...this.runner.definitions, ...(await this.runner.mcpDefinitions(goal.id, signal))];
    const setupDeadline = new AbortController();
    const setupSignal = AbortSignal.any([signal, setupDeadline.signal]);
    const setupTimer = setTimeout(() => setupDeadline.abort(), Math.max(0, this.limits.maxWallMs - ((this.options.now ?? Date.now)() - startedAt)));
    let initialTools = this.runner.definitions;
    const request = store.requestForTurn(turn.id).request;
    const semantic = { task: [] as SemanticHit[], siblings: [] as SemanticHit[], capabilities: [] as SemanticHit[] };
    const historyBoundary = () => {
      const history = taskHistory(store, turn.id);
      return Math.max(history.summary?.to ?? 0, history.omitted?.to ?? 0);
    };
    const ownHistory = (signal: AbortSignal) => this.options.semantic!.search(request, {
      kinds: ["exchange", "tool_call"], taskIds: [turn.taskId!], throughTurn: historyBoundary(), limit: 20,
    }, signal);
    try {
      if (this.options.semantic) {
        // One query embedding (cached) serves all three searches; failures return nothing and keywords carry on.
        const search = this.options.semantic;
        [semantic.task, semantic.siblings, semantic.capabilities] = await Promise.all([
          ownHistory(setupSignal),
          search.search(request, { kinds: ["exchange", "tool_call"], goalIds: [goal.id], excludeTaskIds: [turn.taskId!], excludeTurnIds: parts.map((p) => p.turn.id), limit: 3, min: "strong" }, setupSignal),
          search.search(request, { kinds: ["capability"], limit: 5, min: "suggest" }, setupSignal),
        ]);
      }
      if (capabilities.catalog.refresh) {
        await abortable(capabilities.catalog.refresh(setupSignal), setupSignal).catch((error) => {
          setupSignal.throwIfAborted();
          this.options.log?.(`capability refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      initialTools = await tools(setupSignal);
      await capabilities.activeSkills(goal.id, setupSignal);
      setupSignal.throwIfAborted();
    } catch (error) {
      if (signal.aborted || !setupDeadline.signal.aborted) throw error;
      // Setup exhausted the working allowance. The loop makes only its bounded tool-free wrap-up.
    } finally { clearTimeout(setupTimer); }
    const run = new RunState();
    const shelf = skillShelf(store, capabilities.catalog, goal.id, this.options.shelf);
    const candidates = capabilityCandidates({ store, catalog: capabilities.catalog, goalId: goal.id, message: request, run, semantic: semantic.capabilities });
    // Rebuilt from the current active set each time, so compaction mid-turn keeps a Skill activated earlier in the turn.
    const assemble = (previousTurn?: number) =>
      assembleContext({
        store,
        turn,
        capabilities: capabilities.current(goal.id),
        shelf,
        candidates,
        semantic,
        dependsOn: part.dependsOn.map((order) => ({ order, turn: parts.find((p) => p.order === order)!.turn })),
        part: parts.length > 1 ? { order: part.order, count: parts.length } : null,
        now: store.clock.now(),
        timeZone: this.options.timeZone,
        budgets: { retrievedMax: this.budgets.retrievedMax, previousTurn: previousTurn ?? this.budgets.previousTurn },
      });
    const context = assemble();
    const compact = createCompactor({
      store,
      model: this.options.compactorModel ?? this.options.model,
      turn,
      budgets: this.budgets,
      assemble,
      refreshHistory: this.options.semantic ? async (signal) => { semantic.task = await ownHistory(signal); } : undefined,
      ...(this.options.retryDelaysMs ? { retryDelaysMs: this.options.retryDelaysMs } : {}),
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
      ...(this.options.log ? { log: this.options.log } : {}),
    });
    const outcome = await runAgent({
      model: this.options.model,
      runner: this.runner,
      calibration: this.calibration,
      system: AGENT_SYSTEM_PROMPT,
      tools: initialTools,
      refreshTools: tools,
      capabilities: () => capabilities.current(goal.id),
      startedAt,
      context,
      scope: { binding: { goalId: goal.id, taskId: turn.taskId!, chatId: turn.chatId, turnId: turn.id }, workspace, run, signal },
      limits: this.limits,
      budgets: this.budgets,
      compact,
      onResponse: (response, phase) => store.appendEvent("agent_message", { response, phase }, { goal_id: goal.id, task_id: turn.taskId, chat_id: turn.chatId, turn_id: turn.id }),
      ...(this.options.maxOutputTokens ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
      ...(this.options.retryDelaysMs ? { retryDelaysMs: this.options.retryDelaysMs } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    return this.persist(part, goal, workspace, signal.aborted ? { kind: "interrupted", reason: "cancelled", detail: null, toolCalls: outcome.toolCalls, steps: outcome.steps } : outcome, options.anchorDecisions ?? []);
  }

  /**
   * Persist one part's outcome (agent-harness.md, "Final result"): models
   * propose, the harness disposes. Only a valid final answer may change the
   * goal note, the task status, or the anchors.
   */
  private persist(part: RoutedPart, goal: Goal, workspace: WorkspaceRoot | null, outcome: RunOutcome, anchorDecisions: AnchorDecision[]): PartResult {
    return this.store.transaction(() => this.persistOutcome(part, goal, workspace, outcome, anchorDecisions));
  }

  private persistOutcome(part: RoutedPart, goal: Goal, workspace: WorkspaceRoot | null, outcome: RunOutcome, anchorDecisions: AnchorDecision[]): PartResult {
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

    if (outcome.kind === "limited") {
      store.recordWarning(refs, { kind: "context_limit", detail: "The final request was refused at the hard context ceiling." });
      const response = store.recordResponse(outcome.text, refs);
      store.completeTurn(turn.id, { responseEventId: response.id, continuationNote: outcome.note, stop: outcome.stop });
      return result("completed", outcome.stop, outcome.text);
    }

    if (outcome.kind === "invalid") {
      store.recordWarning(refs, { kind: "final_answer_invalid", detail: outcome.errors.join("; ") });
      const answer = fallbackAnswer(outcome.text);
      const response = store.recordResponse(answer, refs);
      store.completeTurn(turn.id, { responseEventId: response.id, continuationNote: mechanicalNote("Ended without a valid final answer", outcome.toolCalls), stop: outcome.stop });
      return result("completed", outcome.stop, answer);
    }

    const { answer } = outcome;
    const anchors = applyAnchors({ store, goal, workspace, turn, proposals: answer.anchors, decisions: anchorDecisions, refs });
    const visible = [answer.full_answer, anchors.question].filter(Boolean).join("\n\n");
    const response = store.recordResponse(visible, refs);
    store.completeTurn(turn.id, {
      responseEventId: response.id,
      continuationNote: answer.continuation_note,
      // The general conversation has no durable goal state and no completion.
      goalNote: goal.general ? null : answer.goal_note,
      ...(!task.general && answer.task_complete ? { taskComplete: true, taskCompleteReason: answer.task_complete.reason } : {}),
      stop: outcome.stop,
    });
    return { ...result("completed", outcome.stop, visible), anchorChanges: anchors.changes };
  }

  /** A part that never ran because an earlier part was interrupted or the message was cancelled. */
  private skipPart(part: RoutedPart): PartResult {
    this.store.interruptTurn(part.turn.id, { reason: "cancelled", toolCalls: 0, continuationNote: mechanicalNote("Not started; an earlier part of the message was interrupted", 0) });
    return { order: part.order, turn: this.store.requireTurn(part.turn.id), task: this.store.requireTask(part.task.id), status: "interrupted", stop: null, answer: "Not started.", toolCalls: 0 };
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
