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
  onError?: (message: string) => void;
};

export function useSocratesSocket({ onEvent, onError }: UseSocratesSocketInput) {
  const socketRef = useRef<WebSocket | null>(null);
  const eventHandlerRef = useRef(onEvent);
  const errorHandlerRef = useRef(onError);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    eventHandlerRef.current = onEvent;
    errorHandlerRef.current = onError;
  }, [onEvent, onError]);

  useEffect(() => {
    const socket = new WebSocket(socketUrlFromApiBase(socratesApiBaseUrl()));
    let disposed = false;
    socketRef.current = socket;

    socket.onopen = () => {
      if (!disposed) {
        setIsConnected(true);
      }
    };
    socket.onclose = () => {
      if (!disposed) {
        setIsConnected(false);
      }
    };
    socket.onerror = () => {
      if (!disposed) {
        errorHandlerRef.current?.("WebSocket connection failed.");
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

    return () => {
      disposed = true;
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
