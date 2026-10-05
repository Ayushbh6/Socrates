import { readFileSync } from "node:fs";
import path from "node:path";
import { type EventPayloads, ModelError } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { AGENT_SYSTEM_PROMPT } from "../src";
import { DEFAULT_LIMITS, spentTokens } from "../src/loop";
import { continueTask } from "../../router/test/helpers";
import { call, contextText, final, world } from "./helpers";

describe("the agent loop", () => {
  it("runs tools until a final answer and persists every field", async () => {
    const w = await world({ files: { "server.js": "const port = 30;\n" } });
    const { socrates, model } = w.socrates([continueTask()], [
      { toolCalls: [call("read", { path: "server.js" })] },
      { toolCalls: [call("edit", { path: "server.js", old_text: "30", new_text: "3000" })] },
      { toolCalls: [call("terminal", { command: "node -e \"console.log('ok')\"" })] },
      final({ full_answer: "The port is fixed.", continuation_note: "Port set to 3000; verified.", goal_note: "Server works again.", task_complete: { reason: "Server starts." } }),
    ]);
    const result = await socrates.handle("Fix the port.");
    expect(result).toMatchObject({ kind: "answered", text: "The port is fixed." });
    expect(readFileSync(path.join(w.root, "server.js"), "utf8")).toBe("const port = 3000;\n");

    const first = model.requests[0]!;
    expect(first.system).toBe(AGENT_SYSTEM_PROMPT);
    expect(first.tools!.map((t) => t.name)).toEqual(["read", "glob", "grep", "edit", "apply_patch", "terminal", "terminal_control", "context_retrieve", "capability_search", "capability_control"]);
    const text = contextText(first);
    const order = ["<GOAL>", "[TURN 1 — full]", "<GOAL_STATE>", "<CURRENT_TASK>", "<CURRENT_USER_MESSAGE>"].map((b) => text.indexOf(b));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    expect(text.trimEnd().endsWith("<CURRENT_USER_MESSAGE>\nFix the port.\n</CURRENT_USER_MESSAGE>")).toBe(true);
    // Results come back as native tool messages in the in-flight turn.
    expect(model.requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", toolName: "read" });

    const task = w.store.requireTask(w.taskId);
    expect(task).toMatchObject({ status: "completed", continuationNote: "Port set to 3000; verified." });
    expect(w.store.requireGoal(w.goalId).note).toBe("Server works again.");
    const turn = result.kind === "answered" ? result.parts[0]!.turn : null;
    expect(turn).toMatchObject({ status: "completed" });
    const completed = w.store.listEvents({ turnId: turn!.id, type: "turn_completed" })[0]!.payload as EventPayloads["turn_completed"];
    expect(completed).toMatchObject({ stop: "final", task_complete_reason: "Server starts." });
    expect(w.store.evidenceForTurn(turn!.id).map((e) => e.tool)).toEqual(["read", "edit", "terminal"]);
  });

  it("runs adjacent read-only calls together and everything else alone, returning results in emitted order", async () => {
    const w = await world({ files: { "a.txt": "alpha\n", "b.txt": "beta\n" } });
    const { socrates, model } = w.socrates([continueTask()], [
      { toolCalls: [call("read", { path: "a.txt" }), call("grep", { pattern: "beta" }), call("edit", { path: "b.txt", old_text: "beta", new_text: "gamma" }), call("read", { path: "b.txt" })] },
      final(),
    ]);
    const result = await socrates.handle("Change b.");
    const second = model.requests[1]!;
    const assistant = second.messages[1]!;
    const ids = assistant.role === "assistant" ? assistant.toolCalls!.map((c) => c.id) : [];
    expect(second.messages.slice(2).map((m) => (m.role === "tool" ? m.toolCallId : null))).toEqual(ids);
    // The read after the edit sees the edit: serial calls are barriers.
    expect(second.messages.at(-1)!.content).toContain("gamma");
    expect(result.kind === "answered" && w.store.evidenceForTurn(result.parts[0]!.turn.id).map((e) => e.tool)).toEqual(["read", "grep", "edit", "read"]);
  });

  it("repairs an invalid final answer once, without tools", async () => {
    const w = await world();
    const { socrates, model } = w.socrates([continueTask()], [{ text: "All done, the server works." }, final({ full_answer: "All done." })]);
    const result = await socrates.handle("Is it done?");
    expect(result).toMatchObject({ kind: "answered", text: "All done." });
    const repair = model.requests[1]!;
    expect(repair.toolChoice).toBe("none");
    expect(repair.messages.at(-1)!.content).toEqual([expect.objectContaining({ text: expect.stringContaining("not a valid final answer") })]);
  });

  it("keeps the visible text, writes a mechanical note, and records a warning when repair fails", async () => {
    const w = await world();
    w.store.reviseGoalNote(w.goalId, "Original goal note.");
    const long = "word ".repeat(400);
    const { socrates } = w.socrates([continueTask()], [
      final({ full_answer: "Here is the answer.", continuation_note: long }),
      { text: `{"full_answer": "Here is the answer.", "goal_note": "changed"` },
    ]);
    const result = await socrates.handle("Answer me.");
    expect(result).toMatchObject({ kind: "answered", text: "Here is the answer." });
    expect(w.store.requireTask(w.taskId).continuationNote).toBe("Ended without a valid final answer after 0 tool calls.");
    expect(w.store.requireGoal(w.goalId).note).toBe("Original goal note.");
    const warning = w.store.listEvents({ type: "agent_warning" })[0]!.payload as EventPayloads["agent_warning"];
    expect(warning.kind).toBe("final_answer_invalid");
  });

  it("rejects hidden notes over their token bounds in the repair request", async () => {
    const w = await world();
    const { socrates, model } = w.socrates([continueTask()], [final({ goal_note: "durable ".repeat(300) }), final()]);
    await socrates.handle("Go.");
    expect(JSON.stringify(model.requests[1]!.messages.at(-1))).toContain("goal_note is");
  });

  it("ends a turn at the step limit with one tool-less wrap-up request", async () => {
    const w = await world({ files: { "a.txt": "a\n" } });
    const read = { toolCalls: [call("read", { path: "a.txt" })] };
    const { socrates, model } = w.socrates([continueTask()], [read, read, final({ full_answer: "Partial: read a.txt twice; nothing else done." })], { limits: { maxSteps: 2 } });
    const result = await socrates.handle("Loop forever.");
    expect(result.kind === "answered" && result.parts[0]!.stop).toBe("steps");
    expect(model.requests).toHaveLength(3);
    const wrap = model.requests[2]!;
    expect(wrap.toolChoice).toBe("none");
    expect(JSON.stringify(wrap.messages.at(-1))).toContain("limit of 2 model steps");
  });

  it("ends at the token and time limits", async () => {
    for (const [limits, stop, usage] of [
      [{ maxTokens: 1000 }, "tokens", 2000],
      [{ maxWallMs: 1 }, "time", 0],
    ] as const) {
      const w = await world({ files: { "a.txt": "a\n" } });
      let clock = 0;
      const { socrates } = w.socrates(
        [continueTask()],
        [
          () => ({ text: "", toolCalls: [{ id: "c1", name: "read", input: { path: "a.txt" } }], stopReason: "tool_use", usage: { promptTokens: usage, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
          final(),
        ],
        { limits, now: () => (clock += 5) },
      );
      const result = await socrates.handle("Work.");
      expect(result.kind === "answered" && result.parts[0]!.stop).toBe(stop);
    }
  });

  it("counts a cached prompt at a tenth, so a long turn is not stopped for re-reading its own context", async () => {
    expect(spentTokens({ promptTokens: 50_000, cacheReadTokens: 48_000, outputTokens: 1_000 })).toBe(2_000 + 4_800 + 1_000);
    expect(spentTokens({ promptTokens: 10, cacheReadTokens: 99, outputTokens: 0 })).toBe(1);
    expect(DEFAULT_LIMITS.maxTokens).toBe(20_000_000);
    // 40 steps of a 60,000-token context, 58,000 of it cached: 2.4 million prompt tokens in full, 0.3 million as counted.
    const w = await world({ files: { "a.txt": "a\n" } });
    const step = () => ({ text: "", toolCalls: [{ id: "c", name: "read", input: { path: "a.txt" } }], stopReason: "tool_use" as const, usage: { promptTokens: 60_000, outputTokens: 500, cacheReadTokens: 58_000, cacheWriteTokens: 0 } });
    const { socrates } = w.socrates([continueTask()], [...Array.from({ length: 40 }, () => step), final({ full_answer: "Done." })], { limits: { maxTokens: 1_000_000 } });
    const result = await socrates.handle("Keep going.");
    expect(result.kind === "answered" && result.parts[0]!.stop).toBe("final");
    // The same turn with nothing cached does stop at that limit.
    const w2 = await world({ files: { "a.txt": "a\n" } });
    const bare = () => ({ ...step(), usage: { promptTokens: 60_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 } });
    const { socrates: s2 } = w2.socrates([continueTask()], [...Array.from({ length: 40 }, () => bare), final({ full_answer: "Partial." })], { limits: { maxTokens: 1_000_000 } });
    const stopped = await s2.handle("Keep going.");
    expect(stopped.kind === "answered" && stopped.parts[0]!.stop).toBe("tokens");
  });

  it("makes no further model call after cancellation and records the turn as interrupted", async () => {
    const w = await world({ files: { "a.txt": "a\n" } });
    const controller = new AbortController();
    const { socrates, model } = w.socrates([continueTask()], [
      () => {
        controller.abort();
        return { toolCalls: [call("read", { path: "a.txt" })] };
      },
      final(),
    ]);
    const result = await socrates.handle("Read it.", { signal: controller.signal });
    expect(model.requests).toHaveLength(1);
    expect(result).toMatchObject({ kind: "answered", text: "Stopped after 1 tool call." });
    const turn = result.kind === "answered" ? result.parts[0]!.turn : null;
    expect(turn!.status).toBe("interrupted");
    expect(w.store.requireTask(w.taskId).continuationNote).toBe("Interrupted by the user after 1 tool call.");
    // The cancelled call was refused, not run.
    expect(w.store.evidenceForTurn(turn!.id)[0]!.result!.error!.code).toBe("cancelled");
  });

  it("retries a transient provider failure and stops on a permanent one", async () => {
    const w = await world();
    const flaky = w.socrates([continueTask()], [
      () => {
        throw new ModelError("busy", "server", 503);
      },
      final({ full_answer: "Recovered." }),
    ]);
    expect(await flaky.socrates.handle("Go.")).toMatchObject({ text: "Recovered." });

    const broken = w.socrates([continueTask()], [
      () => {
        throw new ModelError("bad request", "invalid_request", 400);
      },
    ]);
    const result = await broken.socrates.handle("Go again.");
    expect(result.kind === "answered" && result.parts[0]!.status).toBe("interrupted");
    expect(w.store.listEvents({ type: "agent_warning" }).map((e) => (e.payload as EventPayloads["agent_warning"]).kind)).toEqual(["model_error"]);
  });

  it("answers without a workspace and tells the agent why files are unavailable", async () => {
    const w = await world({ workspace: false });
    const { socrates, model } = w.socrates([continueTask()], [{ toolCalls: [call("read", { path: "x.txt" })] }, final({ full_answer: "Which folder is the project in?" })]);
    const result = await socrates.handle("Read x.txt.");
    expect(result).toMatchObject({ text: "Which folder is the project in?" });
    expect(model.requests[1]!.messages.at(-1)!.content).toContain("no_workspace");
    expect(contextText(model.requests[0]!)).toContain("workspace: none yet");
  });

  it("returns a declined approval to the agent as a corrective error", async () => {
    const w = await world({ files: { "a.txt": "a\n" } });
    const lowConfidence = { text: continueTask().text.replace('"workspace_confidence":"high"', '"workspace_confidence":"low"') };
    const { socrates, model } = w.socrates([lowConfidence], [{ toolCalls: [call("edit", { path: "a.txt", old_text: "a", new_text: "b" })] }, final()], { approve: false });
    await socrates.handle("Change a.");
    expect(w.approvals.map((a) => a.kind)).toEqual(["first_mutation"]);
    expect(model.requests[1]!.messages.at(-1)!.content).toContain("approval_denied");
    expect(readFileSync(path.join(w.root, "a.txt"), "utf8")).toBe("a\n");
  });
});
