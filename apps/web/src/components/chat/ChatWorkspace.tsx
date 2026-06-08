"use client";

import { useRouter } from "next/navigation";
import { Bell, LayoutDashboard, Eye, EyeOff, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientCommand, Conversation, ConversationCostUsage, ConversationTerminal, GetConversationResponse, Message, MessageAttachment, ModelOption, ModelThinkingOption, Notification as SocratesNotification, ServerEvent, TurnUsageReport } from "@socrates/contracts";
import { api } from "@/lib/api";
import { useSocratesSocket } from "@/hooks/useSocratesSocket";
import { ChatComposer } from "./ChatComposer";
import { ChatTranscript, type LiveActivityStep } from "./ChatTranscript";
import { EmptyChatState } from "./EmptyChatState";
import { ProjectChatSidebar, type SidebarProject } from "./ProjectChatSidebar";
import { TerminalDockPanel, TerminalPanel } from "./TerminalPanel";
import { type PendingApproval, type ToolTimelineItem } from "./ToolTimelineTypes";

interface ChatWorkspaceProps {
  projectId: string;
  conversationId: string;
}

const DEFAULT_TERMINAL_PANEL_WIDTH = 420;
const MIN_TERMINAL_PANEL_WIDTH = 320;
const MAX_TERMINAL_PANEL_WIDTH = 720;
const DEFAULT_TERMINAL_DOCK_HEIGHT = 320;
const MIN_TERMINAL_DOCK_HEIGHT = 220;
const MAX_TERMINAL_DOCK_HEIGHT = 760;
const COLLAPSED_TERMINAL_PANEL_WIDTH = 48;
const MOBILE_TERMINAL_BREAKPOINT = 1024;

const TERMINAL_PANEL_WIDTH_KEY_PREFIX = "socrates-terminal-panel-width-v1";
const TERMINAL_PANEL_COLLAPSED_KEY_PREFIX = "socrates-terminal-panel-collapsed-v1";
const TERMINAL_DOCK_HEIGHT_KEY_PREFIX = "socrates-terminal-dock-height-v1";
const TERMINAL_DOCK_OPEN_KEY_PREFIX = "socrates-terminal-dock-open-v1";
const TERMINAL_DOCK_ACTIVE_KEY_PREFIX = "socrates-terminal-dock-active-v1";

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
  const [settledLiveTurns, setSettledLiveTurns] = useState<Record<string, LiveActivityStep[]>>({});
  const [anchorMessageId, setAnchorMessageId] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<ConversationTerminal[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isTerminalPanelCollapsed, setIsTerminalPanelCollapsed] = useState(false);
  const [terminalPanelWidth, setTerminalPanelWidth] = useState(DEFAULT_TERMINAL_PANEL_WIDTH);
  const [terminalDockHeight, setTerminalDockHeight] = useState(DEFAULT_TERMINAL_DOCK_HEIGHT);
  const [isTerminalDockOpen, setIsTerminalDockOpen] = useState(false);
  const [activeDockTerminalId, setActiveDockTerminalId] = useState<string | undefined>(undefined);
  const [isMobileView, setIsMobileView] = useState(false);
  const [notifications, setNotifications] = useState<SocratesNotification[]>([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [isNotificationCenterOpen, setIsNotificationCenterOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const liveStepsRef = useRef<LiveActivityStep[]>([]);
  const previousLiveTerminalCountRef = useRef(0);
  const previousAwaitingTerminalInputRef = useRef(false);

  const panelWidthKey = `${TERMINAL_PANEL_WIDTH_KEY_PREFIX}:${projectId}:${conversationId}`;
  const panelCollapsedKey = `${TERMINAL_PANEL_COLLAPSED_KEY_PREFIX}:${projectId}:${conversationId}`;
  const dockHeightKey = `${TERMINAL_DOCK_HEIGHT_KEY_PREFIX}:${projectId}:${conversationId}`;
  const dockOpenKey = `${TERMINAL_DOCK_OPEN_KEY_PREFIX}:${projectId}:${conversationId}`;
  const dockActiveKey = `${TERMINAL_DOCK_ACTIVE_KEY_PREFIX}:${projectId}:${conversationId}`;

  useEffect(() => {
    activeTurnIdRef.current = activeTurnId;
  }, [activeTurnId]);

  useEffect(() => {
    liveStepsRef.current = liveSteps;
  }, [liveSteps]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const media = window.matchMedia(`(max-width: ${MOBILE_TERMINAL_BREAKPOINT - 1}px)`);
    const updateMedia = () => setIsMobileView(media.matches);
    updateMedia();
    media.addEventListener("change", updateMedia);

    const storedPanelWidth = Number.parseInt(window.localStorage.getItem(panelWidthKey) ?? "", 10);
    if (Number.isFinite(storedPanelWidth)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTerminalPanelWidth(storedPanelWidth);
    }
    const storedPanelCollapsed = window.localStorage.getItem(panelCollapsedKey);
    if (storedPanelCollapsed === "true" || storedPanelCollapsed === "false") {
      setIsTerminalPanelCollapsed(storedPanelCollapsed === "true");
    }
    const storedDockHeight = Number.parseInt(window.localStorage.getItem(dockHeightKey) ?? "", 10);
    if (Number.isFinite(storedDockHeight)) {
      setTerminalDockHeight(storedDockHeight);
    }
    const storedDockOpen = window.localStorage.getItem(dockOpenKey);
    if (storedDockOpen === "true" || storedDockOpen === "false") {
      setIsTerminalDockOpen(storedDockOpen === "true");
    }
    const storedDockActive = window.localStorage.getItem(dockActiveKey);
    if (storedDockActive && storedDockActive.length > 0) {
      setActiveDockTerminalId(storedDockActive);
    }

    return () => media.removeEventListener("change", updateMedia);
  }, [conversationId, dockActiveKey, dockHeightKey, dockOpenKey, panelCollapsedKey, panelWidthKey, projectId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(panelWidthKey, String(terminalPanelWidth));
  }, [panelWidthKey, terminalPanelWidth]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(panelCollapsedKey, String(isTerminalPanelCollapsed));
  }, [isTerminalPanelCollapsed, panelCollapsedKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(dockHeightKey, String(terminalDockHeight));
  }, [dockHeightKey, terminalDockHeight]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(dockOpenKey, String(isTerminalDockOpen));
  }, [dockOpenKey, isTerminalDockOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (activeDockTerminalId) {
      window.localStorage.setItem(dockActiveKey, activeDockTerminalId);
      return;
    }
    window.localStorage.removeItem(dockActiveKey);
  }, [activeDockTerminalId, dockActiveKey]);

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
    return conversation;
  }, [projectId, conversationId, replaceConversationInSidebar]);

  const handleSocketEvent = useCallback(
    (event: ServerEvent) => {
      if (event.type === "connection.ready") {
        setError(null);
        return;
      }
      if (event.type === "notification.created") {
        setNotifications((current) => [event.payload.notification, ...current.filter((item) => item.id !== event.payload.notification.id)]);
        setUnreadNotificationCount((current) => current + (event.payload.notification.readAt ? 0 : 1));
        return;
      }
      if (event.type === "notification.read") {
        setNotifications((current) =>
          current.map((item) =>
            item.id === event.payload.notificationId ? { ...item, readAt: item.readAt ?? new Date().toISOString() } : item,
          ),
        );
        setUnreadNotificationCount(event.payload.unreadCount);
        return;
      }
      if (event.conversationId && event.conversationId !== conversationId) {
        return;
      }

      if (event.type === "conversation.updated") {
        setConversationData((current) => (current ? { ...current, conversation: event.payload.conversation } : current));
        replaceConversationInSidebar(event.payload.conversation);
        return;
      }

      if (event.type === "turn.started") {
        activeTurnIdRef.current = event.payload.turnId;
        liveStepsRef.current = [];
        setActiveTurnId(event.payload.turnId);
        setAnchorMessageId(event.payload.userMessage.id);
        setIsSending(true);
        setIsCompacting(false);
        setLiveSteps([]);
        setSettledLiveTurns((current) => removeSettledLiveTurn(current, event.payload.turnId));
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
                costUsage: emptyCostUsage(),
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
          updateLiveStep(current, event.turnId ?? activeTurnIdRef.current, event.payload.modelCallId, event.payload.stepIndex, (step) => ({
            ...step,
            reasoning: `${step.reasoning}${event.payload.text}`,
          })),
        );
        return;
      }

      if (event.type === "agent.answer.delta") {
        setLiveSteps((current) =>
          updateLiveStep(current, event.turnId ?? activeTurnIdRef.current, event.payload.modelCallId, event.payload.stepIndex, (step) => ({
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
        // Keep the live, step-based transcript visible until turn.completed refreshes
        // the hydrated activitySteps. Rendering the completed aggregate message here
        // creates a transient "all tools, then all text" layout.
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

      if (event.type === "terminal.data" || event.type === "terminal.output") {
        setTerminals((current) =>
          current.map((terminal) => (terminal.terminalId === event.payload.terminalId ? appendTerminalOutput(terminal, event) : terminal)),
        );
        return;
      }

      if (event.type === "tool.call.streaming") {
        setLiveSteps((current) =>
          updateLiveStep(current, event.turnId ?? activeTurnIdRef.current, event.payload.modelCallId, event.payload.stepIndex, (step) => {
            const existing = step.tools.find((tool) =>
              sameToolIdentity(tool, event.payload.toolCallId, event.payload.providerToolCallId),
            );
            if (existing) {
              return {
                ...step,
                tools: step.tools.map((tool) =>
                  sameToolIdentity(tool, event.payload.toolCallId, event.payload.providerToolCallId)
                    ? {
                        ...tool,
                        ...(tool.status === "running" ? { phase: "streaming" as const } : {}),
                        ...(event.payload.providerToolCallId ? { providerToolCallId: event.payload.providerToolCallId } : {}),
                        ...(event.payload.pathPreview ? { pathPreview: event.payload.pathPreview } : {}),
                        ...(event.payload.argsPreview ? { argsPreview: event.payload.argsPreview } : {}),
                      }
                    : tool,
                ),
              };
            }
            return {
              ...step,
              tools: [
                ...step.tools,
                {
                  toolCallId: event.payload.toolCallId,
                  ...(event.payload.providerToolCallId ? { providerToolCallId: event.payload.providerToolCallId } : {}),
                  conversationId,
                  sessionId: event.sessionId ?? "live",
                  turnId: event.turnId ?? activeTurnIdRef.current ?? "live",
                  toolName: event.payload.toolName,
                  displayName: event.payload.displayName,
                  category: event.payload.category,
                  status: "running",
                  requiresApproval: false,
                  phase: "streaming",
                  ...(event.payload.pathPreview ? { pathPreview: event.payload.pathPreview } : {}),
                  ...(event.payload.argsPreview ? { argsPreview: event.payload.argsPreview } : {}),
                  modelCallId: event.payload.modelCallId,
                  stepIndex: event.payload.stepIndex,
                  output: "",
                },
              ],
            };
          }),
        );
        return;
      }

      if (event.type === "tool.call.started") {
        setLiveSteps((current) =>
          updateLiveStep(current, event.turnId ?? activeTurnIdRef.current, event.payload.modelCallId, event.payload.stepIndex, (step) => ({
            ...step,
            tools: [
              ...step.tools.filter((tool) => !sameToolIdentity(tool, event.payload.toolCallId, event.payload.providerToolCallId)),
              {
                toolCallId: event.payload.toolCallId,
                ...(event.payload.providerToolCallId ? { providerToolCallId: event.payload.providerToolCallId } : {}),
                conversationId,
                sessionId: event.sessionId ?? "live",
                turnId: event.turnId ?? activeTurnIdRef.current ?? "live",
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
          updateLiveTool(current, event.payload.toolCallId, event.payload.providerToolCallId, (tool) =>
            appendToolOutput(tool, event.payload.stream, event.payload.text ?? ""),
          ),
        );
        return;
      }

      if (event.type === "tool.call.completed") {
        setLiveSteps((current) =>
          updateLiveTool(current, event.payload.toolCallId, event.payload.providerToolCallId, (tool) => ({
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
          updateLiveTool(current, event.payload.toolCallId, event.payload.providerToolCallId, (tool) => ({
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
            updateLiveTool(current, toolCallId, event.payload.providerToolCallId, (tool) => ({
              ...tool,
              status: event.payload.decision === "approved" ? "running" : "rejected",
            })),
          );
        }
        return;
      }

      if (event.type === "turn.completed") {
        const completedTurnId = event.payload.turnId;
        activeTurnIdRef.current = null;
        setIsSending(false);
        setActiveTurnId(null);
        setApprovals([]);
        setIsCompacting(false);
        if (event.payload.turnUsageReport) {
          setConversationData((current) => (current ? applyTurnUsageReport(current, event.payload.turnUsageReport as TurnUsageReport) : current));
        }
        void refreshConversation().finally(() => {
          setSettledLiveTurns((current) => removeSettledLiveTurn(current, completedTurnId));
          if (!activeTurnIdRef.current) {
            liveStepsRef.current = [];
            setLiveSteps([]);
          }
        });
        return;
      }

      if (event.type === "turn.cancelled") {
        const cancelledTurnId = event.payload.turnId;
        const liveSnapshot = liveStepsRef.current;
        activeTurnIdRef.current = null;
        if (liveSnapshot.some((step) => step.reasoning || step.answer || step.tools.length > 0)) {
          setSettledLiveTurns((current) => ({ ...current, [cancelledTurnId]: liveSnapshot }));
        }
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
        liveStepsRef.current = [];
        setLiveSteps([]);
        setApprovals([]);
        setIsCompacting(false);
        void refreshConversation().finally(() => {
          setSettledLiveTurns((current) => removeSettledLiveTurn(current, cancelledTurnId));
        });
        return;
      }

      if (event.type === "error.created") {
        setError(event.payload.error.message);
        return;
      }

      if (event.type === "turn.failed") {
        setIsSending(false);
        setActiveTurnId(null);
        activeTurnIdRef.current = null;
        setIsCompacting(false);
        setError(event.payload.error.message);
        const failedTurnId = event.payload.turnId;
        const liveSnapshot = liveStepsRef.current;
        if (liveSnapshot.some((step) => step.reasoning || step.answer || step.tools.length > 0)) {
          setSettledLiveTurns((current) => ({ ...current, [failedTurnId]: liveSnapshot }));
        }
        liveStepsRef.current = [];
        setLiveSteps([]);
        setApprovals([]);
        void refreshConversation().finally(() => {
          setSettledLiveTurns((current) => removeSettledLiveTurn(current, failedTurnId));
        });
      }
    },
    [conversationId, projectId, refreshConversation, replaceConversationInSidebar],
  );

  const { isConnected, sendCommand } = useSocratesSocket({
    onEvent: handleSocketEvent,
    onError: setError,
    onConnected: (send) => {
      if (activeTurnIdRef.current) {
        liveStepsRef.current = [];
        setLiveSteps([]);
      }
      const command: ClientCommand = {
        id: `cmd_${crypto.randomUUID()}`,
        type: "chat.conversation.subscribe",
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        projectId,
        conversationId,
        actor: { type: "user" },
        payload: {
          replayActiveTurn: true,
        },
      };
      send(command);
      void refreshConversation().catch((err) => {
        setError(err instanceof Error ? err.message : "Could not refresh conversation.");
      });
    },
  });

  useEffect(() => {
    let isMounted = true;

    async function loadChat() {
      setIsLoading(true);
      setError(null);
      try {
        const [conversation, projectsResponse, modelsResponse, notificationsResponse] = await Promise.all([
          api.getConversation(projectId, conversationId),
          api.listProjects(),
          api.listModels(),
          api.listNotifications({ limit: 20 }),
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
          const hasReplayedLiveSteps =
            Boolean(reloadActiveTurn) && liveStepsRef.current.some((step) => step.turnId === reloadActiveTurn);
          activeTurnIdRef.current = reloadActiveTurn;
          setActiveTurnId(reloadActiveTurn);
          setIsSending(Boolean(reloadActiveTurn));
          if (!hasReplayedLiveSteps) {
            liveStepsRef.current = [];
            setLiveSteps([]);
          }
          setApprovals([]);
          setIsCompacting(false);
          setSidebarProjects(projectConversations);
          setModels(modelsResponse.models);
          setNotifications(notificationsResponse.notifications);
          setUnreadNotificationCount(notificationsResponse.unreadCount);
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
    setAnchorMessageId(clientMessageId);
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
              costUsage: emptyCostUsage(),
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

  const handleTerminalInput = (terminalId: string, input: { data?: string; text?: string; key?: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter" | "Escape" | "Ctrl-C"; submit?: boolean }) => {
    const terminal = terminals.find((item) => item.terminalId === terminalId);
    if (!terminal || !isLiveTerminal(terminal)) {
      return;
    }
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
        ...(input.data === undefined ? {} : { data: input.data }),
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.key === undefined ? {} : { key: input.key }),
        ...(input.submit === undefined ? {} : { submit: input.submit }),
      },
    };
    sendCommand(command);
  };

  const handleTerminalResize = (terminalId: string, size: { cols: number; rows: number }) => {
    const terminal = terminals.find((item) => item.terminalId === terminalId);
    if (!terminal || !isLiveTerminal(terminal)) {
      return;
    }
    const command: ClientCommand = {
      id: `cmd_${crypto.randomUUID()}`,
      type: "terminal.resize",
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      projectId,
      conversationId,
      actor: { type: "user" },
      payload: {
        terminalId,
        cols: size.cols,
        rows: size.rows,
      },
    };
    sendCommand(command);
  };

  const handleTerminalRename = (terminalId: string, name: string) => {
    const command: ClientCommand = {
      id: `cmd_${crypto.randomUUID()}`,
      type: "terminal.rename",
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      projectId,
      conversationId,
      actor: { type: "user" },
      payload: {
        terminalId,
        name,
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

  const handleNotificationRead = async (notificationId: string) => {
    try {
      const response = await api.markNotificationRead(notificationId);
      setNotifications((current) => current.map((item) => (item.id === notificationId ? response.notification : item)));
      setUnreadNotificationCount(response.unreadCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark notification read.");
    }
  };

  const handleAllNotificationsRead = async () => {
    try {
      const response = await api.markAllNotificationsRead();
      setNotifications(response.notifications);
      setUnreadNotificationCount(response.unreadCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not mark notifications read.");
    }
  };

  const orderedTerminals = useMemo(
    () => [...terminals].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
    [terminals],
  );
  const hasAwaitingTerminalInput = orderedTerminals.some((terminal) => terminal.awaitingInput || terminal.status === "awaiting_input");
  const liveTerminalCount = orderedTerminals.filter((terminal) => terminal.status === "running" || terminal.status === "awaiting_input").length;
  const clampedTerminalPanelWidth = Math.min(Math.max(terminalPanelWidth, MIN_TERMINAL_PANEL_WIDTH), MAX_TERMINAL_PANEL_WIDTH);
  const clampedTerminalDockHeight = Math.min(Math.max(terminalDockHeight, MIN_TERMINAL_DOCK_HEIGHT), MAX_TERMINAL_DOCK_HEIGHT);

  const handleOpenTerminalInDock = (terminalId: string) => {
    setActiveDockTerminalId(terminalId);
    setIsTerminalDockOpen(true);
  };

  const messages: Message[] = conversationData?.messages ?? [];
  const toolRuns = conversationData?.toolRuns ?? [];
  const partialTurns = conversationData?.partialTurns ?? [];
  const conversationTitle = conversationData?.conversation.title ?? "New conversation";
  const contextUsage = conversationData?.contextUsage;
  const hasTerminals = terminals.length > 0;
  const awaitingTerminalInputCount = orderedTerminals.filter((terminal) => terminal.awaitingInput || terminal.status === "awaiting_input").length;
  const activeTerminalCount = liveTerminalCount;
  const effectiveTerminalPanelCollapsed = isTerminalPanelCollapsed;
  const showDesktopRail = hasTerminals && !isMobileView;
  const showTerminalDock = hasTerminals || Boolean(activeDockTerminalId);
  const terminalRailWidth = effectiveTerminalPanelCollapsed ? COLLAPSED_TERMINAL_PANEL_WIDTH : clampedTerminalPanelWidth;
  const preferredDockTerminalId = orderedTerminals.find((terminal) => terminal.awaitingInput || terminal.status === "awaiting_input")?.terminalId;
  const activeDockTerminalForDisplay =
    activeDockTerminalId && orderedTerminals.some((terminal) => terminal.terminalId === activeDockTerminalId)
      ? activeDockTerminalId
      : undefined;
  const resolvedActiveDockTerminalId = activeDockTerminalForDisplay ?? preferredDockTerminalId ?? orderedTerminals[0]?.terminalId;
  const resolvedIsTerminalDockOpen = isTerminalDockOpen;
  const workspaceBodyClass = showDesktopRail
    ? "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:grid"
    : "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden";
  const workspaceBodyStyle = showDesktopRail
    ? ({ gridTemplateColumns: `minmax(0, 1fr) ${terminalRailWidth}px` } as const)
    : undefined;
  const tokenLabel = useMemo(() => {
    if (contextUsage) {
      return `${contextUsage.contextUsedTokens.toLocaleString()} tokens`;
    }
    return null;
  }, [contextUsage]);
  const costUsage = conversationData?.costUsage;
  const costLabel = useMemo(() => {
    if (!costUsage || costUsage.turnCount === 0) {
      return null;
    }
    if (costUsage.hasUnknownCost && (costUsage.totalCostUsd === undefined || costUsage.totalCostUsd === 0)) {
      return "$--";
    }
    return costUsage.totalCostUsd === undefined ? "$--" : formatDollarCost(costUsage.totalCostUsd);
  }, [costUsage]);
  const costTitle = useMemo(() => {
    if (!costUsage) {
      return undefined;
    }
    if (costUsage.hasUnknownCost) {
      return "Cost includes unavailable provider/pricing data";
    }
    if (costUsage.hasComputedCost) {
      return "Cost estimated from pricing";
    }
    return "Provider-reported cost";
  }, [costUsage]);

  useEffect(() => {
    const hadLiveTerminals = previousLiveTerminalCountRef.current > 0;
    const hasLiveTerminals = liveTerminalCount > 0;
    const hadAwaitingInput = previousAwaitingTerminalInputRef.current;

    if (!isMobileView && !hadLiveTerminals && hasLiveTerminals) {
      setIsTerminalPanelCollapsed(false);
    }

    if (!isMobileView && hadLiveTerminals && !hasLiveTerminals && !hasAwaitingTerminalInput) {
      setIsTerminalPanelCollapsed(true);
    }

    if (!hadAwaitingInput && hasAwaitingTerminalInput) {
      setIsTerminalDockOpen(true);
    }

    previousLiveTerminalCountRef.current = liveTerminalCount;
    previousAwaitingTerminalInputRef.current = hasAwaitingTerminalInput;
  }, [hasAwaitingTerminalInput, isMobileView, liveTerminalCount]);

  return (
    <main className="flex h-screen overflow-hidden bg-brand-bg">
      <ProjectChatSidebar
        projects={sidebarProjects}
        currentProjectId={projectId}
        currentConversationId={conversationId}
        isCollapsed={isSidebarCollapsed}
        onCollapse={() => setIsSidebarCollapsed(true)}
        onExpand={() => setIsSidebarCollapsed(false)}
        onStartChat={handleStartChat}
      />
      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-white">
        <header
          className={`flex h-14 min-w-0 shrink-0 items-center border-b border-gray-200 ${
            isSidebarCollapsed ? "pl-16 pr-6" : "px-6"
          }`}
        >
          <button
            type="button"
            className="mr-4 inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-brand-text-light shadow-sm hover:bg-gray-50 hover:text-brand-text-dark"
            title="Project dashboard"
            aria-label="Project dashboard"
            onClick={() => router.push(`/projects/${projectId}`)}
          >
            <LayoutDashboard className="size-4" />
            <span className="hidden sm:inline">Dashboard</span>
          </button>
          <h1 className="truncate text-sm font-medium text-brand-text-dark">{conversationTitle}</h1>
          {tokenLabel ? <span className="ml-4 shrink-0 font-mono text-xs text-brand-text-light">{tokenLabel}</span> : null}
          {costLabel ? (
            <span className="ml-3 shrink-0 font-mono text-xs text-brand-text-light" title={costTitle}>
              {costLabel}
              {costUsage?.hasComputedCost || costUsage?.hasUnknownCost ? "*" : ""}
            </span>
          ) : null}
          <NotificationCenter
            notifications={notifications}
            unreadCount={unreadNotificationCount}
            isOpen={isNotificationCenterOpen}
            onToggle={() => setIsNotificationCenterOpen((current) => !current)}
            onClose={() => setIsNotificationCenterOpen(false)}
            onRead={handleNotificationRead}
            onReadAll={handleAllNotificationsRead}
          />
          {hasTerminals ? (
            <button
              type="button"
              className="ml-2 inline-flex h-9 shrink-0 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-xs font-medium text-brand-text-light shadow-sm hover:bg-gray-50 hover:text-brand-text-dark"
              title={isMobileView ? (isTerminalDockOpen ? "Hide terminal panel" : "Show terminal panel") : effectiveTerminalPanelCollapsed ? "Show terminal panel" : "Hide terminal panel"}
              aria-pressed={isMobileView ? isTerminalDockOpen : !effectiveTerminalPanelCollapsed}
              onClick={() => {
                if (isMobileView) {
                  setIsTerminalDockOpen((current) => !current);
                  return;
                }
                setIsTerminalPanelCollapsed((current) => !current);
              }}
            >
              {isMobileView ? isTerminalDockOpen ? <EyeOff className="size-4" /> : <Eye className="size-4" /> : effectiveTerminalPanelCollapsed ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
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
        <div className={workspaceBodyClass} style={workspaceBodyStyle}>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
                  settledLiveTurns={settledLiveTurns}
                  anchorMessageId={anchorMessageId}
                  isStreaming={isSending}
                  isCompacting={isCompacting}
                  onApprovalDecision={handleApprovalDecision}
                />
                <div className="min-w-0 border-t border-gray-100 bg-white px-6 py-3">
                  <div className="mx-auto max-w-3xl min-w-0">
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
            <TerminalDockPanel
              terminals={orderedTerminals}
              isOpen={showTerminalDock && resolvedIsTerminalDockOpen}
              isMobile={isMobileView}
              activeTerminalId={resolvedActiveDockTerminalId}
              onActiveTerminalIdChange={setActiveDockTerminalId}
              onClose={() => setIsTerminalDockOpen(false)}
              onStop={handleTerminalStop}
              onInput={handleTerminalInput}
              onResize={handleTerminalResize}
              dockHeight={clampedTerminalDockHeight}
              onResizeDock={(nextHeight) =>
                setTerminalDockHeight(Math.min(Math.max(nextHeight, MIN_TERMINAL_DOCK_HEIGHT), MAX_TERMINAL_DOCK_HEIGHT))
              }
            />
          </div>
          {showDesktopRail ? (
            <TerminalPanel
              terminals={orderedTerminals}
              isCollapsed={effectiveTerminalPanelCollapsed}
              onToggleCollapsed={() => setIsTerminalPanelCollapsed((current) => !current)}
              onResizePanel={(nextWidth) =>
                setTerminalPanelWidth(Math.min(Math.max(nextWidth, MIN_TERMINAL_PANEL_WIDTH), MAX_TERMINAL_PANEL_WIDTH))
              }
              onStop={handleTerminalStop}
              onRename={handleTerminalRename}
              onOpenInDock={handleOpenTerminalInDock}
            />
          ) : null}
        </div>
      </section>
    </main>
  );
}

function NotificationCenter({
  notifications,
  unreadCount,
  isOpen,
  onToggle,
  onClose,
  onRead,
  onReadAll,
}: {
  notifications: SocratesNotification[];
  unreadCount: number;
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onRead: (notificationId: string) => void;
  onReadAll: () => void;
}) {
  return (
    <div className="relative ml-auto shrink-0">
      <button
        type="button"
        className="relative inline-flex size-9 items-center justify-center rounded-md border border-gray-200 bg-white text-brand-text-light shadow-sm hover:bg-gray-50 hover:text-brand-text-dark"
        title="Notifications"
        aria-label="Notifications"
        onClick={onToggle}
      >
        <Bell className="size-4" />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-brand-button px-1.5 py-0.5 text-center text-[10px] font-semibold text-white">
            {unreadCount}
          </span>
        ) : null}
      </button>
      {isOpen ? (
        <div className="absolute right-0 top-11 z-30 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
            <div>
              <p className="text-sm font-semibold text-brand-text-dark">Notifications</p>
              <p className="text-xs text-brand-text-light">{unreadCount} unread</p>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" className="text-xs font-medium text-brand-teal-dark hover:underline" onClick={onReadAll}>
                Mark all read
              </button>
              <button type="button" className="rounded-md p-1 text-brand-text-light hover:bg-gray-50" title="Close" onClick={onClose}>
                <X className="size-4" />
              </button>
            </div>
          </div>
          <div className="max-h-96 overflow-auto">
            {notifications.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-brand-text-light">No notifications yet.</div>
            ) : (
              notifications.map((notification) => {
                const payload = notification.payload && typeof notification.payload === "object" ? (notification.payload as Record<string, unknown>) : {};
                const diff = typeof payload.diff === "string" ? payload.diff : undefined;
                const rationale = typeof payload.rationale === "string" ? payload.rationale : undefined;
                return (
                  <button
                    key={notification.id}
                    type="button"
                    className={`block w-full border-b border-gray-100 px-3 py-3 text-left hover:bg-gray-50 ${
                      notification.readAt ? "bg-white" : "bg-teal-50/40"
                    }`}
                    onClick={() => onRead(notification.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-brand-text-dark">{notification.title}</p>
                        {notification.body ? <p className="mt-1 text-xs text-brand-text-light">{notification.body}</p> : null}
                      </div>
                      {!notification.readAt ? <span className="mt-1 size-2 shrink-0 rounded-full bg-brand-teal" /> : null}
                    </div>
                    {rationale ? <p className="mt-2 text-xs text-brand-text-dark">{rationale}</p> : null}
                    {diff ? (
                      <pre className="mt-2 max-h-32 overflow-auto rounded-md border border-gray-100 bg-gray-50 p-2 font-mono text-[11px] leading-4 text-brand-text-dark">
                        {diff}
                      </pre>
                    ) : null}
                    <p className="mt-2 font-mono text-[10px] text-brand-text-light">{new Date(notification.createdAt).toLocaleString()}</p>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
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
  turnId: string | null | undefined,
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
      ...(turnId ? { turnId } : {}),
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
  providerToolCallId: string | undefined,
  updater: (tool: ToolTimelineItem) => ToolTimelineItem,
): LiveActivityStep[] =>
  steps.map((step) => ({
    ...step,
    tools: step.tools.map((tool) => (sameToolIdentity(tool, toolCallId, providerToolCallId) ? updater(tool) : tool)),
  }));

const sameToolIdentity = (tool: ToolTimelineItem, toolCallId: string, providerToolCallId: string | undefined): boolean =>
  tool.toolCallId === toolCallId || Boolean(providerToolCallId && tool.providerToolCallId === providerToolCallId);

const removeSettledLiveTurn = (
  turns: Record<string, LiveActivityStep[]>,
  turnId: string,
): Record<string, LiveActivityStep[]> => {
  if (!turns[turnId]) {
    return turns;
  }
  const next = { ...turns };
  delete next[turnId];
  return next;
};

const upsertTerminal = (terminals: ConversationTerminal[], terminal: ConversationTerminal): ConversationTerminal[] => {
  const existing = terminals.find((item) => item.terminalId === terminal.terminalId);
  const output =
    terminal.output.stdout || terminal.output.stderr || terminal.output.pty
      ? terminal.output
      : existing?.output
        ? { ...existing.output, nextOutputSequence: terminal.output.nextOutputSequence }
        : terminal.output;
  if (!existing) {
    return [terminal, ...terminals];
  }
  return terminals.map((item) => (item.terminalId === terminal.terminalId ? { ...existing, ...terminal, output } : item));
};

const emptyCostUsage = (): ConversationCostUsage => ({
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  turnCount: 0,
  costSource: "unknown",
  hasComputedCost: false,
  hasUnknownCost: false,
});

const applyTurnUsageReport = (conversation: GetConversationResponse, report: TurnUsageReport): GetConversationResponse => {
  const reports = [...(conversation.turnUsageReports ?? []).filter((item) => item.turnId !== report.turnId), report];
  return {
    ...conversation,
    turnUsageReports: reports,
    costUsage: aggregateCostUsage(reports),
  };
};

const aggregateCostUsage = (reports: TurnUsageReport[]): ConversationCostUsage => {
  const knownCostReports = reports.filter((report) => report.totalCostUsd !== undefined);
  const totalCostUsd =
    knownCostReports.length > 0 ? knownCostReports.reduce((sum, report) => sum + (report.totalCostUsd ?? 0), 0) : undefined;
  const hasComputedCost = reports.some((report) => report.costSource === "computed" || report.costSource === "mixed" || report.qualityFlags.includes("computed_cost_present"));
  const hasUnknownCost = reports.some((report) => report.costSource === "unknown" || report.costSource === "mixed" || report.qualityFlags.includes("unknown_cost_present"));
  return {
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
    totalTokens: reports.reduce((sum, report) => sum + report.totalTokens, 0),
    cachedInputTokens: reports.reduce((sum, report) => sum + report.cachedInputTokens, 0),
    cacheWriteTokens: reports.reduce((sum, report) => sum + report.cacheWriteTokens, 0),
    turnCount: reports.length,
    costSource: aggregateCostSource(reports.map((report) => report.costSource)),
    hasComputedCost,
    hasUnknownCost,
  };
};

const aggregateCostSource = (sources: ConversationCostUsage["costSource"][]): ConversationCostUsage["costSource"] => {
  const unique = new Set(sources);
  if (unique.size === 0) {
    return "unknown";
  }
  if (unique.size === 1) {
    return unique.values().next().value ?? "unknown";
  }
  return "mixed";
};

const formatDollarCost = (value: number): string => `$${value.toFixed(value < 0.01 ? 4 : 2)}`;

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
    pty: "",
    nextOutputSequence: event.payload.nextOutputSequence ?? 0,
  },
});

const appendTerminalOutput = (terminal: ConversationTerminal, event: Extract<ServerEvent, { type: "terminal.data" | "terminal.output" }>): ConversationTerminal => {
  const sequence = event.payload.sequence ?? terminal.output.nextOutputSequence;
  const nextOutput = { ...terminal.output, nextOutputSequence: sequence + 1 };
  if (event.payload.stream === "pty") {
    nextOutput.pty = trimTerminalOutput(`${nextOutput.pty ?? ""}${event.payload.text}`);
    nextOutput.stdout = trimTerminalOutput(`${nextOutput.stdout}${event.payload.text}`);
  } else if (event.payload.stream === "stdout") {
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

const isLiveTerminal = (terminal: ConversationTerminal): boolean => terminal.status === "running" || terminal.status === "awaiting_input";
