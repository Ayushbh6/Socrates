import type { ConversationToolApproval, ConversationToolRun } from "@socrates/contracts";

export type ToolTimelineStatus = ConversationToolRun["status"];

export type PendingApproval = ConversationToolApproval & {
  toolCallId?: string;
};

export type ToolTimelineItem = Omit<ConversationToolRun, "approval"> & {
  displayName: string;
  category: string;
  status: ToolTimelineStatus;
  argsPreview?: string;
  output: string;
  stdout?: string;
  stderr?: string;
  error?: string;
  modelCallId?: string;
  stepIndex?: number;
  approval?: ConversationToolApproval;
  // Set while the model is still streaming this tool call's arguments (pre-approval/pre-run).
  phase?: "streaming";
  pathPreview?: string;
};

export const toolRunToTimelineItem = (run: ConversationToolRun): ToolTimelineItem => ({
  ...run,
  displayName: displayNameForTool(run.toolName),
  category: categoryForTool(run.toolName),
  output: run.shell ? [run.shell.stdout, run.shell.stderr].filter(Boolean).join("\n") : run.resultPreview ?? "",
  stdout: run.shell?.stdout,
  stderr: run.shell?.stderr,
});

export const displayNameForTool = (toolName: string): string => {
  switch (toolName) {
    case "read":
      return "Read";
    case "search":
      return "Search";
    case "edit":
      return "Edit";
    case "bash":
      return "Terminal";
    case "trace_retrieve":
      return "Trace";
    case "list_project_resources":
      return "Resources";
    case "mcp_registry":
      return "MCP Registry";
    default:
      if (toolName.startsWith("mcp__")) {
        return toolName.replace(/^mcp__/, "MCP ");
      }
      return toolName;
  }
};

export const categoryForTool = (toolName: string): string => {
  switch (toolName) {
    case "read":
    case "list_project_resources":
      return "file";
    case "search":
      return "search";
    case "edit":
      return "patch";
    case "bash":
      return "shell";
    case "trace_retrieve":
      return "trace";
    case "mcp_registry":
      return "mcp";
    default:
      if (toolName.startsWith("mcp__")) {
        return "mcp";
      }
      return "other";
  }
};
