import {
  type AskUserInput,
  LEDGER_QUERY_MAX_CALLS,
  type ModelClient,
  type ModelMessage,
  type RouterDecision,
  type ToolCall,
} from "@socrates/contracts";
import type { Chat, Goal, LedgerStore, Task, Turn } from "@socrates/store";
import { type RoutingContext, buildRoutingContext } from "./context";
import { ROUTER_SYSTEM_PROMPT } from "./prompt";
import { ASK_USER_TOOL, LEDGER_QUERY_TOOL, executeLedgerQuery, renderToolError } from "./tools";
import {
  type ResolvedPart,
  type ResolvedRoute,
  type SeenSelectors,
  emptySeen,
  validateAskUser,
  validateDecisionText,
} from "./validate";

export interface GoalRouterOptions {
  store: LedgerStore;
  /** The routing model: a small, fast tier by default, or the same model as the agent. */
  routerModel: ModelClient;
  /** The working agent's model, used for the single escalation retry. Omit or pass the same client to disable. */
  mainModel?: ModelClient;
  /** IANA time zone used for CURRENT_TIME, activity dates, and ledger_query dates. */
  timeZone: string;
  historyBudgetTokens?: number;
  /** Model steps per routing attempt (tool rounds plus the final answer). */
  maxSteps?: number;
}

export interface RoutedPart {
  order: number;
  request: string;
  dependsOn: number[];
  turn: Turn;
  goal: Goal;
  task: Task;
  chat: Chat;
  created: { goal: boolean; task: boolean };
}

export type RoutingResult =
  | {
      kind: "routed";
      userEventId: string;
      parts: RoutedPart[];
      /** For compound routes: the one-line plan shown before part 1 starts. */
      acknowledgment: string | null;
      escalated: boolean;
      fallback: string | null;
    }
  | {
      kind: "clarify";
      userEventId: string;
      turn: Turn;
      question: AskUserInput;
      /** The question as shown to the user and stored as the visible response. */
      text: string;
      escalated: boolean;
      fallback: string | null;
    };

type AttemptOutcome =
  | { kind: "decision"; route: ResolvedRoute }
  | { kind: "clarify"; ask: AskUserInput }
  | { kind: "invalid"; errors: string[] };

interface Budget {
  ledgerQueries: number;
}

/**
 * The Goal Router: the first phase of every Socrates turn. It runs once,
 * before the working agent, with its own prompt and exactly two bounded tools,
 * and selects which goal and task own the message. It never writes state; the
 * harness validates its answer and performs the binding.
 */
export class GoalRouter {
  private readonly store: LedgerStore;
  private readonly routerModel: ModelClient;
  private readonly mainModel: ModelClient | undefined;
  private readonly timeZone: string;
  private readonly historyBudgetTokens: number | undefined;
  private readonly maxSteps: number;

  constructor(options: GoalRouterOptions) {
    this.store = options.store;
    this.routerModel = options.routerModel;
    this.mainModel = options.mainModel && options.mainModel !== options.routerModel ? options.mainModel : undefined;
    this.timeZone = options.timeZone;
    this.historyBudgetTokens = options.historyBudgetTokens;
    this.maxSteps = options.maxSteps ?? 6;
  }

  /** Persist the exact message, route it, and bind it. */
  async route(message: string, signal?: AbortSignal): Promise<RoutingResult> {
    const userEvent = this.store.recordUserMessage(message);
    const ctx = buildRoutingContext(this.store, message, {
      timeZone: this.timeZone,
      ...(this.historyBudgetTokens !== undefined ? { historyBudgetTokens: this.historyBudgetTokens } : {}),
    });
    const seen = emptySeen();
    const budget: Budget = { ledgerQueries: 0 };

    let attempts = 1;
    let escalated = false;
    let modelId = this.routerModel.id;
    let outcome = await this.attempt(this.routerModel, ctx, seen, budget, signal);
    if (outcome.kind === "invalid" && this.mainModel) {
      attempts++;
      escalated = true;
      modelId = this.mainModel.id;
      outcome = await this.attempt(this.mainModel, ctx, seen, budget, signal);
    }

    let fallback: string | null = null;
    let final: Exclude<AttemptOutcome, { kind: "invalid" }>;
    if (outcome.kind === "invalid") {
      const f = this.fallback(ctx);
      fallback = f.name;
      final = f.outcome;
    } else {
      final = outcome;
    }

    const meta = { model: modelId, attempts, escalated, fallback, ledgerQueries: budget.ledgerQueries };
    if (final.kind === "clarify") return this.applyClarify(userEvent.id, final.ask, meta);
    return this.applyDecision(userEvent.id, final.route, meta);
  }

  /** One routing attempt on one model: tool rounds, then a validated answer with at most one repair. */
  private async attempt(
    model: ModelClient,
    ctx: RoutingContext,
    seen: SeenSelectors,
    budget: Budget,
    signal: AbortSignal | undefined,
  ): Promise<AttemptOutcome> {
    const tools = ctx.answeringClarification ? [LEDGER_QUERY_TOOL] : [LEDGER_QUERY_TOOL, ASK_USER_TOOL];
    const messages: ModelMessage[] = [{ role: "user", content: ctx.input }];
    let repaired = false;
    let lastErrors: string[] = ["The router did not return a decision."];

    for (let step = 0; step < this.maxSteps; step++) {
      const response = await model.complete({
        system: ROUTER_SYSTEM_PROMPT,
        messages,
        tools,
        maxOutputTokens: 2_000,
        temperature: 0,
        ...(signal ? { signal } : {}),
      });

      if (response.toolCalls.length > 0) {
        messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
        for (const call of response.toolCalls) {
          const result = this.executeTool(call, ctx, seen, budget);
          if (result.ask) return { kind: "clarify", ask: result.ask };
          messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.isError });
        }
        continue;
      }

      const validation = validateDecisionText(response.text, ctx, this.store, seen);
      if (validation.ok) return { kind: "decision", route: validation.value };
      lastErrors = validation.errors;
      if (repaired) break;
      repaired = true;
      messages.push({ role: "assistant", content: response.text });
      messages.push({
        role: "user",
        content:
          "Your routing result is invalid:\n" +
          validation.errors.map((e) => `- ${e}`).join("\n") +
          "\nReturn the corrected JSON object only.",
      });
    }
    return { kind: "invalid", errors: lastErrors };
  }

  private executeTool(
    call: ToolCall,
    ctx: RoutingContext,
    seen: SeenSelectors,
    budget: Budget,
  ): { content: string; isError: boolean; ask?: AskUserInput } {
    if (call.name === "ask_user") {
      const v = validateAskUser(call.input, ctx);
      if (v.ok) return { content: "", isError: false, ask: v.value };
      return {
        content: renderToolError({
          code: "invalid_clarification",
          message: v.errors.join("; "),
          correction: "Fix the question as described, or return a routing decision instead.",
          retryable: true,
        }),
        isError: true,
      };
    }
    if (call.name === "ledger_query") {
      if (budget.ledgerQueries >= LEDGER_QUERY_MAX_CALLS) {
        return {
          content: renderToolError({
            code: "ledger_query_limit",
            message: `ledger_query is limited to ${LEDGER_QUERY_MAX_CALLS} calls per routing decision.`,
            correction: "Decide with what you have, or ask the user with constructive candidates.",
            retryable: false,
          }),
          isError: true,
        };
      }
      budget.ledgerQueries++;
      const r = executeLedgerQuery(this.store, call.input, ctx.timeZone, seen);
      return { content: r.content, isError: !r.ok };
    }
    return {
      content: renderToolError({
        code: "unknown_tool",
        message: `The router has no tool named "${call.name}".`,
        correction: "Use ledger_query or ask_user, or return the routing JSON.",
        retryable: true,
      }),
      isError: true,
    };
  }

  /**
   * Harness fallback when no valid answer was produced (Goal-router.md):
   * with no goals, create the first goal; with one clearly current goal,
   * continue it; otherwise ask which subject the user means.
   */
  private fallback(ctx: RoutingContext): { name: string; outcome: Exclude<AttemptOutcome, { kind: "invalid" }> } {
    const realGoals = this.store.listGoals().filter((g) => !g.general);
    if (realGoals.length === 0) {
      const title = firstWords(ctx.message, 8);
      return {
        name: "first_goal",
        outcome: {
          kind: "decision",
          route: syntheticRoute(ctx, { kind: "new_goal", goalTitle: title, taskTitle: title }, "Fallback: no goals exist yet."),
        },
      };
    }
    const older = [...ctx.goals.values()].filter((g) => g.kind === "older");
    if (ctx.current && older.length === 0) {
      return {
        name: "continue_current",
        outcome: {
          kind: "decision",
          route: syntheticRoute(
            ctx,
            ctx.current.goal.general ? { kind: "general" } : { kind: "existing_task", goal: ctx.current.goal, task: ctx.current.task },
            "Fallback: one clearly current goal.",
          ),
        },
      };
    }
    const candidates = [...ctx.goals.values()].slice(0, 5).map((g, i) => ({
      label: g.goal.title.slice(0, 80),
      detail: (g.tasks[0]?.task.title ?? "no tasks yet").slice(0, 200),
      ...(i === 0 ? { suggested: true } : {}),
    }));
    return {
      name: "ask_subject",
      outcome: {
        kind: "clarify",
        ask: { question: "Which of these should I continue with?", candidates, allow_new: true },
      },
    };
  }

  private applyClarify(
    userEventId: string,
    ask: AskUserInput,
    meta: { model: string; attempts: number; escalated: boolean; fallback: string | null; ledgerQueries: number },
  ): RoutingResult {
    const text = renderClarification(ask);
    const turn = this.store.transaction(() => {
      const turn = this.store.recordClarification(userEventId, text);
      this.store.appendEvent(
        "clarification_asked",
        { question: ask.question, candidates: ask.candidates, allow_new: ask.allow_new, zero_history: ask.zero_history ?? false },
        { turn_id: turn.id },
      );
      this.store.appendEvent(
        "routing_completed",
        {
          outcome: "clarify",
          decision: ask,
          model: meta.model,
          attempts: meta.attempts,
          escalated: meta.escalated,
          fallback: meta.fallback,
          ledger_queries: meta.ledgerQueries,
          reason: ask.question,
        },
        { turn_id: turn.id },
      );
      return turn;
    });
    return { kind: "clarify", userEventId, turn, question: ask, text, escalated: meta.escalated, fallback: meta.fallback };
  }

  /** Materialize goals and tasks the route creates, then bind one turn per part. */
  private applyDecision(
    userEventId: string,
    route: ResolvedRoute,
    meta: { model: string; attempts: number; escalated: boolean; fallback: string | null; ledgerQueries: number },
  ): RoutingResult {
    const parts = this.store.transaction(() => {
      const bound: RoutedPart[] = [];
      for (const part of route.parts) {
        const { goal, task, created } = this.materialize(part);
        const turn = this.store.bindTurn({
          userEventId,
          taskId: task.id,
          partOrder: route.compound ? part.order : null,
          workspaceConfidence: part.target.kind === "general" ? null : part.workspaceConfidence,
          gateArmed: part.target.kind !== "general" && part.workspaceConfidence === "low",
          route: describeRoute(part),
        });
        bound.push({
          order: part.order,
          request: part.request,
          dependsOn: part.dependsOn,
          turn,
          goal: this.store.requireGoal(goal.id),
          task,
          chat: this.store.requireChat(turn.chatId!),
          created,
        });
      }
      this.store.appendEvent(
        "routing_completed",
        {
          outcome: "decision",
          decision: route.decision satisfies RouterDecision,
          model: meta.model,
          attempts: meta.attempts,
          escalated: meta.escalated,
          fallback: meta.fallback,
          ledger_queries: meta.ledgerQueries,
          reason: route.reason,
        },
        { goal_id: bound[0]!.goal.id, task_id: bound[0]!.task.id, turn_id: bound[0]!.turn.id },
      );
      return bound;
    });
    return {
      kind: "routed",
      userEventId,
      parts,
      acknowledgment: route.compound ? splitAcknowledgment(parts) : null,
      escalated: meta.escalated,
      fallback: meta.fallback,
    };
  }

  private materialize(part: ResolvedPart): { goal: Goal; task: Task; created: { goal: boolean; task: boolean } } {
    const target = part.target;
    switch (target.kind) {
      case "general": {
        const { goal, task } = this.store.ensureGeneral();
        return { goal, task, created: { goal: false, task: false } };
      }
      case "existing_task":
        return { goal: target.goal, task: target.task, created: { goal: false, task: false } };
      case "new_task": {
        const task = this.store.createTask(target.goal.id, { title: target.taskTitle, objective: part.request });
        return { goal: target.goal, task, created: { goal: false, task: true } };
      }
      case "new_goal": {
        const goal = this.store.createGoal({ title: target.goalTitle });
        const task = this.store.createTask(goal.id, { title: target.taskTitle, objective: part.request });
        return { goal, task, created: { goal: true, task: true } };
      }
    }
  }
}

function syntheticRoute(ctx: RoutingContext, target: ResolvedPart["target"], reason: string): ResolvedRoute {
  return {
    decision: {
      decision: target.kind === "new_goal" ? "create_new" : "continue_current",
      goal_label: null,
      new_goal_title: null,
      task_decision: null,
      task_label: null,
      new_task_title: null,
      workspace_confidence: null,
      parts: null,
      reason,
    },
    compound: false,
    parts: [
      { order: 1, request: ctx.message, decision: "fallback", taskDecision: null, target, workspaceConfidence: "high", dependsOn: [], reason },
    ],
    reason,
  };
}

function describeRoute(part: ResolvedPart): string {
  const t = part.target;
  switch (t.kind) {
    case "general":
      return "general";
    case "existing_task":
      return `${part.decision}/${part.taskDecision ?? "fallback"} g${t.goal.number}/t${t.task.number}`;
    case "new_task":
      return `${part.decision}/create_task g${t.goal.number}`;
    case "new_goal":
      return `${part.decision}/create_task new goal`;
  }
}

function firstWords(text: string, n: number): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").slice(0, n).join(" ");
  return (words || "New goal").slice(0, 120);
}

/** The question as the user sees it, with candidates rendered so they enter recent history. */
export function renderClarification(ask: AskUserInput): string {
  const lines = [ask.question];
  for (const c of ask.candidates) lines.push(`• ${c.label} — ${c.detail}${c.suggested ? " (suggested)" : ""}`);
  if (ask.allow_new && ask.candidates.length) lines.push("• None of these — start something new");
  return lines.join("\n");
}

/** Mechanical one-line plan for a compound route: no model call, no latency. */
export function splitAcknowledgment(parts: RoutedPart[]): string {
  const count = ["", "One thing", "Two things", "Three things", "Four things"][parts.length] ?? `${parts.length} things`;
  const steps = parts.map((p) => p.task.title);
  const plan = steps.length === 2 ? `${steps[0]} first, then ${steps[1]}` : steps.map((s, i) => `${i + 1}) ${s}`).join(", ");
  return `${count} here — I'll do ${plan}.`;
}
