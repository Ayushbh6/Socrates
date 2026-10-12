import type { EventPayloads, ModelMessage, TextPart } from "@socrates/contracts";
import type { SemanticHit } from "@socrates/retrieval";
import { type AccessPolicy, type ActiveCapabilities, type WorkspaceRoot, describeAccess } from "@socrates/tools";
import { renderActivity } from "@socrates/router";
import { countTokens, truncateToTokens } from "@socrates/shared";
import { quoteEvidence, contextSection, contextTime, currentRequest, foregroundTurns, renderContextExchange, type LedgerStore, type Task, type Turn } from "@socrates/store";
import { type ContextBudgets, DEFAULT_BUDGETS } from "./budgets";
import { generalHistoryParts, clarificationLine, historyParts, taskHistory } from "./history";
import type { MemorySettings } from "./memory";
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
  /** The user's memory switches; without them, memory is neither shown nor mentioned. */
  memory?: MemorySettings | null;
  /** This turn's `<MEMORY_CANDIDATES>` block, chosen once per turn, or null. */
  memoryCandidates?: string | null;
  /** The project's `<WORK_MEMORY>` index, read when the turn started, or null (agent-harness.md, "Work memory"). */
  workMemory?: string | null;
  /** This turn's `<MEMORY_HINT>` block, from the save gate, or null. */
  memoryHint?: string | null;
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
  generalHistoryBudget?: number;
  /** Activity captured at worker start, reused by context rebuilds. */
  activitySnapshot?: string;
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

  const note = store.goalNoteState(goal.id);
  const stable = [
    contextSection("USER_CONTEXT", quoteEvidence(input.user ? `The user's name is ${input.user}.` : "none")),
    input.memory ? contextSection("SAVED_USER_MEMORY", (input.memory.use ? store.profileMemories(goal.id).map(m => `## MEMORY\nmemory_ref: ${m.handle}\nscope: ${m.goalId ? `goal ${m.goalId}` : "user"}\ntext:\n${quoteEvidence(m.text)}\nsource_refs: ${m.sourceTurnId ?? "unknown"}`).join("\n\n") : "none") + (input.memory.save ? "" : "\nSaving memories is disabled; leave memory.save out.")) : null,
    input.workMemory ?? null,
    contextSection("GOAL", `goal_ref: g${goal.number}\ntitle: ${JSON.stringify(goal.title)}\nobjective: ${JSON.stringify(goal.objective)}\nworkspace_ref: ${goal.workspaceId ?? "none"}\n\n## GOAL_NOTE\ntext:\n${quoteEvidence(goal.note ?? "none")}\nsource_turn_ref: ${note.sourceTurn ?? "unknown"}\nfreshness: ${note.freshness}\nfreshness_reason: ${JSON.stringify(note.reason ?? "none")}`),
    input.shelf ?? null, activeCapabilities(input.capabilities),
  ].filter(Boolean);
  const parts: TextPart[] = [{ text: stable.join("\n\n") + "\n\n" }];
  const budgets = input.budgets ?? DEFAULT_BUDGETS;
  const history = taskHistory(store, turn.id);
  const general = task.general && !turn.laneId;
  const selected = general ? generalHistoryParts(store, turn, input.timeZone, budgets.previousTurn, input.generalHistoryBudget, input.now) : null;
  const historyBlocks = selected?.parts ?? historyParts(store, history, budgets.previousTurn, input.timeZone);
  parts.push({text: "# TASK_HISTORY\n"}, ...historyBlocks);
  parts.push({text: `## COVERAGE\nscope: ${general ? "general_cross_day" : turn.laneId ? "lane_task" : "selected_task"}\nbudget_tokens: ${general ? selected!.budget : "session compaction policy"}\nincluded_tokens: ${historyBlocks.reduce((n,p) => n + countTokens(p.text), 0)}\nincluded_turn_refs: ${(selected?.included ?? history.turns.map(t => t.projectTurn)).join(", ")}\nolder_history_omitted: ${selected ? selected.omitted > 0 : !!history.summary || !!history.omitted}\nexcerpts: marked in each exchange\nomitted_ranges: ${history.omitted ? JSON.stringify(history.omitted) : "none"}\n\n`, cache: true});
  const message = store.requestForTurn(turn.id);
  const root = store.requestRoot(turn.userEventId);
  const boundary = Math.max(history.summary?.to ?? 0, history.omitted?.to ?? 0);
  const chat = store.currentChat(task.id);
  const taskNote = store.noteState(task.id);
  // A new task can depend explicitly on an earlier proposal. Keep that source outside task history.
  const predecessor = !general && !history.turns.length && !history.summary && /\b(option\s+\w+|(?:that|this|your|the above)\s+(?:proposal|plan|approach|suggestion)|as (?:discussed|above)|do (?:that|it)|go ahead)\b/i.test(message.request)
    ? foregroundTurns(store, [turn.laneId]).find(t => t.status !== "in_progress" && !store.redoneTurnIds().has(t.id) && t.taskId !== task.id && t.projectTurn < turn.projectTurn && t.userEventId !== turn.userEventId) : null;
  const handoff = predecessor ? contextSection("REQUEST_HANDOFF", `source_turn_refs: ${predecessor.id}\nreason: current request refers to preceding work; source evidence, not selected-task history\n\n## REFERENCED_CONTEXT\n${quoteEvidence(renderContextExchange(store, predecessor, {timeZone: input.timeZone, budget: 3_000}))}`) : null;
  const retrieved = general ? null : retrievedHistory(store, {taskId: task.id, message: message.request, boundary, maxTokens: budgets.retrievedMax,
    ...(input.semantic ? {semantic: input.semantic.task, siblings: goal.general ? [] : input.semantic.siblings} : {}),
    excludeTurnIds: new Set([...store.turnsForUserEvent(turn.userEventId).map(t => t.id), ...history.turns.map(t => t.id), ...(predecessor ? [predecessor.id] : [])]), now: input.now, timeZone: input.timeZone});
  const project = projectContext({store, goalId: goal.id, workspace: input.workspace ?? null, access: input.access, query: projectQuery(task, message.request), semantic: {anchors: input.semantic?.anchors ?? [], related: input.semantic?.related ?? []}, maxTokens: budgets.projectContextMax ?? DEFAULT_BUDGETS.projectContextMax});
  const relatedWork = general && /\b(?:pending|unfinished|current work|open tasks|working on|task status|catch me up)\b/i.test(message.request);
  const volatile = [
    contextSection("TASK", `task_ref: g${goal.number}/t${task.number}\ntitle: ${JSON.stringify(task.title)}\nobjective: ${JSON.stringify(task.objective)}\ncompletion_criteria: ${JSON.stringify(task.completionCriteria ?? "none")}\n${taskStatus(store, task, turn).join("\n")}\n${input.part ? `part: ${input.part.order} of ${input.part.count}; assigned request: ${JSON.stringify(message.request)}; do only this part\n` : ""}${turn.laneId ? `lane_ref: ${turn.laneId}\nlane: you are lane ${store.requireLane(turn.laneId).number}, working this task beside the main conversation.${laneOf(store, turn)?.handedOff ? ' The user wrote this message in the main conversation; it was handed to you because you work this task. "The lane" in it means you.' : ''}\n` : ""}\n## CONTINUATION_NOTE\ntext:\n${quoteEvidence(task.continuationNote ?? "none")}\nsource_turn_ref: ${taskNote.sourceTurn ?? "unknown"}\nfreshness: ${taskNote.freshness}\nfreshness_reason: ${JSON.stringify(taskNote.reason ?? "none")}`),
    contextSection("SESSION", `chat_ref: ${chat.id}\nsequence: ${chat.ordinal}\ncontinuation_of: ${chat.continuationOf ?? "none"}\nhandover_ref: ${chat.handoverRef ?? "none"}\ncompactions_completed: ${chat.compactionCount}`),
    handoff,
    redoneFrom(store, turn),
    ...([{content: retrieved, scope: "selected_goal"}, {content: input.memoryCandidates, scope: "applicable_memory"}, {content: project, scope: "selected_goal"}]).flatMap(({content, scope}) => content ? [contextSection("RETRIEVED_CONTEXT", `## ITEM\nsource_ref: ${JSON.stringify(contextReferences(content, goal.number, task.number, input.workspace?.root))}\nscope: ${scope}\ncoverage: bounded; exclusions marked in content\nreason: applicable historical or project evidence\ncontent:\n${quoteEvidence(content)}`)] : []),
    input.dependsOn.length ? contextSection("DEPENDENCY_RESULTS", input.dependsOn.map(d => `## DEPENDENCY\npart_ref: ${d.order}\nturn_ref: ${d.turn.id}\noutcome: ${d.turn.status}\nevidence_refs: ${JSON.stringify(store.evidenceForTurn(d.turn.id).slice(0, HANDOFF_MAX_EVIDENCE).map(e => `g${store.requireGoal(d.turn.goalId!).number}/t${store.requireTask(d.turn.taskId!).number}/${e.handle}`))}\nanswer:\n${quoteEvidence(d.turn.responseEventId ? (store.getEvent(d.turn.responseEventId)!.payload as EventPayloads["assistant_response"]).text : "unavailable")}\n${quoteEvidence(evidenceFromPart(store, d.order, d.turn))}`).join("\n\n")) : null,
    relatedWork || input.lanes ? contextSection("RELATED_WORK_STATE", `as_of: ${contextTime(input.now, input.timeZone)}\n${[relatedWork ? input.activitySnapshot ?? renderActivity(store, input.now, input.timeZone, turn.userEventId) : null, input.lanes].filter(Boolean).join("\n")}`) : null,
    input.access ? contextSection("ACCESS", `working_folder: ${JSON.stringify(input.workspace?.root ?? "none")}\nallowed_folders: ${JSON.stringify(input.access.folders)}\napproval_mode: ${input.access.approvals}\nrestrictions:\n${describeAccess(input.access, input.workspace?.root ?? null)}`) : null,
    input.memoryHint ? contextSection("MEMORY_SAVE_HINT", input.memoryHint) : null,
    input.candidates ?? null,
    contextSection("CURRENT_TIME", `at: ${contextTime(input.now, input.timeZone)}\ntimezone: ${input.timeZone}\nfrozen_for_turn: true`),
    !input.vision && message.attachments.length ? "The current model cannot see images: use the attachment path with read when needed." : null,
    currentRequest({id: root.id, at: root.at, turnId: turn.id, text: message.request, clarification: message.clarification, attachments: message.attachments.map(a => ({name: a.name, mediaType: a.media_type, path: a.path}))}, input.timeZone),
  ].filter((b): b is string => b !== null);
  parts.push({text: volatile.join("\n\n")});
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

/** At most this many changed files and commands of the first attempt are listed in `<REDONE_FROM>`. */
const REDONE_FROM_MAX_ITEMS = 20;

/**
 * `<REDONE_FROM>`: for a question the user asked again here because the router
 * put it in another task, what that first attempt did that may still be in
 * effect. Facts only, never its answer, which was written with the other
 * task's context.
 */
export function redoneFrom(store: LedgerStore, turn: Turn): string | null {
  const first = store.redoOf(turn.id);
  if (!first?.taskId) return null;
  const task = store.requireTask(first.taskId);
  const goal = store.requireGoal(task.goalId);
  const files = store.listEvents({ turnId: first.id, type: "file_changed" }).map((e) => {
    const p = e.payload as EventPayloads["file_changed"];
    return p.action === "moved" ? `- moved ${p.from_path} to ${p.path}` : `- ${p.action} ${p.path}`;
  });
  const exits = new Map(store.listEvents({ type: "terminal_exited" }).map((e) => [(e.payload as EventPayloads["terminal_exited"]).session_id, e.payload as EventPayloads["terminal_exited"]]));
  const commands = store.listEvents({ turnId: first.id, type: "terminal_started" }).map((e) => {
    const p = e.payload as EventPayloads["terminal_started"];
    const exit = exits.get(p.session_id);
    const ended = !exit ? (p.background ? "still running in the background" : "no exit recorded") : exit.exit_code !== null ? `exit ${exit.exit_code}` : `ended: ${exit.signal ?? exit.reason}`;
    return `- ran \`${p.command.split("\n")[0]}\` in ${p.cwd} (${ended})`;
  });
  const done = [...files, ...commands];
  const lines = [
    `The user first asked this in another task, "${goal.general ? "General conversation" : goal.title} · ${task.title}", and asked it again here because it belongs here. Answer it with this task's context. That attempt ${first.status === "completed" ? "finished" : "was stopped"}; its answer is not shown, because it was written for the other task.`,
    done.length
      ? `What it did may still be in effect. Check the current state before repeating any of it:\n${done.slice(0, REDONE_FROM_MAX_ITEMS).join("\n")}${done.length > REDONE_FROM_MAX_ITEMS ? `\n- and ${done.length - REDONE_FROM_MAX_ITEMS} more` : ""}`
      : "It changed no files and ran no commands.",
  ];
  return block("REDONE_FROM", lines.join("\n\n"));
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

/** Concrete retrieval handles in legacy bounded payloads; never substitute a vague placeholder. */
function contextReferences(content: string, goal: number, task: number, root?: string): string[] {
  const refs = new Set<string>();
  for (const m of content.matchAll(/\[TURN (\d+)/g)) refs.add(`turn_number ${m[1]}`);
  for (const m of content.matchAll(/\[(m\d+)\b/g)) refs.add(m[1]!);
  for (const m of content.matchAll(/^anchor (.+?) —/gm)) refs.add(`read ${JSON.stringify(root ? `${root}/${m[1]}` : m[1])}`);
  for (const m of content.matchAll(/^--- (.+?)(?: › [^\n]*?)? \(lines (\d+)–(\d+)\)/gm)) refs.add(`read ${JSON.stringify(m[1])} lines ${m[2]}–${m[3]}`);
  return refs.size ? [...refs] : [`g${goal}/t${task}`];
}
