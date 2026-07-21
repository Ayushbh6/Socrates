import { afterEach, describe, expect, it, vi } from "vitest";
import { v2Api } from "./api";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("V2 Flow API", () => {
  it("uses explicit DELETE endpoints for a focus and a complete exchange", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      return url.endsWith("/goals/v2goal_2")
        ? jsonResponse({ ok: true, data: { deletedGoalId: "v2goal_2", fallbackGoalId: "v2goal_1" } })
        : jsonResponse({ ok: true, data: { deletedTurnId: "v2turn_1" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(v2Api.deleteGoal("proj_1", "v2flow_1", "v2goal_2")).resolves.toMatchObject({ deletedGoalId: "v2goal_2" });
    await expect(v2Api.deleteTurn("proj_1", "v2flow_1", "v2turn_1")).resolves.toEqual({ deletedTurnId: "v2turn_1" });
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("accepts the bounded reference-only context projection returned after a real turn", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: true,
      data: {
        state: {
          evidence: [],
          items: [{
            id: "v2ctx_1",
            flowId: "v2flow_1",
            goalId: "v2goal_1",
            evidenceRef: {
              evidenceId: "v2evd_1",
              flowId: "v2flow_1",
              sourceType: "tool_output",
              sourceLocator: "evidence://v2flow_1/v2evd_1",
              contentHash: "abc123",
              capturedAt: "2026-07-17T12:00:00.000Z",
            },
            disposition: "unresolved",
            representation: "exact",
            tokenEstimate: 198,
            active: true,
            priority: 70,
            createdAtCompletedTurn: 1,
            decidedAtCompletedTurn: 1,
            unresolvedSinceCompletedTurn: 1,
            reviewDueAtCompletedTurn: 4,
          }],
        },
        counts: {
          immutableEvidenceCount: 1,
          activeItemCount: 1,
          releasedItemCount: 0,
        },
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(v2Api.getContext("proj_1", "v2flow_1")).resolves.toMatchObject({
      evidence: [],
      items: [{ tokenEstimate: 198 }],
      counts: { immutableEvidenceCount: 1, activeItemCount: 1, releasedItemCount: 0 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
