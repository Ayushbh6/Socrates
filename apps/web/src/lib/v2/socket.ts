"use client";

import { socratesApiBaseUrl } from "@/lib/api";
import {
  V2_FLOW_SCHEMA_VERSION,
  v2ClientCommandSchema,
  v2ServerEventSchema,
  type V2ClientCommand,
  type V2ServerEvent,
} from "@socrates/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

export type V2SocketStatus = "connecting" | "subscribing" | "connected" | "reconnecting" | "disconnected";

type CommandScope = {
  projectId: string;
  flowId: string;
  goalId?: string;
  turnId?: string;
};

const createClientId = (prefix: string): string => {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${suffix}`;
};

export const makeV2Command = (
  type: V2ClientCommand["type"],
  payload: unknown,
  scope: CommandScope,
): V2ClientCommand =>
  v2ClientCommandSchema.parse({
    id: createClientId("v2cmd"),
    schemaVersion: V2_FLOW_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    projectId: scope.projectId,
    flowId: scope.flowId,
    ...(scope.goalId ? { goalId: scope.goalId } : {}),
    ...(scope.turnId ? { turnId: scope.turnId } : {}),
    actor: { type: "user" },
    type,
    payload,
  });

const socketUrl = (): string => {
  const url = new URL(socratesApiBaseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v2/ws";
  url.search = "";
  return url.toString();
};

interface UseV2FlowSocketInput {
  projectId: string;
  flowId?: string;
  afterSequence: number;
  onEvent: (event: V2ServerEvent) => void;
  onError: (message: string | null) => void;
}

export function useV2FlowSocket({
  projectId,
  flowId,
  afterSequence,
  onEvent,
  onError,
}: UseV2FlowSocketInput) {
  const socketRef = useRef<WebSocket | null>(null);
  const eventHandlerRef = useRef(onEvent);
  const errorHandlerRef = useRef(onError);
  const sequenceRef = useRef(afterSequence);
  const [status, setStatus] = useState<V2SocketStatus>("disconnected");

  useEffect(() => {
    eventHandlerRef.current = onEvent;
    errorHandlerRef.current = onError;
    sequenceRef.current = afterSequence;
  }, [afterSequence, onError, onEvent]);

  useEffect(() => {
    if (!flowId) return;
    let disposed = false;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (disposed) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(socketUrl());
      } catch (error) {
        errorHandlerRef.current(error instanceof Error ? error.message : "Could not open the Seamless connection.");
        setStatus("disconnected");
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) return;
        reconnectAttempts = 0;
        setStatus("subscribing");
        errorHandlerRef.current(null);
        const subscribe = makeV2Command(
          "v2.flow.subscribe",
          { afterSequence: sequenceRef.current, replayActiveTurn: true },
          { projectId, flowId },
        );
        socket.send(JSON.stringify(subscribe));
      };

      socket.onmessage = (message) => {
        if (disposed) return;
        try {
          const event = v2ServerEventSchema.parse(JSON.parse(String(message.data)));
          if (event.type === "v2.connection.ready") {
            setStatus("connected");
          }
          if (event.type === "v2.flow.snapshot") {
            sequenceRef.current = Math.max(sequenceRef.current, event.payload.snapshot.lastEventSequence);
          }
          eventHandlerRef.current(event);
        } catch {
          errorHandlerRef.current("Socrates received an invalid V2 runtime event.");
        }
      };

      socket.onerror = () => {
        if (!disposed) {
          errorHandlerRef.current("Seamless connection interrupted. Reconnecting…");
        }
      };

      socket.onclose = () => {
        if (disposed) return;
        socketRef.current = null;
        setStatus("reconnecting");
        const delay = Math.min(600 * 2 ** reconnectAttempts, 8_000);
        reconnectAttempts += 1;
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    queueMicrotask(connect);
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const socket = socketRef.current;
      if (!socket) return;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify(makeV2Command("v2.flow.unsubscribe", {}, { projectId, flowId })));
        } catch {
          // Closing the socket is authoritative if unsubscribe cannot be sent.
        }
      }
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [flowId, projectId]);

  const send = useCallback((command: V2ClientCommand) => {
    const parsed = v2ClientCommandSchema.parse(command);
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || status !== "connected") {
      throw new Error("Socrates Flow is reconnecting. Your draft is still here.");
    }
    socket.send(JSON.stringify(parsed));
  }, [status]);

  return { status, isConnected: status === "connected", send };
}
