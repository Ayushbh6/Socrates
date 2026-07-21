import type { Message } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { countFlowTurns, groupFlowExchanges, selectFlowExchange, sliceLatestFlowTurns } from "./flowTranscriptWindow";

const message = (id: string, turnId: string, role: Message["role"]): Message => ({
  id,
  conversationId: "flow_1",
  sessionId: "flow_1",
  turnId,
  role,
  content: id,
  status: "completed",
  createdAt: "2026-07-20T00:00:00.000Z",
});

describe("Flow transcript turn window", () => {
  it("keeps complete user and assistant pairs when selecting the latest turns", () => {
    const messages = [
      message("u1", "turn_1", "user"),
      message("a1", "turn_1", "assistant"),
      message("u2", "turn_2", "user"),
      message("a2", "turn_2", "assistant"),
      message("u3", "turn_3", "user"),
      message("a3", "turn_3", "assistant"),
    ];
    expect(sliceLatestFlowTurns(messages, 2).map(({ id }) => id)).toEqual(["u2", "a2", "u3", "a3"]);
  });

  it("counts adjacent messages with one turn id as one turn", () => {
    const messages = [
      message("u1", "turn_1", "user"),
      message("a1", "turn_1", "assistant"),
      message("u2", "turn_2", "user"),
    ];
    expect(countFlowTurns(messages)).toBe(2);
  });

  it("groups the transcript into human-readable exchanges", () => {
    const messages = [
      { ...message("u1", "turn_1", "user"), content: "Review the DBMS folder and tell me where I left off" },
      message("a1", "turn_1", "assistant"),
      { ...message("u2", "turn_2", "user"), content: "Now compare the two indexing approaches" },
      message("a2", "turn_2", "assistant"),
    ];
    const exchanges = groupFlowExchanges(messages);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]).toMatchObject({ turnId: "turn_1", label: "Review the DBMS folder and tell me where I left off" });
    expect(exchanges[1]?.messages.map(({ id }) => id)).toEqual(["u2", "a2"]);
  });

  it("shows one selected exchange and otherwise follows the active or latest turn", () => {
    const messages = [
      message("u1", "turn_1", "user"),
      message("a1", "turn_1", "assistant"),
      message("u2", "turn_2", "user"),
      message("a2", "turn_2", "assistant"),
      message("u3", "turn_3", "user"),
    ];
    expect(selectFlowExchange(messages, "turn_1", "turn_3")?.turnId).toBe("turn_1");
    expect(selectFlowExchange(messages, null, "turn_3")?.turnId).toBe("turn_3");
    expect(selectFlowExchange(messages)?.turnId).toBe("turn_3");
  });
});
