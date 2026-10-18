import { WorkMemoryInput } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import type { LedgerStore, WorkMemoryEntry } from "@socrates/store";
import type { HandlerContext } from "../context";
import { ToolError } from "../errors";
import { type ToolHandler, json } from "../handler";

/**
 * The memory-only tool of the work-memory step (agent-harness.md, "Work
 * memory"): it reads and writes this task's and its goal's notes, which live
 * in the ledger and in Socrates' data folder, never in the user's folders.
 * It is offered only in that step, and the runner refuses it anywhere else.
 */

/** A topic's name: short, lower-case, words joined by dashes. */
export const WORK_TOPIC_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** A topic is short: steps and pitfalls, about 300 words. */
export const WORK_TOPIC_MAX_CHARS = 3_000;
/** The indexes shown to the agent are held to this many tokens together. */
export const WORK_MEMORY_INDEX_MAX_TOKENS = 1_500;
export const WORK_MEMORY_INDEX_MAX_LINES = 60;
const INDEX_LINE_MAX_CHARS = 200;
/** How an index line names its topic: "→ topic store-schema". */
export const INDEX_TOPIC = /→ topic ([a-z0-9][a-z0-9-]*)/g;

type Level = "task" | "goal";

/** A topic's ref: "topic:goal/<name>" for the goal's, "topic:t2/<name>" for a task's. */
export function topicRef(store: LedgerStore, entry: WorkMemoryEntry): string {
  const task = entry.taskId ? store.getTask(entry.taskId) : null;
  return `topic:${task ? `t${task.number}` : "goal"}/${entry.name}`;
}

/**
 * The topic a ref names in a goal: "topic:goal/<name>", "topic:tN/<name>"
 * (a task of this goal), or a bare "topic:<name>", looked for in the current
 * task, then the goal.
 */
export function resolveTopicRef(store: LedgerStore, scope: { goalId: string; taskId: string | null }, ref: string): WorkMemoryEntry | null {
  const body = ref.trim().replace(/^topic:/i, "").toLowerCase();
  const slash = body.indexOf("/");
  if (slash < 0) return (scope.taskId ? store.workTopic(scope.goalId, scope.taskId, body) : null) ?? store.workTopic(scope.goalId, null, body);
  const level = body.slice(0, slash);
  const name = body.slice(slash + 1);
  if (level === "goal") return store.workTopic(scope.goalId, null, name);
  const n = level.match(/^t([1-9]\d*)$/)?.[1];
  const task = n ? store.getTaskByNumber(scope.goalId, Number(n)) : null;
  return task ? store.workTopic(scope.goalId, task.id, name) : null;
}

function scope(ctx: HandlerContext) {
  const memory = ctx.workMemory;
  if (!memory?.write) throw new ToolError("unknown_tool", "There is no tool named work_memory.", "Use the permanent tools.");
  return { goalId: memory.goalId, taskId: memory.taskId, write: memory.write };
}

/** The task id a level writes to: null for the goal; refused for a task in General. */
function owner(taskId: string | null, level: Level): string | null {
  if (level === "goal") return null;
  if (!taskId) throw new ToolError("no_task_memory", "The General conversation keeps one memory for every day: it has no task memory.", "Use level goal, with a topic named by its subject.");
  return taskId;
}

function topicName(name: string): string {
  const topic = name.trim();
  if (!WORK_TOPIC_NAME.test(topic)) throw new ToolError("invalid_topic", `${JSON.stringify(name)} is not a topic name.`, "Use a short kebab-case name of lower-case letters, digits and dashes, such as store-schema.");
  return topic;
}

const names = (topics: WorkMemoryEntry[]) => topics.map((t) => t.name!);

export const workMemoryTool: ToolHandler<WorkMemoryInput> = {
  name: "work_memory",
  description: [
    "This task's and its goal's work memory, kept by Socrates outside the user's folders. level task: this task's; level goal: shared by the goal's tasks.",
    "read: indexes and topic names (with the goal's other tasks' topics), or one topic.",
    `write_topic: one topic, whole (at most ${WORK_TOPIC_MAX_CHARS} characters), replacing it.`,
    `write_index: one level's index, whole: one line per topic, "- <what to do> → topic <name> · turns N, M", newest first, at most ${WORK_MEMORY_INDEX_MAX_LINES} lines and ${WORK_MEMORY_INDEX_MAX_TOKENS} tokens; empty removes it.`,
    "remove_topic: one topic, once its index no longer names it (after moving it to the goal).",
  ].join(" "),
  schema: WorkMemoryInput,
  concurrency: "serial",
  mutating: false,
  async execute(input, ctx) {
    const { goalId, taskId, write } = scope(ctx);
    const store = ctx.store;
    if (input.action === "read") {
      if (input.topic) {
        const name = topicName(input.topic);
        const topic = input.level ? store.workTopic(goalId, owner(taskId, input.level), name) : resolveTopicRef(store, { goalId, taskId }, name);
        if (!topic) throw new ToolError("topic_not_found", `There is no topic ${input.topic}${input.level ? ` at level ${input.level}` : ""}.`, "read without topic lists the topics; write_topic creates one.");
        const result = { action: "read", level: topic.taskId ? "task" : "goal", topic: topic.name, text: topic.text, updated_at: topic.updatedAt };
        return { content: json(result), result };
      }
      const level = (l: Level) => {
        const id = owner(taskId, l);
        return { index: store.workMemoryIndex(goalId, id)?.text ?? "", topics: names(store.listWorkTopics({ goalId, taskId: id })) };
      };
      if (input.level) {
        const result = { action: "read", level: input.level, ...level(input.level) };
        return { content: json(result), result };
      }
      const others = new Map<string, string[]>();
      for (const t of store.listWorkTopics({ goalId })) {
        if (!t.taskId || t.taskId === taskId) continue;
        const task = store.getTask(t.taskId);
        if (task) others.set(`t${task.number} ${task.title}`, [...(others.get(`t${task.number} ${task.title}`) ?? []), t.name!]);
      }
      const result = {
        action: "read",
        ...(taskId ? { task: level("task") } : {}),
        goal: level("goal"),
        ...(others.size ? { other_tasks: [...others].map(([task, topics]) => ({ task, topics })) } : {}),
      };
      return { content: json(result), result };
    }
    const id = owner(taskId, input.level);
    if (input.action === "write_topic") {
      const name = topicName(input.topic);
      const text = input.text.trim();
      if ([...text].length > WORK_TOPIC_MAX_CHARS) throw new ToolError("topic_too_long", `The topic is ${[...text].length} characters; the limit is ${WORK_TOPIC_MAX_CHARS}.`, "Keep the steps and pitfalls; drop what the code or README already says.");
      write(input.level, "topic", name, text);
      const result = { action: "write_topic", level: input.level, topic: name, characters: [...text].length, written: true };
      return { content: json(result), result };
    }
    if (input.action === "remove_topic") {
      const name = topicName(input.topic);
      if (!store.workTopic(goalId, id, name)) throw new ToolError("topic_not_found", `There is no topic ${name} at level ${input.level}.`, "read lists the topics of each level.");
      const index = store.workMemoryIndex(goalId, id)?.text ?? "";
      if ([...index.matchAll(INDEX_TOPIC)].some((m) => m[1] === name)) throw new ToolError("topic_in_index", `The ${input.level}'s index still names ${name}.`, "write_index without its line first, then remove it.");
      write(input.level, "topic", name, null);
      const result = { action: "remove_topic", level: input.level, topic: name, removed: true };
      return { content: json(result), result };
    }
    const text = input.text.trim();
    if (!text) {
      write(input.level, "index", null, null);
      const result = { action: "write_index", level: input.level, lines: 0, removed: true };
      return { content: json(result), result };
    }
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length > WORK_MEMORY_INDEX_MAX_LINES) throw new ToolError("index_too_long", `The index has ${lines.length} lines; the limit is ${WORK_MEMORY_INDEX_MAX_LINES}.`, "Merge related lines or drop the stalest.");
    const long = lines.find((l) => l.length > INDEX_LINE_MAX_CHARS);
    if (long) throw new ToolError("index_line_too_long", `A line is ${long.length} characters; the limit is ${INDEX_LINE_MAX_CHARS}: ${long.slice(0, 80)}…`, "Say what to do in a few words; the steps belong in the topic.");
    const tokens = countTokens(text);
    if (tokens > WORK_MEMORY_INDEX_MAX_TOKENS) throw new ToolError("index_too_long", `The index is ${tokens} tokens; the limit is ${WORK_MEMORY_INDEX_MAX_TOKENS}.`, "Merge related lines or drop the stalest.");
    const missing = [...new Set([...text.matchAll(INDEX_TOPIC)].map((m) => m[1]!))].filter((name) => !store.workTopic(goalId, id, name));
    if (missing.length) throw new ToolError("topic_not_found", `The ${input.level}'s index names topics it does not hold: ${missing.join(", ")}.`, "Write each topic at this level with write_topic first, or fix its name.");
    write(input.level, "index", null, text);
    const result = { action: "write_index", level: input.level, lines: lines.length, tokens, written: true };
    return { content: json(result), result };
  },
};
