"use client";

import {
  V2_FLOW_SNAPSHOT_MESSAGE_LIMIT,
  type V2RuntimeConfig,
  type V2ServerEvent,
} from "@socrates/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { v2Api, type V2ClientContextState } from "./api";
import {
  hydrateV2RecentActivity,
  initialV2FlowRuntimeState,
  v2FlowRuntimeReducer,
  type V2FlowRuntimeState,
} from "./flowState";
import { makeV2Command, useV2FlowSocket } from "./socket";

const createClientMessageId = (): string => {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `v2msg_client_${suffix}`;
};

interface UseV2FlowRuntimeInput {
  projectId: string;
}

export function useV2FlowRuntime({ projectId }: UseV2FlowRuntimeInput) {
  const [state, setState] = useState<V2FlowRuntimeState | null>(null);
  const [isHydrating, setIsHydrating] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [contextState, setContextState] = useState<V2ClientContextState | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [isLoadingEarlierMessages, setIsLoadingEarlierMessages] = useState(false);
  const [earlierMessagesError, setEarlierMessagesError] = useState<string | null>(null);
  const processedEventIdsRef = useRef(new Set<string>());

  useEffect(() => {
    let isMounted = true;
    processedEventIdsRef.current.clear();
    async function hydrate() {
      await Promise.resolve();
      if (!isMounted) return;
      setIsHydrating(true);
      setState(null);
      setContextState(null);
      setContextError(null);
      setIsLoadingEarlierMessages(false);
      setEarlierMessagesError(null);
      setLoadError(null);
      try {
        const capabilities = await v2Api.getCapabilities();
        if (!capabilities.enabled) {
          throw new Error("Seamless View is disabled in this build. Classic View remains unchanged.");
        }
        const snapshot = await v2Api.ensureFlow(projectId);
        const activityAfter = Math.max(0, snapshot.lastEventSequence - 500);
        const [contextResult, activityResult] = await Promise.allSettled([
          v2Api.getContext(projectId, snapshot.flow.id),
          v2Api.getRecentEvents(projectId, snapshot.flow.id, activityAfter, 500),
        ]);
        if (isMounted) {
          const initial = initialV2FlowRuntimeState(snapshot);
          setState(activityResult.status === "fulfilled"
            ? hydrateV2RecentActivity(initial, activityResult.value)
            : initial);
          setContextState(contextResult.status === "fulfilled" ? contextResult.value : null);
          setContextError(contextResult.status === "rejected"
            ? contextResult.reason instanceof Error ? contextResult.reason.message : "Working context is unavailable."
            : null);
          setLoadError(null);
        }
      } catch (error) {
        if (isMounted) {
          setLoadError(error instanceof Error ? error.message : "Could not open the project flow.");
        }
      } finally {
        if (isMounted) setIsHydrating(false);
      }
    }
    void hydrate();
    return () => {
      isMounted = false;
    };
  }, [projectId]);

  const handleEvent = useCallback((event: V2ServerEvent) => {
    const processed = processedEventIdsRef.current;
    if (processed.has(event.id)) return;
    processed.add(event.id);
    setState((current) => current ? v2FlowRuntimeReducer(current, { type: "event", event }) : current);
    if (event.type === "v2.flow.snapshot") {
      // The authoritative snapshot advances the reconnect cursor, so event ids
      // at or before that boundary no longer need to stay in the replay set.
      processed.clear();
    }
    const contextMayHaveChanged = event.type === "v2.context.disposition.updated"
      || event.type === "v2.message.completed"
      || (event.type === "v2.tool.call.updated" && event.payload.toolCall.status === "completed");
    if (contextMayHaveChanged) {
      void v2Api.getContext(event.projectId, event.flowId).then((nextContext) => {
        setContextState(nextContext);
        setContextError(null);
      }).catch((error: unknown) => {
        setContextError(error instanceof Error ? error.message : "Working context is unavailable.");
      });
    }
  }, []);

  const flowId = state?.snapshot.flow.id;
  const afterSequence = state?.snapshot.lastEventSequence ?? 0;
  const socket = useV2FlowSocket({
    projectId,
    flowId,
    afterSequence,
    onEvent: handleEvent,
    onError: setSocketError,
  });

  const refresh = useCallback(async () => {
    setIsHydrating(true);
    setLoadError(null);
    setEarlierMessagesError(null);
    try {
      const capabilities = await v2Api.getCapabilities();
      if (!capabilities.enabled) {
        throw new Error("Seamless View is disabled in this build. Classic View remains unchanged.");
      }
      const snapshot = await v2Api.ensureFlow(projectId);
      const activityAfter = Math.max(0, snapshot.lastEventSequence - 500);
      const [contextResult, activityResult] = await Promise.allSettled([
        v2Api.getContext(projectId, snapshot.flow.id),
        v2Api.getRecentEvents(projectId, snapshot.flow.id, activityAfter, 500),
      ]);
      const initial = initialV2FlowRuntimeState(snapshot);
      setState(activityResult.status === "fulfilled"
        ? hydrateV2RecentActivity(initial, activityResult.value)
        : initial);
      setContextState(contextResult.status === "fulfilled" ? contextResult.value : null);
      setContextError(contextResult.status === "rejected"
        ? contextResult.reason instanceof Error ? contextResult.reason.message : "Working context is unavailable."
        : null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not refresh the project flow.");
    } finally {
      setIsHydrating(false);
    }
  }, [projectId]);

  const loadEarlierMessages = useCallback(async () => {
    const snapshot = state?.snapshot;
    const beforeOrdinal = snapshot?.messageWindow.beforeOrdinal;
    if (!snapshot?.messageWindow.hasEarlier || beforeOrdinal === undefined || isLoadingEarlierMessages) return;
    setIsLoadingEarlierMessages(true);
    setEarlierMessagesError(null);
    try {
      const page = await v2Api.listMessages(
        projectId,
        snapshot.flow.id,
        beforeOrdinal,
        V2_FLOW_SNAPSHOT_MESSAGE_LIMIT,
      );
      setState((current) => {
        if (!current || current.snapshot.flow.id !== snapshot.flow.id) return current;
        return v2FlowRuntimeReducer(current, {
          type: "prepend_messages",
          messages: page.messages,
          messageWindow: page.messageWindow,
        });
      });
    } catch (error) {
      setEarlierMessagesError(error instanceof Error ? error.message : "Earlier Flow messages could not be loaded.");
    } finally {
      setIsLoadingEarlierMessages(false);
    }
  }, [isLoadingEarlierMessages, projectId, state?.snapshot]);

  const requireScope = useCallback(() => {
    if (!state) throw new Error("The project flow is still loading.");
    return {
      projectId,
      flowId: state.snapshot.flow.id,
      ...(state.snapshot.flow.foregroundGoalId ? { goalId: state.snapshot.flow.foregroundGoalId } : {}),
      ...(state.snapshot.activeTurn ? { turnId: state.snapshot.activeTurn.id } : {}),
    };
  }, [projectId, state]);

  const sendMessage = useCallback(async (input: {
    content: string;
    attachmentIds: string[];
    runtimeConfig: V2RuntimeConfig;
  }) => {
    const scope = requireScope();
    socket.send(makeV2Command("v2.message.send", {
      clientMessageId: createClientMessageId(),
      content: input.content,
      ...(input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}),
      ...(scope.goalId ? { foregroundGoalIdAtCompose: scope.goalId } : {}),
      runtimeConfig: input.runtimeConfig,
    }, scope));
  }, [requireScope, socket]);

  const respondToClarification = useCallback((answer: string) => {
    if (!state?.pendingClarification || !state.snapshot.activeTurn) {
      throw new Error("There is no pending focus clarification.");
    }
    const scope = requireScope();
    socket.send(makeV2Command("v2.routing.clarification.respond", {
      routingRunId: state.pendingClarification.id,
      answerMessageId: createClientMessageId(),
      answer,
    }, { ...scope, turnId: state.snapshot.activeTurn.id }));
  }, [requireScope, socket, state]);

  const updateFocus = useCallback((goalId: string, action: "switch" | "pause" | "finish" | "reopen" | "archive" | "pin" | "unpin") => {
    const scope = requireScope();
    socket.send(makeV2Command("v2.focus.update", { goalId, action }, { ...scope, goalId }));
  }, [requireScope, socket]);

  const cancelActiveTurn = useCallback(() => {
    if (!state?.snapshot.activeTurn) return;
    const scope = requireScope();
    socket.send(makeV2Command("v2.turn.cancel", {
      turnId: state.snapshot.activeTurn.id,
      reason: "Stopped by the user.",
    }, { ...scope, turnId: state.snapshot.activeTurn.id }));
  }, [requireScope, socket, state]);

  const decideApproval = useCallback((approvalId: string, decision: "approved" | "rejected") => {
    const scope = requireScope();
    socket.send(makeV2Command("v2.approval.decide", { approvalId, decision }, scope));
  }, [requireScope, socket]);

  const submitFeedback = useCallback((messageId: string, rating: "thumbs_up" | "thumbs_down") => {
    const scope = requireScope();
    socket.send(makeV2Command("v2.feedback.submit", { messageId, rating }, scope));
  }, [requireScope, socket]);

  const resolveCredential = useCallback((input: {
    credentialRequestId: string;
    turnId: string;
    decision: "submitted" | "cancelled";
    value?: string;
  }) => {
    const scope = requireScope();
    socket.send(makeV2Command("v2.credential.input.submit", {
      credentialRequestId: input.credentialRequestId,
      turnId: input.turnId,
      decision: input.decision,
      ...(input.value !== undefined ? { value: input.value } : {}),
    }, { ...scope, turnId: input.turnId }));
  }, [requireScope, socket]);

  const sendTerminalInput = useCallback((terminalId: string, input: {
    data?: string;
    text?: string;
    key?: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter" | "Escape" | "Ctrl-C";
    submit?: boolean;
  }) => {
    const scope = requireScope();
    socket.send(makeV2Command("v2.terminal.input", {
      terminalId,
      ...input,
    }, scope));
  }, [requireScope, socket]);

  const resizeTerminal = useCallback((terminalId: string, size: { cols: number; rows: number }) => {
    const scope = requireScope();
    socket.send(makeV2Command("v2.terminal.resize", { terminalId, ...size }, scope));
  }, [requireScope, socket]);

  const stopTerminal = useCallback((terminalId: string) => {
    const scope = requireScope();
    socket.send(makeV2Command("v2.terminal.stop", {
      terminalId,
      reason: "Stopped by the user from Seamless View.",
    }, scope));
  }, [requireScope, socket]);

  const renameTerminal = useCallback((terminalId: string, name: string) => {
    const scope = requireScope();
    socket.send(makeV2Command("v2.terminal.rename", { terminalId, name }, scope));
  }, [requireScope, socket]);

  const clearRuntimeError = useCallback(() => {
    setSocketError(null);
    setState((current) => current ? v2FlowRuntimeReducer(current, { type: "clear_error" }) : current);
  }, []);

  return {
    state,
    contextState,
    contextError,
    isLoadingEarlierMessages,
    earlierMessagesError,
    isHydrating,
    loadError,
    socketError,
    connectionStatus: socket.status,
    isConnected: socket.isConnected,
    refresh,
    loadEarlierMessages,
    sendMessage,
    respondToClarification,
    updateFocus,
    cancelActiveTurn,
    decideApproval,
    submitFeedback,
    resolveCredential,
    sendTerminalInput,
    resizeTerminal,
    stopTerminal,
    renameTerminal,
    clearRuntimeError,
  };
}
