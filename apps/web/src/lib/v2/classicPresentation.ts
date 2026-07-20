import type {
  ConversationTerminal,
  ConversationToolApproval,
  ConversationToolRun,
  Message,
  V2Approval,
  V2CredentialInputRequest,
  V2Message,
  V2Terminal,
  V2ToolCall,
} from "@socrates/contracts";
import type { PendingApproval, PendingCredentialInput } from "@/components/chat/ToolTimelineTypes";
import type { V2TerminalOutputChunk } from "./flowState";

const stringifyPreview = (value: unknown, maxLength = 4_000): string => {
  if (typeof value === "string") return value.slice(0, maxLength);
  try {
    const serialized = JSON.stringify(value, null, 2);
    return (serialized || "").slice(0, maxLength);
  } catch {
    return "";
  }
};

const approvalKind = (value: string): ConversationToolApproval["actionKind"] => {
  const supported: ConversationToolApproval["actionKind"][] = [
    "shell_command",
    "file_write",
    "patch_apply",
    "git_commit",
    "git_push",
    "other",
  ];
  return supported.includes(value as ConversationToolApproval["actionKind"])
    ? value as ConversationToolApproval["actionKind"]
    : "other";
};

export const flowMessageToClassicMessage = (message: V2Message): Message => ({
  id: message.id,
  conversationId: message.flowId,
  sessionId: message.flowId,
  ...(message.turnId ? { turnId: message.turnId } : {}),
  role: message.role,
  content: message.content,
  ...(message.reasoning ? { reasoning: message.reasoning } : {}),
  ...(message.status === "cancelled" ? { cancelled: true } : {}),
  attachments: message.attachments?.map((attachment) => ({
    id: attachment.id,
    projectId: attachment.projectId,
    conversationId: attachment.flowId,
    sessionId: attachment.flowId,
    ...(attachment.turnId ? { turnId: attachment.turnId } : {}),
    ...(attachment.messageId ? { messageId: attachment.messageId } : {}),
    artifactId: attachment.artifactId,
    kind: attachment.kind === "audio" ? "text" : attachment.kind,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    uri: attachment.uri,
    ...(attachment.url ? { url: attachment.url } : {}),
    status: attachment.status,
    createdAt: attachment.createdAt,
  })),
  status: message.status,
  createdAt: message.createdAt,
});

export const flowApprovalToClassicApproval = (approval: V2Approval): PendingApproval => ({
  approvalId: approval.id,
  ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
  status: approval.status === "cancelled" || approval.status === "expired" ? "rejected" : approval.status,
  actionKind: approvalKind(approval.actionKind),
  title: approval.actionKind.replaceAll("_", " "),
  ...(approval.reason ? { description: approval.reason } : {}),
  actionPreview: stringifyPreview(approval.action),
  ...(approval.decision ? { decision: approval.decision } : {}),
});

export const flowToolToClassicToolRun = (
  tool: V2ToolCall,
  approval?: V2Approval,
): ConversationToolRun => {
  const classicApproval = approval ? {
    ...flowApprovalToClassicApproval(approval),
    ...(approval.status === "pending" && tool.status !== "awaiting_approval"
      ? { status: "approved" as const, decision: "approved" as const }
      : {}),
  } : undefined;
  const startedAt = tool.startedAt;
  const completedAt = tool.completedAt;
  const durationMs = startedAt && completedAt
    ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt))
    : undefined;
  const status = approval?.status === "rejected"
    ? "rejected"
    : tool.status === "pending" ? "running" : tool.status;
  return {
    toolCallId: tool.id,
    conversationId: tool.flowId,
    sessionId: tool.flowId,
    turnId: tool.turnId,
    toolName: tool.toolName,
    ...(tool.modelCallId ? { modelCallId: tool.modelCallId } : {}),
    status,
    requiresApproval: tool.requiresApproval,
    arguments: tool.arguments,
    ...(tool.result !== undefined ? { result: tool.result } : {}),
    ...(tool.errorId ? { errorId: tool.errorId } : {}),
    ...(classicApproval ? { approval: classicApproval } : {}),
    ...(stringifyPreview(tool.arguments, 240) ? { summary: stringifyPreview(tool.arguments, 240) } : {}),
    ...(tool.result !== undefined && stringifyPreview(tool.result, 2_000)
      ? { resultPreview: stringifyPreview(tool.result, 2_000) }
      : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
};

export const flowCredentialToClassicCredential = (
  request: V2CredentialInputRequest,
): PendingCredentialInput => ({
  credentialRequestId: request.id,
  toolCallId: request.toolCallId,
  ...(request.providerToolCallId ? { providerToolCallId: request.providerToolCallId } : {}),
  serverId: request.serverId,
  ...(request.serverLabel ? { serverLabel: request.serverLabel } : {}),
  envKey: request.envKey,
  source: request.source,
  turnId: request.turnId,
  status: request.status === "expired" ? "cancelled" : request.status,
});

export const flowTerminalToClassicTerminal = (
  terminal: V2Terminal,
  outputChunks: V2TerminalOutputChunk[],
  workspacePath: string,
): ConversationTerminal => {
  const stdout = outputChunks
    .filter((chunk) => chunk.stream === "stdout" || chunk.stream === "log" || chunk.stream === "result")
    .map((chunk) => chunk.text)
    .join("");
  const stderr = outputChunks.filter((chunk) => chunk.stream === "stderr").map((chunk) => chunk.text).join("");
  const pty = outputChunks.map((chunk) => {
    if (chunk.stream !== "input") return chunk.text;
    return chunk.redacted ? "[input hidden]\n" : chunk.text;
  }).join("");
  const nextOutputSequence = outputChunks.reduce((maximum, chunk) => Math.max(maximum, chunk.sequence + 1), 0);
  return {
    terminalId: terminal.id,
    projectId: terminal.projectId,
    conversationId: terminal.flowId,
    name: terminal.name,
    command: terminal.command,
    cwd: terminal.cwd,
    workspacePath,
    status: terminal.status,
    ...(terminal.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
    autoDetached: terminal.status === "detached",
    awaitingInput: terminal.awaitingInput,
    stateVersion: terminal.stateVersion,
    startedAt: terminal.startedAt,
    updatedAt: terminal.updatedAt,
    ...(terminal.completedAt ? { completedAt: terminal.completedAt } : {}),
    output: {
      stdout,
      stderr,
      ...(pty ? { pty } : {}),
      nextOutputSequence,
    },
  };
};
