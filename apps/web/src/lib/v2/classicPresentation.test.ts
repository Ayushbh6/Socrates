import type { V2Approval, V2ToolCall } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { flowToolToClassicToolRun } from "./classicPresentation";

const timestamp = "2026-07-20T00:00:00.000Z";

const approval = (status: V2Approval["status"] = "pending"): V2Approval => ({
  id: "approval_1",
  flowId: "flow_1",
  projectId: "project_1",
  turnId: "turn_1",
  toolCallId: "tool_1",
  status,
  actionKind: "shell_command",
  action: { argv: ["pwd"] },
  requestedAt: timestamp,
});

const tool = (status: V2ToolCall["status"]): V2ToolCall => ({
  id: "tool_1",
  flowId: "flow_1",
  projectId: "project_1",
  turnId: "turn_1",
  modelCallId: "model_call_1",
  toolName: "bash",
  status,
  arguments: { argv: ["pwd"] },
  requiresApproval: true,
  approvalId: "approval_1",
  startedAt: timestamp,
});

describe("Flow to Classic presentation adapters", () => {
  it("lets the shared Classic activity UI summarize tool arguments", () => {
    const presented = flowToolToClassicToolRun({
      ...tool("completed"),
      toolName: "read",
      arguments: { path: "DBMS/MEMORY.md" },
      completedAt: "2026-07-20T00:00:01.000Z",
    });

    expect(presented.arguments).toEqual({ path: "DBMS/MEMORY.md" });
    expect(presented).not.toHaveProperty("summary");
  });

  it("keeps an unresolved approval actionable while its tool is awaiting approval", () => {
    const presented = flowToolToClassicToolRun(tool("awaiting_approval"), approval());
    expect(presented.status).toBe("awaiting_approval");
    expect(presented.approval).toMatchObject({ status: "pending" });
    expect(presented.approval).not.toHaveProperty("decision");
  });

  it("normalizes a stale pending approval after the tool has completed", () => {
    const presented = flowToolToClassicToolRun(
      { ...tool("completed"), completedAt: "2026-07-20T00:00:01.000Z" },
      approval(),
    );
    expect(presented.status).toBe("completed");
    expect(presented.approval).toMatchObject({ status: "approved", decision: "approved" });
  });
});
