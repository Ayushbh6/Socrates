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
  approval?: ConversationToolApproval;
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
      return "Bash";
    case "trace_retrieve":
      return "Trace";
    case "list_project_resources":
      return "Resources";
    default:
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
    default:
      return "other";
  }
};
