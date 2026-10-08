import type { EventPayloads, ModelMessage, TextPart } from "@socrates/contracts";
import type { SemanticHit } from "@socrates/retrieval";
import { type AccessPolicy, type ActiveCapabilities, type WorkspaceRoot, describeAccess } from "@socrates/tools";
import { renderActivity } from "@socrates/router";
import type { Goal, LedgerStore, Task, Turn } from "@socrates/store";
import { type ContextBudgets, DEFAULT_BUDGETS } from "./budgets";
import { attachmentLines, requestAttachments, requestText } from "./attachments";
import { clarificationLine, historyParts, taskHistory } from "./history";
import { projectContext } from "./project-context";
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
  capabilities: ActiveCapabilities;
  /** The goal's frozen `<AVAILABLE_SKILLS>` block, or null. */
  shelf?: string | null;
  /** This turn's `<CAPABILITY_CANDIDATES>` block, or null. */
  candidates?: string | null;
  /** Meaning matches for `<RETRIEVED_HISTORY>` and `<PROJECT_CONTEXT>`, searched once per turn. */
  semantic?: { task: SemanticHit[]; siblings: SemanticHit[]; anchors?: SemanticHit[]; related?: SemanticHit[] };
  /** The main conversation's `<LANES>` block, or null (in a lane, or with no lanes to show). */
  lanes?: string | null;
  /** The user's name as they gave it in onboarding, or null; it opens the first part, which stays the same from turn to turn. */
  user?: string | null;
  /** Where tools may work and when they ask, as of the turn's start; null for the workspace boundary. */
  access?: AccessPolicy | null;
  /** The goal's workspace, whose anchors and files fill `<PROJECT_CONTEXT>`. */
  workspace?: WorkspaceRoot | null;
  /** Dependent compound parts: the finalized turns of the parts this one depends on. */
  dependsOn: { order: number; turn: Turn }[];
  /** Compound position of this part, or null for a single-task message. */
  part: { order: number; count: number } | null;
  now: Date;
  timeZone: string;
  budgets?: Pick<ContextBudgets, "previousTurn" | "retrievedMax"> & Partial<Pick<ContextBudgets, "projectContextMax">>;
  /** Whether the working model sees the message's attached images. */
  vision?: boolean;
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

  const parts: TextPart[] = [{ text: `${[userBlock(input.user), goalBlock(store, goal), input.shelf ?? null, activeCapabilities(input.capabilities)].filter(Boolean).join("\n\n")}\n\n` }];
  const budgets = input.budgets ?? DEFAULT_BUDGETS;
  const history = taskHistory(store, turn.id);
  parts.push(...historyParts(store, history, budgets.previousTurn));
  const message = currentMessage(store, turn, input.vision ?? false);
  const boundary = Math.max(history.summary?.to ?? 0, history.omitted?.to ?? 0);

  const volatile = [
    goal.general ? null : goalState(store, goal, task),
    task.general && !turn.laneId ? null : currentTask(task, input.part, store.requestForTurn(turn.id).request, laneOf(store, turn), taskStatus(store, task, turn)),
    task.general ? block("RECENT_ACTIVITY", renderActivity(store, input.now, input.timeZone)) : null,
    input.lanes ?? null,
    input.access ? block("ACCESS", describeAccess(input.access, input.workspace?.root ?? null)) : null,
    ...input.dependsOn.map((d) => evidenceFromPart(store, d.order, d.turn)),
    retrievedHistory(store, {
      taskId: task.id,
      message,
      boundary,
      maxTokens: budgets.retrievedMax,
      ...(input.semantic ? { semantic: input.semantic.task, siblings: goal.general ? [] : input.semantic.siblings } : {}),
      // The other parts of a compound message are never "older" history.
      excludeTurnIds: new Set(store.turnsForUserEvent(turn.userEventId).map((t) => t.id)),
      now: input.now,
      timeZone: input.timeZone,
    }),
    projectContext({
      store,
      goalId: goal.id,
      workspace: input.workspace ?? null,
      access: input.access,
      query: projectQuery(task, store.requestForTurn(turn.id).request),
      semantic: { anchors: input.semantic?.anchors ?? [], related: input.semantic?.related ?? [] },
      maxTokens: input.budgets?.projectContextMax ?? DEFAULT_BUDGETS.projectContextMax,
    }),
    input.candidates ?? null,
    `<CURRENT_USER_MESSAGE>\n${message}\n</CURRENT_USER_MESSAGE>`,
  ].filter((b): b is string => b !== null);
  parts.push({ text: volatile.join("\n\n") });
  return parts;
}

/** What `<PROJECT_CONTEXT>` serves: the request, read with the task it continues ("today's lesson" after "Day 9 completed"). */
export function projectQuery(task: Task, request: string): string {
  return [request, task.general ? null : task.title, task.general ? null : task.continuationNote].filter(Boolean).join("\n");
}

function block(name: string, body: string, attributes = ""): string {
  return `<${name}${attributes}>\n${body.trim()}\n</${name}>`;
}

/** `<USER>`: who is asking, when they said. Angle brackets and line breaks are dropped, so a name cannot pose as another block. */
export function userBlock(name: string | null | undefined): string | null {
  const clean = name?.replace(/[<>\r\n]+/g, " ").trim();
  return clean ? block("USER", `The user's name is ${clean}.`) : null;
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
  if (!c.skills.length && !c.mcpTools.length && !c.staleSkills?.length) return null;
  const lines: string[] = [];
  for (const s of c.skills) {
    lines.push(`Skill ${s.name}:`, s.instructions.trim());
    if (s.resourceBase) lines.push(`resource_base: ${JSON.stringify(s.resourceBase)}`);
    if (s.dependencies?.length) lines.push(`dependencies (activate separately when needed): ${s.dependencies.join(", ")}`);
    lines.push("");
  }
  if (c.staleSkills?.length) lines.push(`Stale Skills (instructions withheld; search and activate again): ${c.staleSkills.join(", ")}`);
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

/** The lane a turn runs in, and whether its message was handed over from the main conversation. */
function laneOf(store: LedgerStore, turn: Turn): { number: number; handedOff: boolean } | null {
  if (!turn.laneId) return null;
  return { number: store.requireLane(turn.laneId).number, handedOff: store.listEvents({ turnId: turn.id, type: "turn_moved_to_lane" }).length > 0 };
}

/** Standard mode's routes: the user chose the chat, and a chat is never complete. */
export const CHAT_ROUTES = new Set(["standard", "standard_new"]);

/**
 * The task's status line (agent-harness.md, "Task status"): a standard-mode
 * chat is never complete; a task the user reopened stays open until the work
 * they reopened it for is finished; the user may have kept this message here.
 */
function taskStatus(store: LedgerStore, task: Task, turn: Turn): string[] {
  const route = store.turnRoute(turn.id);
  if (route && CHAT_ROUTES.has(route)) return ["status: active — a chat in standard mode, which is never marked complete: always set task_complete to null."];
  const source = store.statusSource(task.id);
  const lines = [`status: ${task.status === "open" ? "active" : task.status}`];
  if (task.status === "open" && source?.by === "user" && source.status === "open") {
    lines[0] += ` — the user reopened this task on ${source.at.slice(0, 10)}. Keep it open unless this turn finishes the work they reopened it for; then task_complete.reason says what was finished.`;
  }
  if (route === "pinned") lines.push("kept_here: the user chose to keep this message in this task, without routing.");
  return lines;
}

function currentTask(task: Task, part: ContextInput["part"], partRequest: string, lane: { number: number; handedOff: boolean } | null, status: string[]): string {
  const lines = [
    `title: ${task.title}`,
    `objective: ${task.objective}`,
    ...(task.completionCriteria ? [`completion_criteria: ${task.completionCriteria}`] : []),
    ...status,
    `note: ${task.continuationNote ?? "New task."}`,
  ];
  if (part) {
    lines.push(`this_turn: part ${part.order} of ${part.count} of the user's message — ${JSON.stringify(partRequest)}. Do only this part; the other parts run separately.`);
  }
  if (lane) {
    lines.push(`lane: you are lane ${lane.number}, working this task beside the main conversation.${lane.handedOff ? ` The user wrote this message in the main conversation; it was handed to you because you work this task. "The lane" in it means you.` : ""}`);
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
function currentMessage(store: LedgerStore, turn: Turn, vision: boolean): string {
  const bound = store.listEvents({ turnId: turn.id, type: "turn_bound" })[0]!.payload as EventPayloads["turn_bound"];
  const original = (store.getEvent(bound.request_event_id)!.payload as EventPayloads["user_message"]).text;
  const { clarification } = store.requestForTurn(turn.id);
  const attachments = requestAttachments(store, turn);
  return [requestText(original, attachments), clarification ? clarificationLine(clarification) : "", attachmentLines(attachments, vision)].filter(Boolean).join("\n");
}

/** Synchronize only capability exposure. Keep native calls and exact stored evidence intact.
 * An in-flight activation carries its instructions until linearized; don't duplicate it in the prefix. */
export function refreshCapabilityContext(messages: ModelMessage[], capabilities: ActiveCapabilities): ModelMessage[] {
  const inFlight = new Set<string>();
  let changed = false;
  const next = messages.map((message): ModelMessage => {
    if (message.role !== "tool" || message.toolName !== "capability_control" || message.isError) return message;
    let result: Record<string, unknown>;
    try { result = JSON.parse(message.content); } catch { return message; }
    if (result.kind !== "skill" || result.status !== "activated" || typeof result.instructions !== "string") return message;
    const active = capabilities.skills.find((s) => s.name === result.name && s.instructions === result.instructions && (s.version === undefined || s.version === result.version));
    if (active) { inFlight.add(active.name); return message; }
    changed = true;
    const { instructions, resource_base, dependencies, ...historical } = result;
    return { ...message, content: JSON.stringify({ ...historical, note: "Historical activation; this version is no longer active. Exact result remains in context_retrieve." }) };
  });
  const first = next[0];
  if (!first || first.role !== "user" || typeof first.content === "string") return changed ? next : messages;
  const parts = [...first.content];
  if (!parts[0]) return changed ? next : messages;
  const block = activeCapabilities({ ...capabilities, skills: capabilities.skills.filter((s) => !inFlight.has(s.name)) });
  const prefix = parts[0].text.replace(/\n*<ACTIVE_CAPABILITIES>[\s\S]*<\/ACTIVE_CAPABILITIES>\s*$/, "").trimEnd();
  const text = `${prefix}${block ? `\n\n${block}` : ""}\n\n`;
  if (text !== parts[0].text) {
    changed = true;
    parts[0] = { ...parts[0], text };
    next[0] = { ...first, content: parts };
  }
  return changed ? next : messages;
}
