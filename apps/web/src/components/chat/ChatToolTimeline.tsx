import { ToolActivityRow } from "./ToolActivityRow";
import type { PendingApproval, ToolTimelineItem } from "./ToolTimelineTypes";

interface ChatToolTimelineProps {
  tools: ToolTimelineItem[];
  approvals?: PendingApproval[];
  onApprovalDecision?: (approvalId: string, decision: "approved" | "rejected") => void;
}

export function ChatToolTimeline({ tools, approvals = [], onApprovalDecision }: ChatToolTimelineProps) {
  if (tools.length === 0 && approvals.length === 0) {
    return null;
  }

  const orphanApprovals = approvals.filter((approval) => approval.toolCallId && !tools.some((tool) => tool.toolCallId === approval.toolCallId));

  return (
    <div className="my-3 space-y-1">
      {tools.map((tool) => (
        <ToolActivityRow
          key={tool.toolCallId}
          tool={tool}
          approval={findApprovalForTool(tool, approvals)}
          onApprovalDecision={onApprovalDecision}
        />
      ))}
      {orphanApprovals.map((approval) => {
        const isFileApproval = approval.actionKind === "file_write" || approval.actionKind === "patch_apply";
        return (
          <ToolActivityRow
            key={approval.approvalId}
            tool={{
              toolCallId: approval.toolCallId ?? approval.approvalId,
              conversationId: "",
              sessionId: "",
              turnId: "",
              toolName: isFileApproval ? "edit" : "bash",
              displayName: "Approval",
              category: isFileApproval ? "patch" : "shell",
              status: approval.status === "pending" ? "awaiting_approval" : approval.status === "rejected" ? "rejected" : "completed",
              requiresApproval: true,
              output: "",
              summary: approval.title,
              argsPreview: isFileApproval ? undefined : approval.actionPreview,
              approval,
            }}
            approval={approval}
            onApprovalDecision={onApprovalDecision}
          />
        );
      })}
    </div>
  );
}

const findApprovalForTool = (tool: ToolTimelineItem, approvals: PendingApproval[]): PendingApproval | undefined => {
  const liveApproval = approvals.find((approval) => approval.toolCallId === tool.toolCallId);
  if (liveApproval) {
    return liveApproval;
  }
  return tool.approval ? { ...tool.approval, toolCallId: tool.toolCallId } : undefined;
};
