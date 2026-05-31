import { ChevronDown, SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";
import { ToolActivityRow } from "./ToolActivityRow";
import type { PendingApproval, ToolTimelineItem } from "./ToolTimelineTypes";

interface ChatToolTimelineProps {
  tools: ToolTimelineItem[];
  approvals?: PendingApproval[];
  onApprovalDecision?: (approvalId: string, decision: "approved" | "rejected") => void;
}

export function ChatToolTimeline({ tools, approvals = [], onApprovalDecision }: ChatToolTimelineProps) {
  const orphanApprovals = approvals.filter((approval) => approval.toolCallId && !tools.some((tool) => tool.toolCallId === approval.toolCallId));
  const hasPendingApproval = approvals.some((approval) => approval.status === "pending");
  const hasActiveWork = tools.some(
    (tool) => tool.phase === "streaming" || tool.status === "running" || tool.status === "awaiting_approval",
  );
  const [isOpen, setIsOpen] = useState(hasPendingApproval || hasActiveWork);
  const summary = useMemo(() => summarizeToolGroup(tools, approvals), [tools, approvals]);
  const shouldShowDetails = isOpen || hasPendingApproval || hasActiveWork;

  if (tools.length === 0 && approvals.length === 0) {
    return null;
  }

  return (
    <div className="py-1">
      <button
        type="button"
        className="group flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left text-sm text-brand-text-light hover:bg-gray-50"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={shouldShowDetails}
      >
        <SquareTerminal className="size-4 shrink-0 text-brand-text-light" />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <ChevronDown className={`size-4 shrink-0 transition-transform ${shouldShowDetails ? "rotate-180" : ""}`} />
      </button>
      {shouldShowDetails ? (
        <div className="ml-6 space-y-1 border-l border-gray-200 pb-2 pl-3 pt-1">
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
      ) : null}
    </div>
  );
}

const summarizeToolGroup = (tools: ToolTimelineItem[], approvals: PendingApproval[]): string => {
  if (tools.length === 0 && approvals.length > 0) {
    return approvals.length === 1 ? "Waiting for approval" : `Waiting for ${approvals.length} approvals`;
  }

  const activeTool = tools.find((tool) => tool.phase === "streaming" || tool.status === "running");
  if (activeTool) {
    return activeToolLabel(activeTool);
  }

  const counts = {
    read: 0,
    search: 0,
    edit: 0,
    command: 0,
    mcp: 0,
    trace: 0,
    other: 0,
  };

  for (const tool of tools) {
    if (tool.toolName === "read" || tool.toolName === "list_project_resources") {
      counts.read += 1;
    } else if (tool.toolName === "search") {
      counts.search += 1;
    } else if (tool.toolName === "edit") {
      counts.edit += 1;
    } else if (tool.toolName === "bash") {
      counts.command += 1;
    } else if (tool.toolName === "trace_retrieve") {
      counts.trace += 1;
    } else if (tool.toolName === "mcp_registry" || tool.toolName.startsWith("mcp__")) {
      counts.mcp += 1;
    } else {
      counts.other += 1;
    }
  }

  const parts = [
    phrase(counts.read, "explored", "file"),
    phrase(counts.search, "ran", "search", "searches"),
    phrase(counts.edit, "edited", "file"),
    phrase(counts.command, "ran", "command"),
    phrase(counts.trace, "retrieved", "trace"),
    phrase(counts.mcp, "used", "MCP tool"),
    phrase(counts.other, "ran", "tool"),
  ].filter(Boolean);

  if (approvals.some((approval) => approval.status === "pending")) {
    parts.push("waiting for approval");
  }

  return parts.length > 0 ? sentenceCase(parts.join(", ")) : "Ran tools";
};

const activeToolLabel = (tool: ToolTimelineItem): string => {
  const target = tool.pathPreview ? tool.pathPreview.split(/[\\/]/).pop() ?? tool.pathPreview : undefined;
  switch (tool.toolName) {
    case "edit":
      return target ? `Editing ${target}` : "Editing file";
    case "apply_patch":
      return target ? `Patching ${target}` : "Applying patch";
    case "bash":
      return "Running command";
    case "read":
      return target ? `Reading ${target}` : "Reading file";
    case "search":
      return "Searching";
    case "trace_retrieve":
      return "Retrieving trace evidence";
    case "list_project_resources":
      return "Listing resources";
    default:
      return `Working on ${tool.displayName}`;
  }
};

const phrase = (count: number, verb: string, singular: string, plural = `${singular}s`): string | null =>
  count > 0 ? `${verb} ${count} ${count === 1 ? singular : plural}` : null;

const sentenceCase = (value: string): string => value.slice(0, 1).toUpperCase() + value.slice(1);

const findApprovalForTool = (tool: ToolTimelineItem, approvals: PendingApproval[]): PendingApproval | undefined => {
  const liveApproval = approvals.find((approval) => approval.toolCallId === tool.toolCallId);
  if (liveApproval) {
    return liveApproval;
  }
  return tool.approval ? { ...tool.approval, toolCallId: tool.toolCallId } : undefined;
};
