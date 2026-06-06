"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientCommand, ServerEvent } from "@socrates/contracts";
import { serverEventSchema } from "@socrates/contracts";
import { socratesApiBaseUrl } from "@/lib/api";

const socketUrlFromApiBase = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  return url.toString();
};

type UseSocratesSocketInput = {
  onEvent: (event: ServerEvent) => void;
  onError?: (message: string | null) => void;
  onConnected?: (sendCommand: (command: ClientCommand) => void) => void;
};

export function useSocratesSocket({ onEvent, onError, onConnected }: UseSocratesSocketInput) {
  const socketRef = useRef<WebSocket | null>(null);
  const eventHandlerRef = useRef(onEvent);
  const errorHandlerRef = useRef(onError);
  const connectedHandlerRef = useRef<UseSocratesSocketInput["onConnected"]>(undefined);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    eventHandlerRef.current = onEvent;
    errorHandlerRef.current = onError;
    connectedHandlerRef.current = onConnected;
  }, [onEvent, onError, onConnected]);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAttempts = 0;
    let disposed = false;

    const connect = () => {
      if (!disposed) {
        const socket = new WebSocket(socketUrlFromApiBase(socratesApiBaseUrl()));
        socketRef.current = socket;

        socket.onopen = () => {
          if (!disposed) {
            reconnectAttempts = 0;
            setIsConnected(true);
            errorHandlerRef.current?.(null);
            connectedHandlerRef.current?.((command) => {
              if (socket.readyState !== WebSocket.OPEN) {
                throw new Error("Socrates is not connected yet.");
              }
              socket.send(JSON.stringify(command));
            });
          }
        };
        socket.onclose = () => {
          if (!disposed) {
            setIsConnected(false);
            socketRef.current = null;
            const delay = Math.min(500 * 2 ** reconnectAttempts, 5_000);
            reconnectAttempts += 1;
            reconnectTimer = setTimeout(connect, delay);
          }
        };
        socket.onerror = () => {
          if (!disposed && reconnectAttempts > 0) {
            errorHandlerRef.current?.("WebSocket connection interrupted. Reconnecting...");
          }
        };
        socket.onmessage = (message) => {
          if (disposed) {
            return;
          }
          try {
            const parsed = serverEventSchema.parse(JSON.parse(message.data as string));
            eventHandlerRef.current(parsed);
          } catch {
            errorHandlerRef.current?.("Received an invalid server event.");
          }
        };
      }
    };
    connect();

    return () => {
      disposed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      const socket = socketRef.current;
      if (!socket) {
        return;
      }
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, []);

  const sendCommand = useCallback((command: ClientCommand) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Socrates is not connected yet.");
    }
    socket.send(JSON.stringify(command));
  }, []);

  return { isConnected, sendCommand };
}
