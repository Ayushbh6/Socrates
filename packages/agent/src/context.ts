import type { EventPayloads, TextPart } from "@socrates/contracts";
import { renderActivity } from "@socrates/router";
import type { Goal, LedgerStore, Task, Turn } from "@socrates/store";
import { type ContextBudgets, DEFAULT_BUDGETS } from "./budgets";
import { clarificationLine, historyParts, taskHistory } from "./history";
import { retrievedHistory } from "./retrieval";

/** At most this many open tasks are listed in `<GOAL_STATE>`. */
export const GOAL_STATE_MAX_TASKS = 8;
/** The evidence handoff between compound parts names at most this many evidence handles. */
export const HANDOFF_MAX_EVIDENCE = 4;
const HANDOFF_MAX_FACTS = 12;

export interface ContextInput {
  store: LedgerStore;
  turn: Turn;
  /** Active Skill instructions and active MCP public names of the goal. */
  capabilities: { skills: { name: string; instructions: string }[]; mcpTools: string[] };
  /** Dependent compound parts: the finalized turns of the parts this one depends on. */
  dependsOn: { order: number; turn: Turn }[];
  /** Compound position of this part, or null for a single-task message. */
  part: { order: number; count: number } | null;
  now: Date;
  timeZone: string;
  budgets?: Pick<ContextBudgets, "previousTurn" | "retrievedMax">;
}

/**
 * The first user message of every working-agent request, in the canonical
 * order of agent-harness.md ("Working-agent context"): goal-stable blocks,
 * chat history, turn-volatile blocks, and the current user message last.
 * Each piece is its own part so cache breakpoints fall on block boundaries.
 */
export function assembleContext(input: ContextInput): TextPart[] {
  const { store, turn } = input;
  const goal = store.requireGoal(turn.goalId!);
  const task = store.requireTask(turn.taskId!);

  const parts: TextPart[] = [{ text: `${[goalBlock(store, goal), activeCapabilities(input.capabilities)].filter(Boolean).join("\n\n")}\n\n` }];
  const budgets = input.budgets ?? DEFAULT_BUDGETS;
  const history = taskHistory(store, turn.id);
  parts.push(...historyParts(store, history, budgets.previousTurn));
  const message = currentMessage(store, turn);
  const boundary = Math.max(history.summary?.to ?? 0, history.omitted?.to ?? 0);

  const volatile = [
    goal.general ? null : goalState(store, goal, task),
    task.general ? null : currentTask(task, input.part, store.requestForTurn(turn.id).request),
    task.general ? block("RECENT_ACTIVITY", renderActivity(store, input.now, input.timeZone)) : null,
    ...input.dependsOn.map((d) => evidenceFromPart(store, d.order, d.turn)),
    retrievedHistory(store, { taskId: task.id, message, boundary, maxTokens: budgets.retrievedMax }),
    `<CURRENT_USER_MESSAGE>\n${message}\n</CURRENT_USER_MESSAGE>`,
  ].filter((b): b is string => b !== null);
  parts.push({ text: volatile.join("\n\n") });
  return parts;
}

function block(name: string, body: string, attributes = ""): string {
  return `<${name}${attributes}>\n${body.trim()}\n</${name}>`;
}

function goalBlock(store: LedgerStore, goal: Goal): string {
  const workspace = goal.workspaceId ? store.getWorkspace(goal.workspaceId) : null;
  const anchors = store.listAnchors(goal.id);
  const lines = [
    `title: ${goal.title}`,
    ...(goal.objective ? [`objective: ${goal.objective}`] : []),
    `workspace: ${workspace ? workspace.name : "none yet"}`,
  ];
  if (anchors.length) lines.push("anchors:", ...anchors.map((a) => `- ${a.path} — ${a.role}${a.summary ? `: ${a.summary}` : ""}${a.status === "provisional" ? " (provisional)" : ""}`));
  return block("GOAL", lines.join("\n"));
}

function activeCapabilities(c: ContextInput["capabilities"]): string | null {
  if (!c.skills.length && !c.mcpTools.length) return null;
  const lines: string[] = [];
  for (const s of c.skills) lines.push(`Skill ${s.name}:`, s.instructions.trim(), "");
  if (c.mcpTools.length) lines.push(`Active MCP tools: ${c.mcpTools.join(", ")}`);
  return block("ACTIVE_CAPABILITIES", lines.join("\n"));
}

function goalState(store: LedgerStore, goal: Goal, current: Task): string {
  const others = store.listTasks(goal.id, { status: "open" }).filter((t) => !t.general && t.id !== current.id);
  const shown = others.slice(0, GOAL_STATE_MAX_TASKS - 1);
  const lines = [`note: ${goal.note ?? "none yet"}`, "open_tasks:", `- t${current.number} ${current.title} — current`];
  for (const t of shown) lines.push(`- t${t.number} ${t.title} — open`);
  if (others.length > shown.length) lines.push(`- … and ${others.length - shown.length} more open tasks`);
  return block("GOAL_STATE", lines.join("\n"));
}

function currentTask(task: Task, part: ContextInput["part"], partRequest: string): string {
  const lines = [
    `title: ${task.title}`,
    `objective: ${task.objective}`,
    ...(task.completionCriteria ? [`completion_criteria: ${task.completionCriteria}`] : []),
    `status: ${task.status === "completed" ? "completed" : "active"}`,
    `note: ${task.continuationNote ?? "New task."}`,
  ];
  if (part) {
    lines.push(`this_turn: part ${part.order} of ${part.count} of the user's message — ${JSON.stringify(partRequest)}. Do only this part; the other parts run separately.`);
  }
  return block("CURRENT_TASK", lines.join("\n"));
}

/**
 * The bounded handoff from a finalized earlier part (agent-harness.md,
 * "Evidence handoff between parts"), built mechanically from its ledger entry.
 */
function evidenceFromPart(store: LedgerStore, order: number, turn: Turn): string {
  const task = store.requireTask(turn.taskId!);
  const selector = `g${store.requireGoal(task.goalId).number}/t${task.number}`;
  const evidence = store.evidenceForTurn(turn.id);
  const facts = store.listEvents({ turnId: turn.id, type: "tool_completed" }).flatMap((e) => (e.payload as EventPayloads["tool_completed"]).facts);
  const files = [...new Set(facts.filter((f) => f.kind === "file_changed").map((f) => f.value))].slice(0, HANDOFF_MAX_FACTS);
  const commands = [...new Set(facts.filter((f) => f.kind === "command").map((f) => f.value))].slice(-HANDOFF_MAX_FACTS);
  const exits = store.listEvents({ turnId: turn.id, type: "terminal_exited" });
  const tests = [...facts, ...exits.flatMap(e => (e.payload as EventPayloads["terminal_exited"]).facts ?? [])].filter(f => f.kind === "test").map(f => f.value);
  // The first and the last calls frame what the part did: what it found, and how it ended.
  const picked = evidence.length <= HANDOFF_MAX_EVIDENCE ? evidence : [...evidence.slice(0, 1), ...evidence.slice(-(HANDOFF_MAX_EVIDENCE - 1))];
  const lines = [
    ...(files.length ? [`files_changed: ${files.join(", ")}`] : []),
    ...(tests.length ? [`tests: ${[...new Set(tests)].slice(0, HANDOFF_MAX_FACTS).join("; ")}`] : []),
    ...(commands.length ? [`commands: ${commands.join("; ")}`] : []),
    `note: ${task.continuationNote ?? "none"}`,
    ...(picked.length ? [`evidence: ${picked.map((e) => `${selector}/${e.handle} (${e.tool})`).join(", ")} — expand with context_retrieve inspect`] : []),
  ];
  return block(`EVIDENCE_FROM_PART_${order}`, lines.join("\n"), ` task="${task.title.replace(/"/g, "'")}"`);
}

/** The exact user message, once. A compound part sees the whole message; its own part is named in CURRENT_TASK. */
function currentMessage(store: LedgerStore, turn: Turn): string {
  const bound = store.listEvents({ turnId: turn.id, type: "turn_bound" })[0]!.payload as EventPayloads["turn_bound"];
  const original = (store.getEvent(bound.request_event_id)!.payload as EventPayloads["user_message"]).text;
  const { clarification } = store.requestForTurn(turn.id);
  return clarification ? `${original}\n${clarificationLine(clarification)}` : original;
}
