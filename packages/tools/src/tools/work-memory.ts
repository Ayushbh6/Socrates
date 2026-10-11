import { WorkMemoryInput } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import type { HandlerContext } from "../context";
import { ToolError } from "../errors";
import { type ToolHandler, json } from "../handler";

/**
 * The memory-only tool of the work-memory step (agent-harness.md, "Work
 * memory"): it reads and writes the project's index and topics, which live in
 * the ledger and in Socrates' data folder, never in the user's repository.
 * It is offered only in that step, and the runner refuses it anywhere else.
 */

/** A topic's name: short, lower-case, words joined by dashes. */
export const WORK_TOPIC_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** A topic is short: steps and pitfalls, about 300 words. */
export const WORK_TOPIC_MAX_CHARS = 3_000;
/** The index shown to the agent is held to this many tokens. */
export const WORK_MEMORY_INDEX_MAX_TOKENS = 1_500;
export const WORK_MEMORY_INDEX_MAX_LINES = 60;
const INDEX_LINE_MAX_CHARS = 200;
/** How an index line names its topic: "→ topic store-schema". */
export const INDEX_TOPIC = /→ topic ([a-z0-9][a-z0-9-]*)/g;

function scope(ctx: HandlerContext) {
  const memory = ctx.workMemory;
  if (!memory?.write) throw new ToolError("unknown_tool", "There is no tool named work_memory.", "Use the permanent tools.");
  return { projectId: memory.projectId, write: memory.write };
}

function topicName(name: string): string {
  const topic = name.trim();
  if (!WORK_TOPIC_NAME.test(topic)) throw new ToolError("invalid_topic", `${JSON.stringify(name)} is not a topic name.`, "Use a short kebab-case name of lower-case letters, digits and dashes, such as store-schema.");
  return topic;
}

export const workMemoryTool: ToolHandler<WorkMemoryInput> = {
  name: "work_memory",
  description: [
    "This project's work memory, kept by Socrates outside the project.",
    "read: the index and every topic's name, or one topic.",
    `write_topic: one topic, whole (at most ${WORK_TOPIC_MAX_CHARS} characters), replacing it.`,
    `write_index: the index, whole: one line per topic, "- <what to do> → topic <name> · turns N, M", newest first, at most ${WORK_MEMORY_INDEX_MAX_LINES} lines and ${WORK_MEMORY_INDEX_MAX_TOKENS} tokens.`,
  ].join(" "),
  schema: WorkMemoryInput,
  concurrency: "serial",
  mutating: false,
  async execute(input, ctx) {
    const { projectId, write } = scope(ctx);
    if (input.action === "read") {
      if (input.topic) {
        const topic = ctx.store.workTopic(projectId, topicName(input.topic));
        if (!topic) throw new ToolError("topic_not_found", `There is no topic ${input.topic}.`, "read without topic lists the topics; write_topic creates one.");
        const result = { action: "read", topic: topic.name, text: topic.text, updated_at: topic.updatedAt };
        return { content: json(result), result };
      }
      const index = ctx.store.workMemoryIndex(projectId);
      const result = { action: "read", index: index?.text ?? "", topics: ctx.store.listWorkTopics(projectId).map((t) => t.name) };
      return { content: json(result), result };
    }
    if (input.action === "write_topic") {
      const name = topicName(input.topic);
      const text = input.text.trim();
      if ([...text].length > WORK_TOPIC_MAX_CHARS) throw new ToolError("topic_too_long", `The topic is ${[...text].length} characters; the limit is ${WORK_TOPIC_MAX_CHARS}.`, "Keep the steps and pitfalls; drop what the code or README already says.");
      write("topic", name, text);
      const result = { action: "write_topic", topic: name, characters: [...text].length, written: true };
      return { content: json(result), result };
    }
    const text = input.text.trim();
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length > WORK_MEMORY_INDEX_MAX_LINES) throw new ToolError("index_too_long", `The index has ${lines.length} lines; the limit is ${WORK_MEMORY_INDEX_MAX_LINES}.`, "Merge related lines or drop the stalest.");
    const long = lines.find((l) => l.length > INDEX_LINE_MAX_CHARS);
    if (long) throw new ToolError("index_line_too_long", `A line is ${long.length} characters; the limit is ${INDEX_LINE_MAX_CHARS}: ${long.slice(0, 80)}…`, "Say what to do in a few words; the steps belong in the topic.");
    const tokens = countTokens(text);
    if (tokens > WORK_MEMORY_INDEX_MAX_TOKENS) throw new ToolError("index_too_long", `The index is ${tokens} tokens; the limit is ${WORK_MEMORY_INDEX_MAX_TOKENS}.`, "Merge related lines or drop the stalest.");
    const missing = [...new Set([...text.matchAll(INDEX_TOPIC)].map((m) => m[1]!))].filter((name) => !ctx.store.workTopic(projectId, name));
    if (missing.length) throw new ToolError("topic_not_found", `The index names topics that do not exist: ${missing.join(", ")}.`, "Write each topic with write_topic first, or fix its name.");
    write("index", null, text);
    const result = { action: "write_index", lines: lines.length, tokens, written: true };
    return { content: json(result), result };
  },
};
