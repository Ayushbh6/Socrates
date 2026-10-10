import type { Attachment, EventRefs, ModelClient, TurnStop } from "@socrates/contracts";
import { homedir } from "node:os";
import { abortable } from "@socrates/shared";
import { TokenCalibration } from "@socrates/providers";
import { GoalRouter, type RoutedPart, laneSummaries } from "@socrates/router";
import type { Goal, Lane, LedgerStore, Task, Turn } from "@socrates/store";
import type { SemanticHit, SemanticIndex } from "@socrates/retrieval";
import { type AccessGrant, type AccessPolicy, type Approve, type CapabilityCatalog, RunState, type ShelfOptions, type SupervisorOptions, ToolRunner, WorkspaceRoot, canReadAutomatically, capabilityCandidates, skillShelf } from "@socrates/tools";
import { attachmentImages, requestAttachments } from "./attachments";
import { taskHistory } from "./history";
import { CHAT_ROUTES, assembleContext, projectQuery } from "./context";
import { type LaneView, laneNotice, lanesBlock } from "./lanes";
import { RELATED_MAX_SECTIONS } from "./project-context";
import { fallbackAnswer, mechanicalNote } from "./final";
import type { Draft } from "./draft";
import { type AgentLimits, DEFAULT_LIMITS, type RunOutcome, runAgent } from "./loop";
import { AGENT_SYSTEM_PROMPT } from "./prompt";
import { type ContextBudgets, DEFAULT_BUDGETS } from "./budgets";
import { createCompactor } from "./compaction";
import { applyAnchors, type AnchorDecision, type AnchorChange } from "./anchors";
import { MEMORY_ON, type MemoryChange, type MemorySettings, applyMemory } from "./memory";
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
   * The application's working folder. Socrates binds it to a project goal
   * that has none yet, permanently, before the agent runs; the general
   * conversation starts in it each turn without being bound. Without it, work
   * starts in the user's home when there is an access policy.
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
  /**
   * Where file and command tools may work and when they ask, read before
   * every tool call (agent-harness.md, "Access"). Without it, the goal's
   * workspace is the boundary and the classic approvals apply.
   */
  access?: () => AccessPolicy | null;
  /** The user's profile, read when a message starts, so a name given or changed in the middle of a chat counts from the next message. */
  profile?: () => { name: string | null };
  /** The user's memory switches, read when a turn starts and when it ends (agent-harness.md, "Memory"); both on without it. */
  memory?: () => MemorySettings;
  maxOutputTokens?: number;
  retryDelaysMs?: number[];
  /** Wall clock in milliseconds, for the per-turn time limit. */
  now?: () => number;
  /** Internal diagnostics. Never shown to a model. */
  log?: (message: string) => void;
  /** The folder of the user's attached images, which `read` may always open. */
  attachments?: string;
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
  /**
   * Where the message goes: omitted, the main conversation; "new", a new
   * lane; or an open lane's id. The first message of a lane is routed like
   * any other; later ones continue the lane's task.
   */
  lane?: "new" | string;
  /** Receives a new lane's id as soon as it is opened, before routing. */
  onLane?: (laneId: string) => void;
  /**
   * A part of a main-conversation message whose task is busy in a lane was
   * handed to that lane; it runs there next, and the main conversation is
   * free for the next message.
   */
  onHandoff?: (laneId: string, turnId: string) => void;
  /**
   * The readable part of a reply while it arrives, for the turn that is
   * working. Temporary: nothing is saved, and the saved narration or answer
   * replaces it.
   */
  onDraft?: (turnId: string, draft: Draft) => void;
  /** Images the user attached to the message, already stored in the attachments folder. */
  attachments?: Attachment[];
  /**
   * Standard mode (architecture/web.md, "Standard mode"): the user chose where
   * the message goes, so it is not routed. An existing task continues; a new
   * one is made in the goal, named for now by `title`.
   */
  target?: { taskId: string } | { goalId: string; title: string };
  /** False: the chat never rolls over into a new one, however often it is compacted (standard mode). */
  rollover?: boolean;
  /**
   * Flow mode's "Keep my next message in this task": `target` is a task the
   * user chose for this one message. It is bound there without routing, as a
   * flow turn (it rolls over as usual), and recorded as kept there.
   */
  pinned?: boolean;
  /**
   * Standard mode's parallel chats (architecture/web.md, "Standard mode"):
   * with `target`, the message runs beside the main conversation and the
   * other chats, as its own lane would, without waiting for or holding the
   * main conversation. Its task still runs one message at a time, and at most
   * MAX_RUNNING_CHATS such messages run at once.
   */
  alongside?: boolean;
  /** Receives each part's turn and task once it is bound, before it runs. */
  onBound?: (turnId: string, taskId: string) => void;
  /**
   * With `target`: the message asks this turn's question again in the chosen
   * task, because the router put it in the wrong one (architecture/agent-harness.md,
   * "Redo in another task"). The turn is set aside once the redo is bound.
   */
  redoOf?: string;
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
  /** What the turn's answer saved to or forgot from memory. */
  memoryChanges?: MemoryChange[];
}

/** Outside-folder grants last for this whole message, including its compound parts. */
type RunOptions = HandleOptions & { accessGrants: AccessGrant[] };

/**
 * `notices` contains one line per lane part (or clarification), each with its
 * own outcome. `notice` joins these lines for simple consumers, or is null
 * for work done entirely in the main conversation.
 */
export type HandleResult =
  | { kind: "clarify"; text: string; laneId: string | null; notice: string | null; notices: string[] }
  | { kind: "answered"; text: string; acknowledgment: string | null; parts: PartResult[]; laneId: string | null; notice: string | null; notices: string[] };

/**
 * Interrupt every turn a stopped process left running, before a new Socrates
 * starts: each keeps its exact evidence and gets a mechanical note, so the
 * user can continue it. Returns the turns it interrupted.
 */
export function interruptUnfinishedTurns(store: LedgerStore): Turn[] {
  return store.transaction(() => {
    const notes = new Map<string, string>();
    const turns = store.unfinishedTurns().map((turn) => {
      const calls = store.evidenceForTurn(turn.id).length;
      const note = mechanicalNote("Interrupted when Socrates stopped", calls);
      // A later queued handoff has done no work. Its zero-call note must not
      // replace the continuation of the turn that was actually running.
      if (!notes.has(turn.taskId!) || calls > 0) notes.set(turn.taskId!, note);
      return store.interruptTurn(turn.id, { reason: "restarted", toolCalls: calls, continuationNote: note });
    });
    for (const [taskId, note] of notes) if (store.requireTask(taskId).continuationNote !== note) store.reviseTask(taskId, { continuationNote: note });
    return turns;
  });
}

/** At most this many lanes run at once (agent-harness.md, "Lanes"). */
export const MAX_RUNNING_LANES = 4;
/** At most this many standard-mode chats run at once, beside the main conversation and the lanes. */
export const MAX_RUNNING_CHATS = 4;

/** Work Socrates cannot take now: the main conversation is busy, too many lanes or chats run, the lane is closed, or a running lane cannot be closed. */
export class SocratesBusyError extends Error {
  constructor(readonly reason: "main_busy" | "lane_limit" | "chat_limit" | "lane_closed" | "lane_running", message: string) {
    super(message);
    this.name = "SocratesBusyError";
  }
}

/** A question that cannot be asked again in another task now; the message says why. */
export class RedoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedoError";
  }
}

/** A lane as the application shows it: its record, and whether work is running in it now. */
export interface LaneState extends Lane {
  running: boolean;
  /** A run in this lane is waiting for the user's approval. */
  waitingForApproval: boolean;
}

interface TaskLock {
  laneId: string | null;
  done: Promise<void>;
  previous?: TaskLock;
  cancelled?: boolean;
}

/**
 * One Socrates (agent-harness.md, "Exact per-turn lifecycle" and "Lanes"):
 * persist the message, route and bind it, then run the working agent once per
 * routed part and persist its final result. The main conversation handles one
 * message at a time; up to MAX_RUNNING_LANES lanes run alongside it. One task
 * is worked by one run at a time: a message for a busy task waits for it, and
 * a main-conversation message whose task is busy in a lane is handed to that
 * lane.
 */
export class Socrates {
  readonly store: LedgerStore;
  readonly router: GoalRouter;
  readonly runner: ToolRunner;
  readonly calibration = new TokenCalibration();
  private readonly limits: AgentLimits;
  private readonly budgets: ContextBudgets;
  private mainBusy = false;
  /** Standard-mode chats running beside the main conversation (`alongside`). */
  private chatRuns = 0;
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  /** Messages in progress per lane, including ones waiting for a task. */
  private readonly laneRuns = new Map<string, number>();
  /** The newest run queued on each task; its `done` settles after every earlier run on the task. */
  private readonly taskLocks = new Map<string, TaskLock>();
  /** Whole messages queued per lane, including routing and compound parts. */
  private readonly laneQueues = new Map<string, Promise<void>>();
  /** Runs in progress per goal; only the first resets the goal's capability cache. */
  private readonly goalRuns = new Map<string, number>();
  /** Approval requests per live turn; removed when a turn stops, even if its callback never settles. */
  private readonly approvalsWaiting = new Map<string, number>();
  /** Each running turn's approval callback and lane. */
  private readonly approvers = new Map<string, { approve: Approve; laneId: string | null }>();

  constructor(private readonly options: SocratesOptions) {
    this.store = options.store;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.budgets = { ...DEFAULT_BUDGETS, ...options.budgets };
    this.router = new GoalRouter({ store: options.store, routerModel: options.routerModel ?? options.model, mainModel: options.model, timeZone: options.timeZone, ...(options.semantic ? { semantic: options.semantic } : {}) });
    this.runner = new ToolRunner({
      store: options.store,
      timeZone: options.timeZone,
      ...(options.attachments ? { attachments: options.attachments } : {}),
      approve: async (request, origin) => {
        const run = origin?.turnId ? this.approvers.get(origin.turnId) : undefined;
        const lane = run?.laneId ?? null;
        const approvalKey = origin?.turnId;
        if (approvalKey) this.approvalsWaiting.set(approvalKey, (this.approvalsWaiting.get(approvalKey) ?? 0) + 1);
        try {
          return await (run?.approve ?? this.options.approve)(request, origin ? { ...origin, laneId: lane } : undefined);
        } finally {
          if (approvalKey) {
            const n = (this.approvalsWaiting.get(approvalKey) ?? 1) - 1;
            if (n > 0) this.approvalsWaiting.set(approvalKey, n);
            else this.approvalsWaiting.delete(approvalKey);
          }
        }
      },
      ...(options.catalog ? { catalog: options.catalog } : {}),
      ...(options.semantic ? { semantic: options.semantic } : {}),
      ...(options.terminals ? { terminals: options.terminals } : {}),
      ...(options.access ? { access: options.access } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
  }

  /** True while the main conversation is working on a message. */
  get busy(): boolean {
    return this.mainBusy;
  }

  /** How many standard-mode chats are running beside the main conversation. */
  get runningChats(): number {
    return this.chatRuns;
  }

  /** Open lanes, oldest first, and whether each is running. */
  lanes(): LaneState[] {
    return this.store.listLanes().map((lane) => ({ ...lane, running: this.laneRuns.has(lane.id), waitingForApproval: this.waitingForApproval(lane.id) }));
  }

  private waitingForApproval(laneId: string): boolean {
    return [...this.approvers].some(([turnId, run]) => run.laneId === laneId && (this.approvalsWaiting.get(turnId) ?? 0) > 0);
  }

  private laneActivity(): Map<string, string | null> {
    const activity = new Map<string, string | null>([...this.laneRuns.keys()].map((id) => [id, null]));
    for (const [turnId, run] of this.approvers) if (run.laneId) activity.set(run.laneId, turnId);
    return activity;
  }

  /** What every lane beside the main conversation is doing, for `<LANES>`. */
  private laneViews(): LaneView[] {
    return laneSummaries(this.store, this.store.clock.now(), null, this.laneActivity()).map((s) => ({ ...s, waitingForApproval: this.waitingForApproval(s.lane.id) }));
  }

  /** Close an idle lane; its history stays in the ledger. */
  closeLane(laneId: string): Lane {
    if (this.laneRuns.has(laneId)) throw new SocratesBusyError("lane_running", "This lane is still working; stop it before closing it.");
    return this.store.closeLane(laneId);
  }

  /**
   * Handle one message: in the main conversation, in a new lane (`lane: "new"`),
   * or in an open lane. Throws SocratesBusyError, before recording anything,
   * when the main conversation is busy, MAX_RUNNING_LANES lanes already run,
   * or the lane is closed.
   */
  handle(message: string, options: HandleOptions = {}): Promise<HandleResult> {
    if (this.closed) return Promise.reject(new Error("Socrates is closed."));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (options.redoOf) {
      const problem = !options.target ? "A redo needs the task to ask it in." : this.redoProblem(options.redoOf, "taskId" in options.target ? options.target.taskId : null);
      if (problem) return Promise.reject(new RedoError(problem));
    }
    let laneId: string | null;
    const alongside = options.alongside === true && !!options.target && !options.lane;
    try {
      laneId = alongside ? this.claimChat() : this.claim(options.lane);
    } catch (error) {
      return Promise.reject(error);
    }
    let userEventId: string | undefined;
    try {
      // A message with attachments is recorded here, so they are saved with it before routing.
      if (laneId || options.attachments?.length || options.redoOf) userEventId = this.store.recordUserMessage(message, laneId, options.attachments ?? [], options.redoOf ?? null).id;
    } catch (error) {
      if (laneId) this.leaveLane(laneId);
      else if (alongside) this.chatRuns--;
      return Promise.reject(error);
    }
    const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    const work = () => {
      if (laneId && options.lane === "new") options.onLane?.(laneId);
      return this.handleIn(laneId, message, { ...options, alongside }, userEventId);
    };
    const run = laneId
      ? this.enqueueLane(laneId, work, signal).finally(() => this.leaveLane(laneId))
      : work();
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run)).catch(() => {});
    return run;
  }

  /** Stop every run, then terminals, every MCP server connection, and the embedding index. */
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    await Promise.allSettled([...this.inflight]);
    await this.runner.close();
    await this.runner.capabilities.catalog.close?.();
    await this.options.semantic?.close();
  }

  /** Reserve a place for a standard-mode chat beside the main conversation. */
  private claimChat(): null {
    if (this.chatRuns >= MAX_RUNNING_CHATS) throw new SocratesBusyError("chat_limit", `${MAX_RUNNING_CHATS} chats are already working; wait for one to finish or stop one.`);
    this.chatRuns++;
    return null;
  }

  /** Reserve the message's conversation: the main one, or a lane (opening it when new). */
  private claim(target: HandleOptions["lane"]): string | null {
    if (!target) {
      if (this.mainBusy) throw new SocratesBusyError("main_busy", "Socrates is already working on a message in the main conversation.");
      this.mainBusy = true;
      return null;
    }
    if (target !== "new") {
      const lane = this.store.getLane(target);
      if (!lane || lane.closedAt) throw new SocratesBusyError("lane_closed", "That lane is closed.");
    }
    if (!(target !== "new" && this.laneRuns.has(target)) && this.laneRuns.size >= MAX_RUNNING_LANES) {
      throw new SocratesBusyError("lane_limit", `${MAX_RUNNING_LANES} lanes are already working; wait for one to finish or stop one.`);
    }
    const laneId = target === "new" ? this.store.openLane().id : target;
    this.enterLane(laneId);
    return laneId;
  }

  private enterLane(laneId: string): void {
    this.laneRuns.set(laneId, (this.laneRuns.get(laneId) ?? 0) + 1);
  }

  private leaveLane(laneId: string): void {
    const n = (this.laneRuns.get(laneId) ?? 1) - 1;
    if (n > 0) this.laneRuns.set(laneId, n);
    else this.laneRuns.delete(laneId);
  }

  /** Serialize a lane before routing as well as execution, preserving cancelled queue tails. */
  private enqueueLane<T>(laneId: string, work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const previous = this.laneQueues.get(laneId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => mine);
    this.laneQueues.set(laneId, tail);
    return (async () => {
      try {
        await abortable(previous, signal);
        signal.throwIfAborted();
        return await work();
      } finally {
        release();
        void tail.then(() => { if (this.laneQueues.get(laneId) === tail) this.laneQueues.delete(laneId); });
      }
    })();
  }

  private async handleIn(laneId: string | null, message: string, options: HandleOptions, userEventId?: string): Promise<HandleResult> {
    // A chat running alongside holds its own place, not the main conversation's.
    let holdsMain = laneId === null && !options.alongside;
    let holdsChat = laneId === null && options.alongside === true;
    const releaseMain = () => {
      if (!holdsMain) return;
      holdsMain = false;
      this.mainBusy = false;
    };
    try {
      const signal = AbortSignal.any([this.lifetime.signal, ...(options.signal ? [options.signal] : [])]);
      // A lane with a task continues it directly; only its first message, or an answer to its clarification, is routed.
      const target = laneId && !this.store.pendingClarification(laneId) ? this.store.currentBinding(laneId) : null;
      let parts: RoutedPart[];
      let acknowledgment: string | null = null;
      let setupError: { error: unknown } | null = null;
      if (laneId && target) {
        const userEvent = userEventId ? this.store.getEvent(userEventId)! : this.store.recordUserMessage(message, laneId);
        const turn = this.store.bindTurn({ userEventId: userEvent.id, taskId: target.task.id, route: "lane" });
        parts = [{ order: 1, request: message, dependsOn: [], turn, goal: target.goal, task: target.task, chat: this.store.currentChat(target.task.id), clarification: null, created: { goal: false, task: false } }];
      } else if (options.target) {
        parts = [this.bindChosen(message, laneId, options.target, userEventId, options.pinned === true)];
      } else {
        const routed = await this.router.route(message, signal, { laneId, userEventId, laneActivity: this.laneActivity() });
        if (routed.kind === "clarify") {
          const notice = laneId ? laneNotice(this.store.requireLane(laneId).number, { kind: "clarify", question: routed.text }) : null;
          return { kind: "clarify", text: routed.text, laneId, notice, notices: notice ? [notice] : [] };
        }
        parts = routed.parts;
        acknowledgment = routed.acknowledgment;
        try { if (acknowledgment) options.onAcknowledgment?.(acknowledgment); }
        catch (error) { setupError = { error }; }
      }

      try { for (const part of parts) options.onBound?.(part.turn.id, part.task.id); }
      catch (error) { setupError ??= { error }; }

      const results: PartResult[] = [];
      const runOptions: RunOptions = { ...options, accessGrants: [] };
      let stopped = false;
      for (const part of parts) {
        // A part runs only after every earlier part finished with an answer.
        if (stopped || signal.aborted) results.push(this.skipPart(part));
        else {
          try {
            if (setupError) throw setupError.error;
            results.push(await this.runLocked(part, parts, signal, runOptions, laneId, parts.length === 1 ? releaseMain : () => {}));
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
          : [acknowledgment, ...results.map((r) => `**${r.order}. ${r.task.title}**\n\n${r.answer}`)].filter(Boolean).join("\n\n");
      const notices = results.filter((r) => r.turn.laneId).map((r) =>
        laneNotice(this.store.requireLane(r.turn.laneId!).number, { kind: "done", status: r.status, title: r.task.title, answer: r.answer }));
      return { kind: "answered", text, acknowledgment, parts: results, laneId, notice: notices.length ? notices.join("\n") : null, notices };
    } finally {
      releaseMain();
      if (holdsChat) {
        holdsChat = false;
        this.chatRuns--;
      }
      // Index what this message added, in the background; replies never wait for it.
      this.options.semantic?.scheduleSync();
    }
  }

  /** Whether a task has a message running or waiting, so it should not be renamed under it or archived. */
  taskBusy(taskId: string): boolean {
    return this.taskLocks.has(taskId);
  }

  /**
   * Why this turn's question cannot be asked again in another task, or null
   * when it can: only a finished or stopped task turn that is still the latest
   * of its task (later ones may build on its answer), once, and elsewhere.
   */
  redoProblem(turnId: string, toTaskId: string | null = null): string | null {
    const turn = this.store.getTurn(turnId);
    if (!turn || turn.kind !== "task" || !turn.taskId) return "That question cannot be redone.";
    if (this.store.redoneTo(turnId)) return "That question was already asked again in another task.";
    if (turn.status === "in_progress" || this.taskBusy(turn.taskId)) return "Socrates is still working on it; stop it first.";
    const redone = this.store.redoneTurnIds();
    if (this.store.turnsForTask(turn.taskId).some((t) => t.projectTurn > turn.projectTurn && !redone.has(t.id))) return "Later questions in this task build on this answer.";
    if (toTaskId === turn.taskId) return "That is the task it was answered in; pick another.";
    return null;
  }

  /** A standard-mode message, bound where the user sent it: its task, or a new one in its goal. */
  private bindChosen(message: string, laneId: string | null, target: NonNullable<HandleOptions["target"]>, userEventId?: string, pinned = false): RoutedPart {
    return this.store.transaction(() => {
      const created = !("taskId" in target);
      const task = "taskId" in target ? this.store.requireTask(target.taskId) : this.store.createTask(target.goalId, { title: target.title, objective: message.trim() || target.title });
      const goal = this.store.requireGoal(task.goalId);
      // A day of the general conversation is a chat like any other, but only the router starts one.
      if (goal.general && created) throw new Error("A standard-mode chat cannot be started in the general conversation.");
      if (task.archivedAt || goal.archivedAt) throw new Error("That chat is archived; restore it first.");
      // A chosen task that was closed is taken up again, by the user's choice.
      if (task.status !== "open") this.store.setTaskStatus(task.id, "open");
      const userEvent = userEventId ? this.store.getEvent(userEventId)! : this.store.recordUserMessage(message, laneId);
      const redoOf = (userEvent.payload as { redo_of?: string }).redo_of ?? null;
      // Checked again where it is bound: the turn may have changed since the message was sent.
      const problem = redoOf ? this.redoProblem(redoOf, task.id) : null;
      if (problem) throw new RedoError(problem);
      const turn = this.store.bindTurn({ userEventId: userEvent.id, taskId: task.id, route: redoOf ? "redo" : pinned ? "pinned" : created ? "standard_new" : "standard" });
      if (redoOf) this.store.markTurnRedone(redoOf, turn.id);
      return { order: 1, request: message, dependsOn: [], turn, goal, task: this.store.requireTask(task.id), chat: this.store.currentChat(task.id), clarification: null, created: { goal: false, task: created } };
    });
  }

  /**
   * Run one part once its task is free. A main-conversation part whose task
   * is queued or running in a lane moves to that lane, and the main
   * conversation is free for the next message.
   */
  private async runLocked(part: RoutedPart, parts: RoutedPart[], signal: AbortSignal, options: RunOptions, channel: string | null, releaseMain: () => void): Promise<PartResult> {
    const taskId = part.task.id;
    const held = this.taskLocks.get(taskId);
    const laneId = channel;
    if (channel === null && held?.laneId) {
      const destination = held.laneId;
      this.store.moveTurnToLane(part.turn.id, destination);
      this.enterLane(destination);
      releaseMain();
      try {
        options.onHandoff?.(destination, part.turn.id);
        // Do not reserve the task before the lane is available: its earlier
        // queued messages may themselves need that task.
        return await this.enqueueLane(destination, () => this.runLocked(part, parts, signal, options, destination, () => {}), signal);
      } finally { this.leaveLane(destination); }
    }
    const previous = held?.done ?? Promise.resolve();
    let unlock!: () => void;
    const mine = new Promise<void>((done) => (unlock = done));
    const entry: TaskLock = { laneId, done: previous.then(() => mine), previous: held };
    this.taskLocks.set(taskId, entry);
    const goalId = part.goal.id;
    let acquired = false;
    try {
      await abortable(previous, signal);
      signal.throwIfAborted();
      acquired = true;
      const fresh = !this.goalRuns.get(goalId);
      this.goalRuns.set(goalId, (this.goalRuns.get(goalId) ?? 0) + 1);
      this.approvers.set(part.turn.id, { approve: options.approve ?? this.options.approve, laneId });
      try {
        return await this.runPart({ ...part, turn: this.store.requireTurn(part.turn.id) }, parts, signal, options, fresh);
      } finally {
        this.approvers.delete(part.turn.id);
        this.approvalsWaiting.delete(part.turn.id);
        const n = (this.goalRuns.get(goalId) ?? 1) - 1;
        if (n > 0) this.goalRuns.set(goalId, n);
        else this.goalRuns.delete(goalId);
      }
    } finally {
      unlock();
      if (!acquired) {
        entry.cancelled = true;
        let tail = this.taskLocks.get(taskId);
        while (tail?.cancelled) tail = tail.previous;
        if (tail) this.taskLocks.set(taskId, tail);
        else this.taskLocks.delete(taskId);
      }
      // A cancelled waiter must not erase the still-running predecessor.
      void entry.done.then(() => { if (this.taskLocks.get(taskId) === entry) this.taskLocks.delete(taskId); });
    }
  }

  private async runPart(part: RoutedPart, parts: RoutedPart[], signal: AbortSignal, options: RunOptions, fresh: boolean): Promise<PartResult> {
    const { store } = this;
    const turn = part.turn;
    const goal = store.requireGoal(turn.goalId!);
    const startedAt = (this.options.now ?? Date.now)();
    const workspace = this.workspaceFor(goal);
    const capabilities = this.runner.capabilities;
    // Another run of this goal is mid-turn: keep the goal's capability state it is using.
    if (fresh) capabilities.beginTurn(goal.id);
    const tools = async (signal: AbortSignal) => [...this.runner.definitions, ...(await this.runner.mcpDefinitions(goal.id, signal))];
    const setupDeadline = new AbortController();
    const setupSignal = AbortSignal.any([signal, setupDeadline.signal]);
    const setupTimer = setTimeout(() => setupDeadline.abort(), Math.max(0, this.limits.maxWallMs - ((this.options.now ?? Date.now)() - startedAt)));
    let initialTools = this.runner.definitions;
    const request = store.requestForTurn(turn.id).request;
    const semantic = { task: [] as SemanticHit[], siblings: [] as SemanticHit[], capabilities: [] as SemanticHit[], anchors: [] as SemanticHit[], related: [] as SemanticHit[] };
    const access = this.options.access?.() ?? null;
    const historyBoundary = () => {
      const history = taskHistory(store, turn.id);
      return Math.max(history.summary?.to ?? 0, history.omitted?.to ?? 0);
    };
    const ownHistory = (signal: AbortSignal) => this.options.semantic!.search(request, {
      kinds: ["exchange", "tool_call"], taskIds: [turn.taskId!], throughTurn: historyBoundary(), limit: 20,
    }, signal);
    try {
      if (this.options.semantic) {
        // One query embedding (cached) serves the history and capability searches, and one more the
        // project files, read with the task it continues; failures return nothing and keywords carry on.
        const search = this.options.semantic;
        const workspaceId = workspace && canReadAutomatically(access, workspace.root) ? store.requireGoal(goal.id).workspaceId : null;
        const anchorPaths = store.listAnchors(goal.id).filter((a) => a.status !== "superseded").map((a) => a.path);
        const files = workspaceId ? projectQuery(store.requireTask(turn.taskId!), request) : "";
        [semantic.task, semantic.siblings, semantic.capabilities, semantic.anchors, semantic.related] = await Promise.all([
          ownHistory(setupSignal),
          search.search(request, { kinds: ["exchange", "tool_call"], goalIds: [goal.id], excludeTaskIds: [turn.taskId!], excludeTurnIds: parts.map((p) => p.turn.id), limit: 3, min: "strong" }, setupSignal),
          search.search(request, { kinds: ["capability"], limit: 5, min: "suggest" }, setupSignal),
          workspaceId && anchorPaths.length ? search.search(files, { kinds: ["file_section"], workspaceIds: [workspaceId], paths: anchorPaths, limit: 10 }, setupSignal) : [],
          workspaceId ? search.search(request, { kinds: ["file_section"], workspaceIds: [workspaceId], excludePaths: anchorPaths, limit: RELATED_MAX_SECTIONS, min: "strong" }, setupSignal) : [],
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
    const run = new RunState(undefined, options.accessGrants);
    const vision = this.options.model.vision === true;
    const shelf = skillShelf(store, capabilities.catalog, goal.id, this.options.shelf);
    const candidates = capabilityCandidates({ store, catalog: capabilities.catalog, goalId: goal.id, message: request, run, semantic: semantic.capabilities });
    // Rebuilt from the current active set each time, so compaction mid-turn keeps a Skill activated earlier in the turn.
    // The main conversation sees what its lanes are doing, as of the start of this turn.
    const lanes = turn.laneId ? null : lanesBlock(store, this.laneViews(), store.clock.now(), this.options.timeZone);
    // Read once, so a compaction mid-turn keeps the same first part.
    const memorySettings = this.options.memory?.() ?? MEMORY_ON;
    const assemble = (previousTurn?: number) =>
      assembleContext({
        store,
        turn,
        capabilities: capabilities.current(goal.id),
        shelf,
        candidates,
        semantic,
        workspace,
        dependsOn: part.dependsOn.map((order) => ({ order, turn: parts.find((p) => p.order === order)!.turn })),
        part: parts.length > 1 ? { order: part.order, count: parts.length } : null,
        lanes,
        access: this.options.access?.() ?? null,
        user: this.options.profile?.().name ?? null,
        memory: memorySettings,
        vision,
        now: store.clock.now(),
        timeZone: this.options.timeZone,
        budgets: { retrievedMax: this.budgets.retrievedMax, projectContextMax: this.budgets.projectContextMax, previousTurn: previousTurn ?? this.budgets.previousTurn },
      });
    const context = assemble();
    // The user's attached images go with the message to a model that can see them.
    const images = vision ? await attachmentImages(requestAttachments(store, turn), this.options.log) : [];
    const compact = createCompactor({
      store,
      model: this.options.compactorModel ?? this.options.model,
      turn,
      budgets: options.rollover === false ? { ...this.budgets, maxCompactionsPerChat: Number.POSITIVE_INFINITY } : this.budgets,
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
      ...(images.length ? { images } : {}),
      scope: { binding: { goalId: goal.id, taskId: turn.taskId!, chatId: turn.chatId, turnId: turn.id }, workspace, run, signal, vision },
      limits: this.limits,
      budgets: this.budgets,
      compact,
      ...(options.onDraft ? { onDraft: (draft: Draft) => options.onDraft!(turn.id, draft) } : {}),
      onResponse: (response, phase) => store.appendEvent("agent_message", { response, phase }, { goal_id: goal.id, task_id: turn.taskId, chat_id: turn.chatId, turn_id: turn.id }),
      ...(this.options.maxOutputTokens ? { maxOutputTokens: this.options.maxOutputTokens } : {}),
      trace: { userEventId: turn.userEventId, laneId: turn.laneId },
      ...(this.options.retryDelaysMs ? { retryDelaysMs: this.options.retryDelaysMs } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    // A stop that lands after the answer was written keeps what was written.
    const written = outcome.kind === "interrupted" ? outcome.partial : outcome.kind === "answer" ? outcome.answer.full_answer : null;
    return this.persist(part, goal, workspace, signal.aborted ? { kind: "interrupted", reason: "cancelled", detail: null, toolCalls: outcome.toolCalls, steps: outcome.steps, partial: written } : outcome, options.anchorDecisions ?? []);
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
      // Stopping keeps the answer as far as it was written; it is not a final answer and changes nothing else.
      const partial = outcome.partial?.trim() || null;
      const what = outcome.reason === "cancelled" ? (partial ? "Interrupted by the user while the answer was being written" : "Interrupted by the user") : "Stopped by a model failure";
      store.interruptTurn(turn.id, { reason: outcome.reason, toolCalls: outcome.toolCalls, continuationNote: mechanicalNote(what, outcome.toolCalls), ...(partial ? { partialAnswer: partial } : {}) });
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
    const anchors = applyAnchors({ store, goal, workspace: store.requireGoal(goal.id).workspaceId ? workspace : null, turn, proposals: answer.anchors, decisions: anchorDecisions, refs, access: this.options.access?.() ?? null });
    const visible = [answer.full_answer, anchors.question].filter(Boolean).join("\n\n");
    const response = store.recordResponse(visible, refs);
    store.completeTurn(turn.id, {
      responseEventId: response.id,
      continuationNote: answer.continuation_note,
      // The general conversation has no durable goal state and no completion.
      goalNote: goal.general ? null : answer.goal_note,
      // A standard-mode chat is never marked complete (architecture/agent-harness.md, "Task status").
      ...(!task.general && answer.task_complete && !CHAT_ROUTES.has(store.turnRoute(turn.id) ?? "") ? { taskComplete: true, taskCompleteReason: answer.task_complete.reason } : {}),
      stop: outcome.stop,
    });
    // Saved with the answer, so the agent may say it will remember.
    const memory = applyMemory({ store, goal, refs, proposal: answer.memory, settings: this.options.memory?.() ?? MEMORY_ON });
    return { ...result("completed", outcome.stop, visible), anchorChanges: anchors.changes, memoryChanges: memory };
  }

  /** A part that never ran because an earlier part was interrupted or the message was cancelled. */
  private skipPart(part: RoutedPart): PartResult {
    this.store.interruptTurn(part.turn.id, { reason: "cancelled", toolCalls: 0, continuationNote: mechanicalNote("Not started; an earlier part of the message was interrupted", 0) });
    return { order: part.order, turn: this.store.requireTurn(part.turn.id), task: this.store.requireTask(part.task.id), status: "interrupted", stop: null, answer: "Not started.", toolCalls: 0 };
  }

  /**
   * Where the turn's tools start: relative paths and commands begin here. A
   * project goal is bound to the application's working folder, permanently.
   * The general conversation is never bound: it starts in the working folder
   * as it is now. With an access policy, work with no folder starts in the
   * user's home, where the policy asks before every path outside their folders.
   */
  private workspaceFor(goal: Goal): WorkspaceRoot | null {
    if (goal.general) return this.openWorkspace(this.options.resolveWorkspace?.(goal) ?? null) ?? this.homeWorkspace();
    if (!goal.workspaceId) {
      const chosen = this.options.resolveWorkspace?.(goal);
      const existing = chosen ? this.store.findWorkspaceByName(chosen.name) : null;
      if (chosen && existing && existing.rootPath !== chosen.rootPath) {
        this.options.log?.(`workspace name ${chosen.name} already belongs to another folder; goal g${goal.number} stays without a workspace`);
      } else if (chosen) {
        goal = this.store.bindGoalWorkspace(goal.id, (existing ?? this.store.createWorkspace(chosen.name, chosen.rootPath)).id);
      }
    }
    const workspace = goal.workspaceId ? this.store.getWorkspace(goal.workspaceId) : null;
    return this.openWorkspace(workspace?.rootPath ? { name: workspace.name, rootPath: workspace.rootPath } : null) ?? this.homeWorkspace();
  }

  private openWorkspace(folder: { name: string; rootPath: string } | null): WorkspaceRoot | null {
    if (!folder) return null;
    try {
      return WorkspaceRoot.open(folder.name, folder.rootPath);
    } catch (error) {
      this.options.log?.(`workspace ${folder.name} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** Without an access policy, tools stay inside a workspace, so there is none to fall back to. */
  private homeWorkspace(): WorkspaceRoot | null {
    return this.options.access?.() ? this.openWorkspace({ name: "home", rootPath: homedir() }) : null;
  }
}
