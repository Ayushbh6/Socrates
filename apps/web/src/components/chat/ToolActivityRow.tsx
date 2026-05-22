import { ChevronDown, CircleAlert, Clock3, FileText, Pencil, Search, SquareTerminal, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { ToolDetails } from "./ToolDetails";
import type { PendingApproval, ToolTimelineItem } from "./ToolTimelineTypes";

interface ToolActivityRowProps {
  tool: ToolTimelineItem;
  approval?: PendingApproval;
  onApprovalDecision?: (approvalId: string, decision: "approved" | "rejected") => void;
}

export function ToolActivityRow({ tool, approval, onApprovalDecision }: ToolActivityRowProps) {
  const [isOpen, setIsOpen] = useState(false);
  const Icon = iconForTool(tool);
  const summary = useMemo(() => summarizeTool(tool), [tool]);
  const statusTone = statusClass(tool.status);

  return (
    <div className="group/tool">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm text-brand-text-light hover:bg-gray-50"
        onClick={() => setIsOpen((current) => !current)}
      >
        <Icon className={`size-4 shrink-0 ${tool.status === "running" ? "animate-pulse text-brand-teal-dark" : statusTone.icon}`} />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-brand-text-dark">{summary}</span>
          {tool.durationMs !== undefined && <span className="ml-2 text-xs text-brand-text-light">{formatDuration(tool.durationMs)}</span>}
        </span>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${statusTone.badge}`}>
          {tool.status.replaceAll("_", " ")}
        </span>
        <ChevronDown className={`size-3 shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>
      {isOpen && (
        <div className="ml-6 border-l border-gray-200 pb-2 pl-3 pt-1">
          <ToolDetails tool={tool} />
        </div>
      )}
      {approval && (
        <div className="ml-6 pb-2">
          <ApprovalPrompt approval={approval} onApprovalDecision={onApprovalDecision} />
        </div>
      )}
    </div>
  );
}

function iconForTool(tool: ToolTimelineItem) {
  if (tool.status === "failed" || tool.status === "rejected") {
    return CircleAlert;
  }
  if (tool.status === "awaiting_approval") {
    return Clock3;
  }
  switch (tool.toolName) {
    case "read":
    case "list_project_resources":
      return FileText;
    case "search":
      return Search;
    case "edit":
      return Pencil;
    case "bash":
      return SquareTerminal;
    case "trace_retrieve":
      return Workflow;
    default:
      return Workflow;
  }
}

function summarizeTool(tool: ToolTimelineItem): string {
  if (tool.summary) {
    return tool.summary;
  }
  if (tool.toolName === "bash") {
    const command = tool.shell?.command ?? inputString(tool, "command") ?? tool.argsPreview ?? "command";
    return `Ran ${truncateInline(command, 80)}`;
  }
  if (tool.toolName === "read") {
    return `Read ${inputString(tool, "path") ?? "file"}`;
  }
  if (tool.toolName === "search") {
    return `Searched ${inputString(tool, "query") ?? "workspace"}`;
  }
  if (tool.toolName === "edit") {
    return "Edited files";
  }
  if (tool.toolName === "trace_retrieve") {
    return "Retrieved prior tool traces";
  }
  if (tool.toolName === "list_project_resources") {
    return "Listed project resources";
  }
  return tool.displayName;
}

function inputString(tool: ToolTimelineItem, key: string): string | undefined {
  if (typeof tool.arguments !== "object" || tool.arguments === null) {
    return undefined;
  }
  const value = (tool.arguments as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function statusClass(status: ToolTimelineItem["status"]) {
  if (status === "failed" || status === "rejected") {
    return { icon: "text-red-600", badge: "bg-red-50 text-red-700" };
  }
  if (status === "awaiting_approval") {
    return { icon: "text-amber-600", badge: "bg-amber-50 text-amber-700" };
  }
  if (status === "running") {
    return { icon: "text-brand-teal-dark", badge: "bg-teal-50 text-brand-teal-dark" };
  }
  return { icon: "text-brand-text-light", badge: "bg-gray-100 text-brand-text-light" };
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function truncateInline(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}
