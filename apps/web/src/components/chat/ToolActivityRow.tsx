import { ChevronDown, CircleAlert, Clock3, FileText, Pencil, Search, SquareTerminal, Workflow } from "lucide-react";
import { useMemo, useState } from "react";
import { ApprovalPrompt } from "./ApprovalPrompt";
import { CredentialPrompt } from "./CredentialPrompt";
import { ToolDetails } from "./ToolDetails";
import type { PendingApproval, PendingCredentialInput, ToolTimelineItem } from "./ToolTimelineTypes";
import { summarizeEditTool } from "./editPresentation";

interface ToolActivityRowProps {
  tool: ToolTimelineItem;
  approval?: PendingApproval;
  credentialRequest?: PendingCredentialInput;
  onApprovalDecision?: (approvalId: string, decision: "approved" | "rejected") => void;
  onCredentialInput?: (request: PendingCredentialInput, decision: "submitted" | "cancelled", value?: string) => void;
}

export function ToolActivityRow({ tool, approval, credentialRequest, onApprovalDecision, onCredentialInput }: ToolActivityRowProps) {
  const isStreaming = tool.phase === "streaming";
  // Auto-reveal command output: terminal rows expand once they have output, and any
  // actively running/awaiting row stays open so the user is never staring at a blank wait.
  const autoOpen =
    (tool.toolName === "bash" && Boolean(tool.stdout || tool.stderr || tool.output)) ||
    tool.status === "awaiting_approval" || credentialRequest?.status === "pending";
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const isOpen = manualOpen ?? autoOpen;
  const summary = useMemo(() => summarizeTool(tool), [tool]);
  const statusTone = statusClass(tool.status);
  const isActive = isStreaming || tool.status === "running";

  return (
    <div className="group/tool">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm text-brand-text-light hover:bg-gray-50"
        onClick={() => setManualOpen((current) => !(current ?? autoOpen))}
      >
        <ToolIcon tool={tool} className={`size-4 shrink-0 ${isActive ? "animate-pulse text-brand-teal-dark" : statusTone.icon}`} />
        <span className="min-w-0 flex-1 truncate">
          <span className={isStreaming ? "text-brand-text-dark" : "text-brand-text-dark"}>{summary}</span>
          {isActive ? <span className="ml-1 text-brand-teal-dark">{isStreaming ? "…" : ""}</span> : null}
          {tool.durationMs !== undefined && <span className="ml-2 text-xs text-brand-text-light">{formatDuration(tool.durationMs)}</span>}
        </span>
        {isActive ? (
          <ActivityDot />
        ) : (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${statusTone.badge}`}>
            {tool.status.replaceAll("_", " ")}
          </span>
        )}
        <ChevronDown className={`size-3 shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>
      {isOpen && !isStreaming && (
        <div className="ml-6 border-l border-gray-200 pb-2 pl-3 pt-1">
          <ToolDetails tool={tool} />
        </div>
      )}
      {approval && (
        <div className="ml-6 pb-2">
          <ApprovalPrompt approval={approval} onApprovalDecision={onApprovalDecision} />
        </div>
      )}
      {credentialRequest && (
        <div className="ml-6 pb-2">
          <CredentialPrompt request={credentialRequest} onSubmit={onCredentialInput} />
        </div>
      )}
    </div>
  );
}

function ActivityDot() {
  return (
    <span className="relative flex size-2 shrink-0" aria-hidden>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-teal-dark opacity-30" />
      <span className="relative inline-flex size-2 rounded-full bg-brand-teal-dark" />
    </span>
  );
}

function ToolIcon({ tool, className }: { tool: ToolTimelineItem; className: string }) {
  if (tool.status === "failed" || tool.status === "rejected") {
    return <CircleAlert className={className} />;
  }
  if (tool.status === "cancelled") {
    return <CircleAlert className={className} />;
  }
  if (tool.status === "awaiting_approval") {
    return <Clock3 className={className} />;
  }
  switch (tool.toolName) {
    case "read":
    case "list_project_resources":
      return <FileText className={className} />;
    case "search":
      return <Search className={className} />;
    case "edit":
      return <Pencil className={className} />;
    case "bash":
      return <SquareTerminal className={className} />;
    case "trace_retrieve":
      return <Workflow className={className} />;
    default:
      return <Workflow className={className} />;
  }
}

function summarizeTool(tool: ToolTimelineItem): string {
  if (tool.phase === "streaming") {
    const target = tool.pathPreview ? basename(tool.pathPreview) : undefined;
    switch (tool.toolName) {
      case "edit":
        return target ? `Editing ${target}` : "Editing file";
      case "apply_patch":
        return target ? `Patching ${target}` : "Preparing patch";
      case "bash":
        return tool.argsPreview ? `Running ${truncateInline(tool.argsPreview, 60)}` : "Preparing command";
      case "read":
        return target ? `Reading ${target}` : "Reading file";
      case "search":
        return tool.argsPreview ? `Searching ${truncateInline(tool.argsPreview, 60)}` : "Searching";
      default:
        return `Preparing ${tool.displayName}`;
    }
  }
  if (tool.toolName === "edit") {
    return summarizeEditTool(tool);
  }
  if (tool.summary) {
    return tool.summary;
  }
  if (tool.toolName === "bash") {
    const command = tool.shell?.command ?? inputString(tool, "command") ?? tool.argsPreview ?? "command";
    return `Terminal ${truncateInline(command, 80)}`;
  }
  if (tool.toolName === "read") {
    return `Read ${inputString(tool, "path") ?? "file"}`;
  }
  if (tool.toolName === "search") {
    return `Searched ${inputString(tool, "query") ?? "workspace"}`;
  }
  if (tool.toolName === "trace_retrieve") {
    return "Retrieved prior trace evidence";
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
  if (status === "cancelled") {
    return { icon: "text-gray-500", badge: "bg-gray-100 text-gray-600" };
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

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
