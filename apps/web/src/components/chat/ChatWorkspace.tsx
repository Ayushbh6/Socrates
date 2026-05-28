"use client";

import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClientCommand, Conversation, ConversationTerminal, GetConversationResponse, Message, MessageAttachment, ModelOption, ModelThinkingOption, ServerEvent } from "@socrates/contracts";
import { api } from "@/lib/api";
import { useSocratesSocket } from "@/hooks/useSocratesSocket";
import { ChatComposer } from "./ChatComposer";
import { ChatTranscript, type LiveActivityStep } from "./ChatTranscript";
import { EmptyChatState } from "./EmptyChatState";
import { ProjectChatSidebar, type SidebarProject } from "./ProjectChatSidebar";
import { TerminalPanel } from "./TerminalPanel";
import { type PendingApproval, type ToolTimelineItem } from "./ToolTimelineTypes";

interface ChatWorkspaceProps {
  projectId: string;
  conversationId: string;
}

export function ChatWorkspace({ projectId, conversationId }: ChatWorkspaceProps) {
  const router = useRouter();
  const [conversationData, setConversationData] = useState<GetConversationResponse | null>(null);
  const [sidebarProjects, setSidebarProjects] = useState<SidebarProject[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState<ModelOption | null>(null);
  const [selectedThinkingOption, setSelectedThinkingOption] = useState<ModelThinkingOption | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<LiveActivityStep[]>([]);
  const [terminals, setTerminals] = useState<ConversationTerminal[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isTerminalPanelCollapsed, setIsTerminalPanelCollapsed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const replaceConversationInSidebar = useCallback((conversation: Conversation) => {
    setSidebarProjects((current) =>
      current.map((item) =>
        item.project.id === conversation.projectId
          ? {
              ...item,
              conversations: item.conversations.map((existing) =>
                existing.id === conversation.id ? conversation : existing,
              ),
            }
          : item,
      ),
    );
  }, []);

  const refreshConversation = useCallback(async () => {
    const conversation = await api.getConversation(projectId, conversationId);
    setConversationData(conversation);
    setTerminals(conversation.terminals ?? []);
    replaceConversationInSidebar(conversation.conversation);
  }, [projectId, conversationId, replaceConversationInSidebar]);

  const handleSocketEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === "connection.ready") {
        setError(null);
        return;
      }
      if (event.conversationId && event.conversationId !== conversationId) {
        return;
      }

      if (event.type === "turn.started") {
        setActiveTurnId(event.payload.turnId);
        setIsSending(true);
        setIsCompacting(false);
        setLiveSteps([]);
        setApprovals([]);
        setConversationData((current) => {
          const messages = current?.messages ?? [];
          const withoutDuplicate = messages.filter((message) => message.id !== event.payload.userMessage.id);
          return current
            ? { ...current, messages: [...withoutDuplicate, event.payload.userMessage] }
            : {
                conversation: {
                  id: conversationId,
                  projectId,
                  title: "New conversation",
                  status: "active",
                  updatedAt: event.timestamp,
                },
                messages: [event.payload.userMessage],
                toolRuns: [],
                terminals: [],
                tokenUsage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
              };
        });
        return;
      }

      if (event.type === "context.usage.snapshot") {
        setConversationData((current) => (current ? { ...current, contextUsage: event.payload } : current));
        return;
      }

      if (event.type === "agent.thinking.delta") {
        setLiveSteps((current) =>
          updateLiveStep(current, event.payload.modelCallId, event.payload.stepIndex, (step) => ({
            ...step,
            reasoning: `${step.reasoning}${event.payload.text}`,
          })),
        );
        return;
      }

      if (event.type === "agent.answer.delta") {
        setLiveSteps((current) =>
          updateLiveStep(current, event.payload.modelCallId, event.payload.stepIndex, (step) => ({
            ...step,
            answer: `${step.answer}${event.payload.text}`,
          })),
        );
        return;
      }

      if (event.type === "context.compaction.started") {
        if (event.payload.reason !== "precompute") {
          setIsCompacting(true);
        }
        return;
      }

      if (event.type === "context.compaction.completed") {
        setIsCompacting(false);
        return;
      }

      if (event.type === "context.compaction.failed") {
        setIsCompacting(false);
        setError(event.payload.error.message);
        return;
      }

      if (event.type === "message.completed") {
        setConversationData((current) => {
          if (!current) {
            return current;
          }
          const withoutDuplicate = current.messages.filter((message) => message.id !== event.payload.message.id);
          return { ...current, messages: [...withoutDuplicate, event.payload.message] };
        });
        setLiveSteps([]);
        setIsCompacting(false);
        return;
      }

      if (
        event.type === "terminal.started" ||
        event.type === "terminal.status" ||
        event.type === "terminal.completed" ||
        event.type === "terminal.stopped" ||
        event.type === "terminal.stale" ||
        event.type === "terminal.input.requested"
      ) {
        setTerminals((current) => upsertTerminal(current, terminalEventToConversationTerminal(event)));
        return;
      }

      if (event.type === "terminal.output") {
        setTerminals((current) =>
          current.map((terminal) => (terminal.terminalId === event.payload.terminalId ? appendTerminalOutput(terminal, event) : terminal)),
        );
        return;
      }

      if (event.type === "tool.call.started") {
        setLiveSteps((current) =>
          updateLiveStep(current, event.payload.modelCallId, event.payload.stepIndex, (step) => ({
            ...step,
            tools: [
              ...step.tools.filter((tool) => tool.toolCallId !== event.payload.toolCallId),
              {
            toolCallId: event.payload.toolCallId,
            conversationId,
            sessionId: event.sessionId ?? "live",
            turnId: event.turnId ?? activeTurnId ?? "live",
            toolName: event.payload.toolName,
            displayName: event.payload.displayName,
            category: event.payload.category,
            status: event.payload.requiresApproval ? "awaiting_approval" : "running",
            requiresApproval: event.payload.requiresApproval,
            argsPreview: event.payload.argsPreview,
            modelCallId: event.payload.modelCallId,
            stepIndex: event.payload.stepIndex,
            output: "",
          },
            ],
          })),
        );
        return;
      }

      if (event.type === "tool.call.output") {
        setLiveSteps((current) =>
          updateLiveTool(current, event.payload.toolCallId, (tool) =>
            appendToolOutput(tool, event.payload.stream, event.payload.text ?? ""),
          ),
        );
        return;
      }

      if (event.type === "tool.call.completed") {
        setLiveSteps((current) =>
          updateLiveTool(current, event.payload.toolCallId, (tool) => ({
                  ...tool,
                  status: "completed",
                  summary: event.payload.summary,
                  resultPreview: event.payload.resultPreview,
                  durationMs: event.payload.durationMs,
                })),
        );
        return;
      }

      if (event.type === "tool.call.failed") {
        setLiveSteps((current) =>
          updateLiveTool(current, event.payload.toolCallId, (tool) => ({
            ...tool,
            status: "failed",
            error: event.payload.error.message,
          })),
        );
        return;
      }

      if (event.type === "approval.requested") {
        setApprovals((current) => [
          ...current.filter((approval) => approval.approvalId !== event.payload.approvalId),
          { ...event.payload, status: "pending" },
        ]);
        return;
      }

      if (event.type === "approval.resolved") {
        setApprovals((current) =>
          current.map((approval) =>
            approval.approvalId === event.payload.approvalId ? { ...approval, status: event.payload.decision } : approval,
          ),
        );
        if (event.payload.toolCallId) {
          const toolCallId = event.payload.toolCallId;
          setLiveSteps((current) =>
            updateLiveTool(current, toolCallId, (tool) => ({
              ...tool,
              status: event.payload.decision === "approved" ? "running" : "rejected",
            })),
          );
        }
        return;
      }

      if (event.type === "turn.completed") {
        setIsSending(false);
        setActiveTurnId(null);
        setLiveSteps([]);
        setApprovals([]);
        setIsCompacting(false);
        void refreshConversation();
        return;
      }

      if (event.type === "turn.cancelled") {
        const partialAssistantMessage = event.payload.partialAssistantMessage;
        setConversationData((current) => {
          if (!current) {
            return current;
          }
          const nextPartialTurns = (current.partialTurns ?? []).map((turn) =>
            turn.turnId === event.payload.turnId ? { ...turn, status: "cancelled" as const } : turn,
          );
          if (!partialAssistantMessage) {
            return { ...current, partialTurns: nextPartialTurns };
          }
          const withoutDuplicate = current.messages.filter((message) => message.id !== partialAssistantMessage.id);
          return { ...current, messages: [...withoutDuplicate, partialAssistantMessage], partialTurns: nextPartialTurns };
        });
        setIsSending(false);
        setActiveTurnId(null);
        setLiveSteps([]);
        setApprovals([]);
        setIsCompacting(false);
        return;
      }

      if (event.type === "turn.failed" || event.type === "error.created") {
        setIsSending(false);
        setActiveTurnId(null);
        setIsCompacting(false);
        setError(event.type === "turn.failed" ? event.payload.error.message : event.payload.error.message);
        if (event.type === "turn.failed") {
          setLiveSteps([]);
          setApprovals([]);
          void refreshConversation();
        }
      }
    },
    [activeTurnId, conversationId, projectId, refreshConversation],
  );

  const { isConnected, sendCommand } = useSocratesSocket({
    onEvent: handleSocketEvent,
    onError: setError,
  });

  useEffect(() => {
    let isMounted = true;

    async function loadChat() {
      setIsLoading(true);
      setError(null);
      try {
        const [conversation, projectsResponse, modelsResponse] = await Promise.all([
          api.getConversation(projectId, conversationId),
          api.listProjects(),
          api.listModels(),
        ]);
        const projectConversations = await Promise.all(
          projectsResponse.projects.map(async ({ project }) => ({
            project,
            conversations: (await api.listProjectConversations(project.id)).conversations,
          })),
        );

        if (isMounted) {
          setConversationData(conversation);
          setTerminals(conversation.terminals ?? []);
          const reloadActiveTurn = conversation.partialTurns?.find((turn) => turn.status === "running")?.turnId ?? null;
          setActiveTurnId(reloadActiveTurn);
          setIsSending(Boolean(reloadActiveTurn));
          setLiveSteps([]);
          setApprovals([]);
          setIsCompacting(false);
          setSidebarProjects(projectConversations);
          setModels(modelsResponse.models);
          const defaultModel =
            modelsResponse.models.find(
              (model) =>
                model.providerId === modelsResponse.defaultModel.providerId &&
                model.modelId === modelsResponse.defaultModel.modelId,
            ) ?? modelsResponse.models[0] ?? null;
          setSelectedModel(defaultModel);
          setSelectedThinkingOption(
            defaultModel?.thinkingOptions.find((option) => option.id === modelsResponse.defaultModel.thinkingOptionId) ??
              defaultModel?.thinkingOptions.find((option) => option.id === defaultModel.defaultThinkingOptionId) ??
              defaultModel?.thinkingOptions[0] ??
              null,
          );
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Could not load conversation.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadChat();

    return () => {
      isMounted = false;
    };
  }, [projectId, conversationId]);

  useEffect(() => {
    if (terminals.some((terminal) => terminal.awaitingInput || terminal.status === "awaiting_input")) {
      setIsTerminalPanelCollapsed(false);
    }
  }, [terminals]);

  const handleModelChange = (model: ModelOption) => {
    setSelectedModel(model);
    setSelectedThinkingOption(
      model.thinkingOptions.find((option) => option.id === model.defaultThinkingOptionId) ?? model.thinkingOptions[0] ?? null,
    );
  };

  const handleThinkingChange = (option: ModelThinkingOption) => {
    setSelectedThinkingOption(option);
  };

  const handleStartChat = async (targetProjectId: string) => {
    const response = await api.createConversation(targetProjectId, {});
    setSidebarProjects((current) =>
      current.map((item) =>
        item.project.id === targetProjectId
          ? {
              ...item,
              conversations: [response.conversation, ...item.conversations],
            }
          : item,
      ),
    );
    router.push(`/projects/${targetProjectId}/chats/${response.conversation.id}`);
  };

  const handleUploadAttachments = async (files: File[]): Promise<MessageAttachment[]> => {
    try {
      return (await api.uploadConversationAttachments(projectId, conversationId, files)).attachments;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload image.");
      throw err;
    }
  };

  const handleSend = async (content: string, attachments: MessageAttachment[]) => {
    if (!selectedModel || !selectedThinkingOption) {
      setError("Choose a model before sending.");
      return;
    }

    setIsSending(true);
    setError(null);
    setLiveSteps([]);
    setIsCompacting(false);
    const clientMessageId = `msg_${crypto.randomUUID()}`;
    try {
      const optimisticMessage: Message = {
        id: clientMessageId,
        conversationId,
        sessionId: "pending",
        role: "user",
        content,
        ...(attachments.length > 0 ? { attachments } : {}),
        status: "completed",
        createdAt: new Date().toISOString(),
      };
      setConversationData((current) =>
        current
          ? {
              ...current,
              messages: [...current.messages, optimisticMessage],
            }
          : {
              conversation: {
                id: conversationId,
                projectId,
                title: "New conversation",
                status: "active",
                updatedAt: new Date().toISOString(),
              },
              messages: [optimisticMessage],
              toolRuns: [],
              terminals: [],
              tokenUsage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
            },
      );

      const command: ClientCommand = {
        id: `cmd_${crypto.randomUUID()}`,
        type: "chat.message.send",
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        projectId,
        conversationId,
        actor: { type: "user" },
        payload: {
          clientMessageId,
          content,
          ...(attachments.length > 0 ? { attachmentIds: attachments.map((attachment) => attachment.id) } : {}),
          runtimeConfig: {
            providerId: selectedModel.providerId,
            modelId: selectedModel.modelId,
            thinkingEnabled: selectedThinkingOption.enabled,
            ...(selectedThinkingOption.effort ? { thinkingEffort: selectedThinkingOption.effort } : {}),
            approvalMode: "manual",
            sandboxMode: "workspace_write",
          },
        },
      };
      sendCommand(command);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send message.");
      setIsSending(false);
      throw err;
    }
  };

  const handleApprovalDecision = (approvalId: string, decision: "approved" | "rejected") => {
    const command: ClientCommand = {
      id: `cmd_${crypto.randomUUID()}`,
      type: "approval.decide",
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      projectId,
      conversationId,
      actor: { type: "user" },
      payload: {
        approvalId,
        decision,
      },
    };
    sendCommand(command);
  };

  const handleTerminalStop = (terminalId: string) => {
    const command: ClientCommand = {
      id: `cmd_${crypto.randomUUID()}`,
      type: "terminal.stop",
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      projectId,
      conversationId,
      actor: { type: "user" },
      payload: {
        terminalId,
        reason: "User stopped the terminal.",
      },
    };
    sendCommand(command);
  };

  const handleTerminalInput = (terminalId: string, text: string, submit = true) => {
    const command: ClientCommand = {
      id: `cmd_${crypto.randomUUID()}`,
      type: "terminal.input",
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      projectId,
      conversationId,
      actor: { type: "user" },
      payload: {
        terminalId,
        text,
        submit,
      },
    };
    sendCommand(command);
  };

  const handleStop = () => {
    if (!activeTurnId) {
      return;
    }

    const command: ClientCommand = {
      id: `cmd_${crypto.randomUUID()}`,
      type: "chat.turn.cancel",
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      projectId,
      conversationId,
      actor: { type: "user" },
      payload: {
        turnId: activeTurnId,
        reason: "User stopped the response.",
      },
    };
    sendCommand(command);
  };

  const messages: Message[] = conversationData?.messages ?? [];
  const toolRuns = conversationData?.toolRuns ?? [];
  const partialTurns = conversationData?.partialTurns ?? [];
  const conversationTitle = conversationData?.conversation.title ?? "New conversation";
  const contextUsage = conversationData?.contextUsage;
  const hasTerminals = terminals.length > 0;
  const activeTerminalCount = terminals.filter((terminal) => terminal.status === "running" || terminal.status === "awaiting_input").length;
  const awaitingTerminalInputCount = terminals.filter((terminal) => terminal.awaitingInput || terminal.status === "awaiting_input").length;
  const tokenLabel = useMemo(() => {
    if (contextUsage) {
      return `${contextUsage.contextUsedTokens.toLocaleString()} tokens`;
    }
    return null;
  }, [contextUsage]);

  return (
    <main className="flex h-screen bg-brand-bg">
      <ProjectChatSidebar
        projects={sidebarProjects}
        currentProjectId={projectId}
        currentConversationId={conversationId}
        isCollapsed={isSidebarCollapsed}
        onCollapse={() => setIsSidebarCollapsed(true)}
        onExpand={() => setIsSidebarCollapsed(false)}
        onStartChat={handleStartChat}
      />
      <section className="flex min-w-0 flex-1 flex-col bg-white">
        <header
          className={`flex h-14 shrink-0 items-center border-b border-gray-200 ${
            isSidebarCollapsed ? "pl-16 pr-6" : "px-6"
          }`}
        >
          <h1 className="truncate text-sm font-medium text-brand-text-dark">{conversationTitle}</h1>
          {tokenLabel ? <span className="ml-4 shrink-0 font-mono text-xs text-brand-text-light">{tokenLabel}</span> : null}
          {hasTerminals ? (
            <button
              type="button"
              className="ml-auto inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-brand-text-light shadow-sm hover:bg-gray-50 hover:text-brand-text-dark"
              title={isTerminalPanelCollapsed ? "Show terminal panel" : "Hide terminal panel"}
              aria-pressed={!isTerminalPanelCollapsed}
              onClick={() => setIsTerminalPanelCollapsed((current) => !current)}
            >
              {isTerminalPanelCollapsed ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
              <span className="hidden sm:inline">Terminal</span>
              {activeTerminalCount > 0 ? (
                <span className="rounded-full bg-teal-50 px-1.5 py-0.5 font-mono text-[10px] text-brand-teal-dark">
                  {activeTerminalCount}
                </span>
              ) : null}
              {awaitingTerminalInputCount > 0 ? <span className="size-2 rounded-full bg-amber-500" title="Terminal awaiting input" /> : null}
            </button>
          ) : null}
        </header>
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="flex min-h-0 flex-1 flex-col">
            {isLoading ? (
              <div className="flex flex-1 items-center justify-center text-sm text-brand-text-light">Loading conversation...</div>
            ) : error && !conversationData ? (
              <div className="flex flex-1 items-center justify-center px-6 text-sm text-red-600">{error}</div>
            ) : messages.length === 0 ? (
              <EmptyChatState
                error={error}
                isSending={isSending}
                isConnected={isConnected}
                models={models}
                selectedModel={selectedModel}
                selectedThinkingOption={selectedThinkingOption}
                warningResetKey={conversationId}
                onModelChange={handleModelChange}
                onThinkingChange={handleThinkingChange}
                onSend={handleSend}
                onUploadAttachments={handleUploadAttachments}
                onStop={handleStop}
              />
            ) : (
              <>
                <ChatTranscript
                  messages={messages}
                  toolRuns={toolRuns}
                  partialTurns={partialTurns}
                  activitySteps={conversationData?.activitySteps ?? []}
                  liveSteps={liveSteps}
                  approvals={approvals}
                  isStreaming={isSending}
                  isCompacting={isCompacting}
                  onApprovalDecision={handleApprovalDecision}
                />
                <div className="border-t border-gray-100 bg-white px-6 py-4">
                  <div className="mx-auto max-w-3xl">
                    {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
                    <ChatComposer
                      isSending={isSending}
                      isConnected={isConnected}
                      models={models}
                      selectedModel={selectedModel}
                      selectedThinkingOption={selectedThinkingOption}
                      warningResetKey={conversationId}
                      onModelChange={handleModelChange}
                      onThinkingChange={handleThinkingChange}
                      onSend={handleSend}
                      onUploadAttachments={handleUploadAttachments}
                      onStop={handleStop}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
          <TerminalPanel
            terminals={terminals}
            isCollapsed={isTerminalPanelCollapsed}
            onToggleCollapsed={() => setIsTerminalPanelCollapsed((current) => !current)}
            onStop={handleTerminalStop}
            onInput={handleTerminalInput}
          />
        </div>
      </section>
    </main>
  );
}

const appendToolOutput = (
  tool: ToolTimelineItem,
  stream: "stdout" | "stderr" | "log" | "result",
  text: string,
): ToolTimelineItem => {
  if (stream === "stdout") {
    return { ...tool, output: `${tool.output}${text}`, stdout: `${tool.stdout ?? ""}${text}` };
  }
  if (stream === "stderr") {
    return { ...tool, output: `${tool.output}${text}`, stderr: `${tool.stderr ?? ""}${text}` };
  }
  return { ...tool, output: `${tool.output}${text}` };
};

const updateLiveStep = (
  steps: LiveActivityStep[],
  modelCallId: string | undefined,
  stepIndex: number | undefined,
  updater: (step: LiveActivityStep) => LiveActivityStep,
): LiveActivityStep[] => {
  const key = modelCallId ?? `step-${stepIndex ?? steps.length}`;
  const existingIndex = steps.findIndex((step) => step.key === key);
  if (existingIndex >= 0) {
    return steps.map((step, index) => (index === existingIndex ? updater(step) : step));
  }
  return [
    ...steps,
    updater({
      key,
      ...(modelCallId ? { modelCallId } : {}),
      stepIndex: stepIndex ?? steps.length,
      reasoning: "",
      answer: "",
      tools: [],
    }),
  ];
};

const updateLiveTool = (
  steps: LiveActivityStep[],
  toolCallId: string,
  updater: (tool: ToolTimelineItem) => ToolTimelineItem,
): LiveActivityStep[] =>
  steps.map((step) => ({
    ...step,
    tools: step.tools.map((tool) => (tool.toolCallId === toolCallId ? updater(tool) : tool)),
  }));

const upsertTerminal = (terminals: ConversationTerminal[], terminal: ConversationTerminal): ConversationTerminal[] => {
  const existing = terminals.find((item) => item.terminalId === terminal.terminalId);
  const output =
    terminal.output.stdout || terminal.output.stderr
      ? terminal.output
      : existing?.output
        ? { ...existing.output, nextOutputSequence: terminal.output.nextOutputSequence }
        : terminal.output;
  return [{ ...existing, ...terminal, output }, ...terminals.filter((item) => item.terminalId !== terminal.terminalId)];
};

const terminalEventToConversationTerminal = (
  event: Extract<
    ServerEvent,
    {
      type:
        | "terminal.started"
        | "terminal.status"
        | "terminal.completed"
        | "terminal.stopped"
        | "terminal.stale"
        | "terminal.input.requested";
    }
  >,
): ConversationTerminal => ({
  terminalId: event.payload.terminalId,
  projectId: event.projectId ?? "",
  conversationId: event.conversationId ?? "",
  name: event.payload.name,
  command: event.payload.command,
  cwd: event.payload.cwd,
  workspacePath: event.payload.workspacePath,
  status: event.payload.status,
  ...(event.payload.platform ? { platform: event.payload.platform } : {}),
  ...(event.payload.shellKind ? { shellKind: event.payload.shellKind } : {}),
  ...(event.payload.shellExecutable ? { shellExecutable: event.payload.shellExecutable } : {}),
  ...(event.payload.processId ? { processId: event.payload.processId } : {}),
  ...(event.payload.exitCode === undefined ? {} : { exitCode: event.payload.exitCode }),
  ...(event.payload.signal === undefined ? {} : { signal: event.payload.signal }),
  autoDetached: event.payload.autoDetached,
  awaitingInput: event.payload.awaitingInput,
  ...(event.payload.lastPrompt ? { lastPrompt: event.payload.lastPrompt } : {}),
  startedAt: event.payload.startedAt,
  updatedAt: event.payload.updatedAt,
  ...(event.payload.completedAt ? { completedAt: event.payload.completedAt } : {}),
  output: {
    stdout: "",
    stderr: "",
    nextOutputSequence: event.payload.nextOutputSequence ?? 0,
  },
});

const appendTerminalOutput = (terminal: ConversationTerminal, event: Extract<ServerEvent, { type: "terminal.output" }>): ConversationTerminal => {
  const sequence = event.payload.sequence ?? terminal.output.nextOutputSequence;
  const nextOutput = { ...terminal.output, nextOutputSequence: sequence + 1 };
  if (event.payload.stream === "stdout") {
    nextOutput.stdout = trimTerminalOutput(`${nextOutput.stdout}${event.payload.text}`);
  } else if (event.payload.stream === "stderr") {
    nextOutput.stderr = trimTerminalOutput(`${nextOutput.stderr}${event.payload.text}`);
  }
  return {
    ...terminal,
    status: event.payload.status,
    awaitingInput: event.payload.awaitingInput,
    ...(event.payload.lastPrompt ? { lastPrompt: event.payload.lastPrompt } : {}),
    updatedAt: event.payload.updatedAt,
    output: nextOutput,
  };
};

const trimTerminalOutput = (value: string): string => (value.length > 16_000 ? value.slice(-16_000) : value);
