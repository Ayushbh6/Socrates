"use client";

import { api } from "@/lib/api";
import { V2_STORAGE_KEYS } from "@/lib/v2/storageKeys";
import { v2Api } from "@/lib/v2/api";
import { useV2FlowRuntime } from "@/lib/v2/useV2FlowRuntime";
import {
  V2_TRANSCRIBER_OPTIONS,
  type V2TranscriberId,
  useV2Voice,
} from "@/lib/v2/useV2Voice";
import type {
  GetProjectResponse,
  ListModelsHttpResponse,
  ListProjectsResponse,
  ModelOption,
  V2Message,
  V2MessageAttachment,
  V2RuntimeConfig,
} from "@socrates/contracts";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { FlowWorkspace } from "./FlowWorkspace";
import { LivingSphere } from "./LivingSphere";
import styles from "./seamless.module.css";
import type { FlowPresenceState, FlowTimelineItemView } from "./types";
import {
  appendViewHandoff,
  clearCurrentViewHandoff,
  createViewHandoff,
  handoffAttachmentsToFiles,
  parseViewHandoffSnapshot,
  readViewHandoffSnapshot,
  type ViewHandoffEnvelope,
} from "@/lib/v2/viewHandoff";

interface SeamlessProjectRouteProps {
  projectId: string;
}

const modelKey = (model: Pick<ModelOption, "providerId" | "authMode" | "modelId">): string =>
  `${model.providerId}:${model.authMode ?? "api_key"}:${model.modelId}`;

const chooseInitialModel = (data: ListModelsHttpResponse, projectId: string): string | undefined => {
  const stored = window.localStorage.getItem(`${V2_STORAGE_KEYS.composerModel}:${projectId}`);
  if (stored && data.models.some((model) => modelKey(model) === stored)) return stored;
  if (data.defaultModel) {
    const defaultKey = modelKey(data.defaultModel);
    if (data.models.some((model) => modelKey(model) === defaultKey)) return defaultKey;
  }
  const fallback = data.models.find((model) => model.isDefault) ?? data.models[0];
  return fallback ? modelKey(fallback) : undefined;
};

const thinkingStorageKey = (projectId: string, selectedModelKey: string): string =>
  `${V2_STORAGE_KEYS.composerThinking}:${projectId}:${selectedModelKey}`;

const chooseInitialThinkingOption = (model: ModelOption, projectId: string): string => {
  const key = modelKey(model);
  const stored = window.localStorage.getItem(thinkingStorageKey(projectId, key));
  if (stored && model.thinkingOptions.some((option) => option.id === stored)) return stored;
  return model.thinkingOptions.find((option) => option.id === model.defaultThinkingOptionId)?.id
    ?? model.thinkingOptions[0]!.id;
};

const chooseComposerSelection = (
  data: ListModelsHttpResponse,
  projectId: string,
  handoff: ViewHandoffEnvelope | null,
): { modelId?: string; thinkingOptionId?: string } => {
  const handoffModelPreference = handoff?.model;
  const handoffModel = handoffModelPreference
    ? data.models.find((candidate) =>
      candidate.providerId === handoffModelPreference.providerId &&
      candidate.modelId === handoffModelPreference.modelId &&
      (candidate.authMode ?? "api_key") === (handoffModelPreference.authMode ?? "api_key"))
    : undefined;
  if (handoffModel) {
    const thinking = handoffModel.thinkingOptions.find((option) => option.id === handoff?.thinkingOptionId)
      ?? handoffModel.thinkingOptions.find((option) => option.id === handoffModel.defaultThinkingOptionId)
      ?? handoffModel.thinkingOptions[0];
    return { modelId: modelKey(handoffModel), thinkingOptionId: thinking?.id };
  }
  const modelId = chooseInitialModel(data, projectId);
  const model = data.models.find((candidate) => modelKey(candidate) === modelId);
  return {
    modelId,
    thinkingOptionId: model ? chooseInitialThinkingOption(model, projectId) : undefined,
  };
};

const summarizeAction = (action: unknown): string | undefined => {
  if (typeof action === "string") return action.slice(0, 180);
  try {
    const serialized = JSON.stringify(action);
    return serialized && serialized !== "{}" ? serialized.slice(0, 180) : undefined;
  } catch {
    return undefined;
  }
};

const contextItemLabel = (sourceLocator: string, sourceType: string): string => {
  const normalized = sourceLocator.replaceAll("\\", "/").replace(/\/$/, "");
  const tail = normalized.split("/").filter(Boolean).at(-1);
  return tail?.trim() || sourceLocator.trim() || sourceType.replaceAll("_", " ");
};

const timelineFromMessages = (
  messages: V2Message[],
  streams: Record<string, { answer: string; reasoning?: string }>,
  goalTitles: Map<string, string>,
): FlowTimelineItemView[] => {
  const base: FlowTimelineItemView[] = messages
    .filter((message): message is V2Message & { role: "user" | "assistant" | "system" } =>
      message.role === "user" || message.role === "assistant" || message.role === "system")
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: `${message.content}${streams[message.id]?.answer ?? ""}`,
      ...(`${message.reasoning ?? ""}${streams[message.id]?.reasoning ?? ""}`
        ? { reasoning: `${message.reasoning ?? ""}${streams[message.id]?.reasoning ?? ""}` }
        : {}),
      ...(message.attachments?.length ? {
        attachments: message.attachments.map((attachment) => ({
          id: attachment.id,
          fileName: attachment.fileName,
          kind: attachment.kind,
          ...(attachment.url ? { url: attachment.url } : {}),
        })),
      } : {}),
      status: message.status,
      createdAt: message.createdAt,
      ...(message.goalId ? { goalId: message.goalId } : {}),
      readAloudAvailable: message.role === "assistant" && message.status === "completed" && Boolean(message.content.trim()),
    }));

  const visible: FlowTimelineItemView[] = [];
  let previousGoalId: string | undefined;
  for (const item of base) {
    if (item.goalId && previousGoalId && item.goalId !== previousGoalId) {
      visible.push({
        id: `focus-shift-${item.id}`,
        role: "system",
        content: `Focus shifted to ${goalTitles.get(item.goalId) ?? "another thread"}`,
        status: "completed",
        goalId: item.goalId,
      });
    }
    if (item.goalId) previousGoalId = item.goalId;
    visible.push(item);
  }
  const messageIds = new Set(messages.map((message) => message.id));
  for (const [messageId, stream] of Object.entries(streams)) {
    if (!messageIds.has(messageId) && stream.answer) {
      visible.push({
        id: messageId,
        role: "assistant",
        content: stream.answer,
        ...(stream.reasoning ? { reasoning: stream.reasoning } : {}),
        status: "streaming",
      });
    }
  }
  return visible;
};

export function SeamlessProjectRoute({ projectId }: SeamlessProjectRouteProps) {
  const router = useRouter();
  const runtime = useV2FlowRuntime({ projectId });
  const [projectData, setProjectData] = useState<GetProjectResponse | null>(null);
  const [projectsData, setProjectsData] = useState<ListProjectsResponse["projects"]>([]);
  const [modelsData, setModelsData] = useState<ListModelsHttpResponse | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>();
  const [selectedThinkingOptionId, setSelectedThinkingOptionId] = useState<string | undefined>();
  const [isLoadingProject, setIsLoadingProject] = useState(true);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const handoffSnapshot = useSyncExternalStore(
    () => () => undefined,
    readViewHandoffSnapshot,
    () => null,
  );
  const pendingViewHandoff = useMemo(
    () => parseViewHandoffSnapshot(handoffSnapshot, "flow", projectId),
    [handoffSnapshot, projectId],
  );
  const [draftTextOverride, setDraftTextOverride] = useState<string | null>(null);
  const draftText = draftTextOverride ?? pendingViewHandoff?.text ?? "";
  const [draftAttachments, setDraftAttachments] = useState<V2MessageAttachment[]>([]);
  const appliedHandoffAttachmentsRef = useRef(false);

  useEffect(() => {
    const snapshot = runtime.state?.snapshot;
    if (appliedHandoffAttachmentsRef.current || !pendingViewHandoff || !snapshot || pendingViewHandoff.attachments.length === 0) return;
    appliedHandoffAttachmentsRef.current = true;
    void handoffAttachmentsToFiles(pendingViewHandoff.attachments)
      .then((files) => v2Api.uploadAttachments(projectId, snapshot.flow.id, files))
      .then(setDraftAttachments)
      .catch((reason: unknown) => setActionError(reason instanceof Error ? reason.message : "Could not transfer draft attachments."));
  }, [pendingViewHandoff, projectId, runtime.state?.snapshot]);

  const loadProjectShell = useCallback(async () => {
    setIsLoadingProject(true);
    setProjectError(null);
    try {
      const [project, projects] = await Promise.all([api.getProject(projectId), api.listProjects()]);
      setProjectData(project);
      setProjectsData(projects.projects);
      try {
        const models = await api.listModels();
        setModelsData(models);
        const selection = chooseComposerSelection(models, projectId, pendingViewHandoff);
        setSelectedModelId(selection.modelId);
        setSelectedThinkingOptionId(selection.thinkingOptionId);
        setModelError(null);
      } catch (modelsError) {
        setModelError(modelsError instanceof Error ? modelsError.message : "Models are unavailable.");
      }
    } catch (loadError) {
      setProjectError(loadError instanceof Error ? loadError.message : "Could not load this project.");
    } finally {
      setIsLoadingProject(false);
    }
  }, [pendingViewHandoff, projectId]);

  useEffect(() => {
    let isMounted = true;
    async function loadInitialProjectShell() {
      try {
        const [project, projects] = await Promise.all([api.getProject(projectId), api.listProjects()]);
        if (!isMounted) return;
        setProjectData(project);
        setProjectsData(projects.projects);
        setProjectError(null);
        try {
          const models = await api.listModels();
          if (isMounted) {
            setModelsData(models);
            const selection = chooseComposerSelection(models, projectId, pendingViewHandoff);
            setSelectedModelId(selection.modelId);
            setSelectedThinkingOptionId(selection.thinkingOptionId);
            setModelError(null);
          }
        } catch (modelsError) {
          if (isMounted) setModelError(modelsError instanceof Error ? modelsError.message : "Models are unavailable.");
        }
      } catch (loadError) {
        if (isMounted) setProjectError(loadError instanceof Error ? loadError.message : "Could not load this project.");
      } finally {
        if (isMounted) setIsLoadingProject(false);
      }
    }
    void loadInitialProjectShell();
    return () => {
      isMounted = false;
    };
  }, [pendingViewHandoff, projectId]);

  const selectedModel = useMemo(
    () => modelsData?.models.find((model) => modelKey(model) === selectedModelId),
    [modelsData, selectedModelId],
  );
  const selectedThinkingOption = selectedModel?.thinkingOptions.find((option) => option.id === selectedThinkingOptionId)
    ?? selectedModel?.thinkingOptions.find((option) => option.id === selectedModel.defaultThinkingOptionId)
    ?? selectedModel?.thinkingOptions[0];

  const runtimeConfig = useMemo<V2RuntimeConfig | null>(() => {
    if (!selectedModel) return null;
    const thinking = selectedThinkingOption ?? selectedModel.thinkingOptions[0];
    return {
      providerId: selectedModel.providerId,
      authMode: selectedModel.authMode,
      modelId: selectedModel.modelId,
      thinkingEnabled: thinking.enabled,
      ...(thinking.effort ? { thinkingEffort: thinking.effort } : {}),
      approvalMode: "manual",
      sandboxMode: "workspace_write",
      ...(selectedModel.contextWindowTokens ? { contextWindowTokens: selectedModel.contextWindowTokens } : {}),
    };
  }, [selectedModel, selectedThinkingOption]);

  const appendTranscript = useCallback((transcript: string) => {
    setDraftTextOverride((current) => {
      const existing = current ?? pendingViewHandoff?.text ?? "";
      return existing.trim() ? `${existing.trimEnd()} ${transcript}` : transcript;
    });
  }, [pendingViewHandoff?.text]);
  const snapshot = runtime.state?.snapshot;
  const voice = useV2Voice({
    projectId,
    flowId: snapshot?.flow.id,
    goalId: snapshot?.flow.foregroundGoalId,
    onTranscript: appendTranscript,
  });

  if (isLoadingProject || runtime.isHydrating) {
    return (
      <main className={styles.routeStatePage}>
        <div className={styles.oceanNoise} aria-hidden="true" />
        <LivingSphere state="routing" size="compact" statusLabel="Opening project flow" />
      </main>
    );
  }

  const blockingError = projectError ?? runtime.loadError;
  if (blockingError || !projectData || !runtime.state || !snapshot) {
    return (
      <main className={styles.routeStatePage}>
        <div className={styles.oceanNoise} aria-hidden="true" />
        <LivingSphere state="error" size="compact" statusLabel="Project flow unavailable" />
        <p role="alert">{blockingError ?? "The project flow could not be loaded."}</p>
        <button
          type="button"
          onClick={() => {
            void loadProjectShell();
            void runtime.refresh();
          }}
        >
          <RefreshCw aria-hidden="true" />
          Try again
        </button>
      </main>
    );
  }

  const activeTools = Object.values(runtime.state.toolCalls).filter((tool) =>
    tool.status === "pending" || tool.status === "awaiting_approval" || tool.status === "running");
  const activeTool = activeTools.at(-1);
  const awaitingInput = Boolean(runtime.state.pendingClarification)
    || snapshot.pendingApprovals.length > 0
    || Object.keys(runtime.state.credentialRequests).length > 0
    || snapshot.activeTerminals.some((terminal) => terminal.awaitingInput);
  let presenceState: FlowPresenceState = "idle";
  let statusLabel = "Ready";
  if (!runtime.isConnected) {
    presenceState = runtime.connectionStatus === "reconnecting" ? "routing" : "offline";
    statusLabel = runtime.connectionStatus === "reconnecting" ? "Reconnecting to this flow" : "Connecting to this flow";
  } else if (voice.status === "recording") {
    presenceState = "listening";
    statusLabel = "Listening · tap the microphone to stop";
  } else if (voice.status === "transcribing") {
    presenceState = "thinking";
    statusLabel = "Transcribing locally or with your selected provider";
  } else if (voice.status === "synthesizing" || voice.status === "speaking") {
    presenceState = "working";
    statusLabel = voice.status === "speaking" ? "Reading aloud" : "Preparing local speech";
  } else if (awaitingInput) {
    presenceState = "awaiting_input";
    statusLabel = runtime.state.pendingClarification ? "One quick focus clarification" : "Waiting for your input";
  } else if (snapshot.activeTurn?.status === "routing") {
    presenceState = "routing";
    statusLabel = "Routing this thought";
  } else if (snapshot.activeTurn) {
    presenceState = activeTool || snapshot.activeTerminals.length > 0 ? "working" : "thinking";
    statusLabel = activeTool ? `Using ${activeTool.toolName}` : snapshot.activeTerminals.at(-1)?.name ?? "Socrates is thinking";
  }

  const visibleError = actionError ?? voice.error ?? runtime.state.lastRuntimeError ?? runtime.socketError ?? modelError;
  if (visibleError) {
    presenceState = "error";
    statusLabel = visibleError;
  }

  const timeline = timelineFromMessages(
    snapshot.messages,
    runtime.state.streams,
    new Map(snapshot.goals.map((goal) => [goal.id, goal.title])),
  );
  const messageById = new Map(snapshot.messages.map((message) => [message.id, message]));
  const isClarifying = Boolean(runtime.state.pendingClarification && snapshot.activeTurn?.status === "awaiting_clarification");
  const isSending = Boolean(snapshot.activeTurn && !isClarifying && !["completed", "failed", "cancelled"].includes(snapshot.activeTurn.status));
  const composerConnected = runtime.isConnected && Boolean(runtimeConfig);
  const contextSummary = runtime.contextState ? (() => {
    const activeItems = runtime.contextState.items.filter((item) => item.active);
    const releasedCount = runtime.contextState.counts.releasedItemCount;
    return {
      items: activeItems.map((item) => ({
        id: item.id,
        label: contextItemLabel(item.evidenceRef.sourceLocator, item.evidenceRef.sourceType),
        sourceType: item.evidenceRef.sourceType.replaceAll("_", " "),
        disposition: item.disposition,
        representation: item.representation,
        ...(item.distilledText ? { distilledText: item.distilledText } : {}),
        ...(item.tokenEstimate !== undefined ? { tokenEstimate: item.tokenEstimate } : {}),
        priority: item.priority,
      })),
      contextUsageLabel: `${activeItems.length} active for this focus`,
      exactEvidenceCount: activeItems.filter((item) => item.disposition === "keep_exact").length,
      distilledEvidenceCount: activeItems.filter((item) => item.disposition === "distill").length,
      unresolvedEvidenceCount: activeItems.filter((item) => item.disposition === "unresolved").length,
      preservedEvidenceCount: runtime.contextState.counts.immutableEvidenceCount,
      releasedItemCount: releasedCount,
    };
  })() : runtime.contextError ? { unavailableReason: runtime.contextError } : undefined;
  const toolActivity = Object.values(runtime.state.toolCalls)
    .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))
    .slice(0, 12)
    .map((tool) => ({
      id: tool.id,
      name: tool.toolName,
      status: tool.status,
      ...(summarizeAction(tool.arguments) ? { summary: summarizeAction(tool.arguments) } : {}),
      ...(tool.result !== undefined && summarizeAction(tool.result)
        ? { resultSummary: summarizeAction(tool.result) }
        : {}),
    }));
  const approvalActivity = Object.values(runtime.state.approvals)
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
    .slice(0, 12)
    .map((approval) => ({
      id: approval.id,
      actionKind: approval.actionKind.replaceAll("_", " "),
      status: approval.status,
      ...(summarizeAction(approval.action) ? { actionSummary: summarizeAction(approval.action) } : {}),
    }));
  const terminalOutputsById = runtime.state.terminalOutputs;
  const terminalActivity = Object.values(runtime.state.terminals)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 8)
    .map((terminal) => {
      const output = (terminalOutputsById[terminal.id] ?? []).map((chunk) => {
        if (chunk.stream === "input") return chunk.redacted ? "› [input hidden]\n" : `› ${chunk.text}\n`;
        return chunk.text;
      }).join("");
      return {
        id: terminal.id,
        name: terminal.name,
        command: terminal.command,
        cwd: terminal.cwd,
        status: terminal.status,
        awaitingInput: terminal.awaitingInput,
        output: output.slice(-12_000),
      };
    });

  const guardAction = (action: () => void) => {
    setActionError(null);
    try {
      action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "That action could not be sent.");
    }
  };

  return (
    <FlowWorkspace
      projectId={projectId}
      projectName={projectData.project.name}
      sidebarProjects={projectsData.map(({ project }) => ({ project, conversations: [] }))}
      timeline={timeline}
      goals={snapshot.goals.map((goal) => ({
        id: goal.id,
        title: goal.title,
        kind: goal.kind,
        status: goal.status,
        ...(goal.summary ? { summary: goal.summary } : {}),
        pinned: goal.pinned,
        updatedAt: goal.updatedAt,
      }))}
      activeGoalId={snapshot.flow.foregroundGoalId}
      currentTaskLabel={isClarifying
        ? "Choose the intended focus"
        : snapshot.activeTurn
          ? activeTool ? `Using ${activeTool.toolName}` : snapshot.activeTurn.status.replaceAll("_", " ")
          : "Ready for your next thought"}
      presenceState={presenceState}
      statusLabel={statusLabel}
      contextSummary={contextSummary}
      approvals={approvalActivity}
      toolActivity={toolActivity}
      terminalActivity={terminalActivity}
      credentialRequests={Object.values(runtime.state.credentialRequests).map((request) => ({
        id: request.id,
        turnId: request.turnId,
        serverLabel: request.serverLabel ?? request.serverId,
        envKey: request.envKey,
      }))}
      feedbackByMessageId={Object.fromEntries(
        Object.entries(runtime.state.feedbackByMessageId).map(([messageId, feedback]) => [messageId, feedback.rating]),
      )}
      voiceOptions={V2_TRANSCRIBER_OPTIONS.map((option) => ({ id: option.id, label: option.label }))}
      selectedVoiceOptionId={voice.transcriberId}
      voiceStatusLabel={voice.error ?? "Speech never switches from local to hosted without your selection."}
      hasEarlierMessages={snapshot.messageWindow.hasEarlier}
      isLoadingEarlierMessages={runtime.isLoadingEarlierMessages}
      earlierMessagesError={runtime.earlierMessagesError ?? undefined}
      onLoadEarlierMessages={() => {
        void runtime.loadEarlierMessages();
      }}
      onVoiceOptionChange={(optionId) => {
        voice.setTranscriberId(optionId as V2TranscriberId);
        voice.clearError();
      }}
      onApprovalDecision={(approvalId, decision) => guardAction(() => runtime.decideApproval(approvalId, decision))}
      onCredentialResolve={(request, decision, value) => guardAction(() => runtime.resolveCredential({
        credentialRequestId: request.id,
        turnId: request.turnId,
        decision,
        ...(value !== undefined ? { value } : {}),
      }))}
      onFeedback={(messageId, rating) => guardAction(() => runtime.submitFeedback(messageId, rating))}
      onTerminalInput={(terminalId, text) => guardAction(() => runtime.sendTerminalInput(terminalId, text))}
      onTerminalStop={(terminalId) => guardAction(() => runtime.stopTerminal(terminalId))}
      onTerminalRename={(terminalId, name) => guardAction(() => runtime.renameTerminal(terminalId, name))}
      onFocusAction={(goalId, action) => guardAction(() => runtime.updateFocus(goalId, action))}
      onOpenInClassic={(goalId) => {
        setActionError(null);
        void v2Api.openFocusInClassic(projectId, snapshot.flow.id, goalId)
          .then(({ href, bridge }) => {
            const nonce = createViewHandoff({
              target: "classic",
              projectId,
              conversationId: bridge.conversationId,
              text: draftText,
              attachments: draftAttachments,
              model: selectedModel,
              thinking: selectedThinkingOption,
            });
            clearCurrentViewHandoff();
            router.push(appendViewHandoff(href, nonce));
          })
          .catch((error: unknown) => setActionError(error instanceof Error ? error.message : "Could not open this focus in Classic View."));
      }}
      onReadAloud={(messageId) => {
        const message = messageById.get(messageId);
        if (message?.content) void voice.readAloud({ messageId, text: message.content });
      }}
      activeReadAloudMessageId={voice.activeReadAloudMessageId ?? undefined}
      readAloudStatus={voice.status === "synthesizing" || voice.status === "speaking" ? voice.status : undefined}
      composer={{
        isConnected: composerConnected,
        isSending,
        models: modelsData?.models ?? [],
        selectedModel: selectedModel ?? null,
        selectedThinkingOption: selectedThinkingOption ?? null,
        warningResetKey: snapshot.flow.id,
        value: draftText,
        onValueChange: setDraftTextOverride,
        attachments: draftAttachments,
        onAttachmentsChange: setDraftAttachments,
        voiceAvailable: voice.isAvailable,
        voiceRecording: voice.status === "recording",
        voiceBusy: voice.status === "transcribing" || voice.status === "synthesizing" || voice.status === "speaking",
        onModelChange: (nextModel) => {
          const nextModelId = modelKey(nextModel);
          setSelectedModelId(nextModelId);
          window.localStorage.setItem(`${V2_STORAGE_KEYS.composerModel}:${projectId}`, nextModelId);
          setSelectedThinkingOptionId(chooseInitialThinkingOption(nextModel, projectId));
          setModelError(null);
        },
        onThinkingChange: (nextThinkingOption) => {
          if (!selectedModel) return;
          const nextThinkingOptionId = nextThinkingOption.id;
          setSelectedThinkingOptionId(nextThinkingOptionId);
          window.localStorage.setItem(
            thinkingStorageKey(projectId, modelKey(selectedModel)),
            nextThinkingOptionId,
          );
        },
        onVoiceToggle: voice.toggleRecording,
        onUploadAttachments: isClarifying ? undefined : async (files) => {
          return v2Api.uploadAttachments(projectId, snapshot.flow.id, files);
        },
        onSend: async (content, attachments) => {
          if (!runtimeConfig) return;
          if (isClarifying) {
            runtime.respondToClarification(content);
          } else {
            await runtime.sendMessage({
              content,
              attachmentIds: attachments.map((attachment) => attachment.id),
              runtimeConfig,
            });
          }
          clearCurrentViewHandoff();
          setDraftTextOverride("");
          setActionError(null);
        },
        onStop: runtime.cancelActiveTurn,
      }}
    />
  );
}
