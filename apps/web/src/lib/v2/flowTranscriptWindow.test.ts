import type { Message } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { countFlowTurns, sliceLatestFlowTurns } from "./flowTranscriptWindow";

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
});
