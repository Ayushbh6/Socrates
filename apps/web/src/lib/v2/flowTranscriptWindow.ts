import type { Message } from "@socrates/contracts";

export const flowMessageTurnKey = (message: Message): string => message.turnId ?? `message:${message.id}`;

export const countFlowTurns = (messages: Message[]): number => {
  let count = 0;
  let previousKey: string | undefined;
  for (const message of messages) {
    const key = flowMessageTurnKey(message);
    if (key !== previousKey) {
      count += 1;
      previousKey = key;
    }
  }
  return count;
};

export const sliceLatestFlowTurns = (messages: Message[], turnCount: number): Message[] => {
  if (messages.length === 0) return messages;
  const orderedTurnKeys: string[] = [];
  for (const message of messages) {
    const key = flowMessageTurnKey(message);
    if (orderedTurnKeys.at(-1) !== key) orderedTurnKeys.push(key);
  }
  const visibleKeys = new Set(orderedTurnKeys.slice(-Math.max(1, turnCount)));
  const firstVisibleIndex = messages.findIndex((message) => visibleKeys.has(flowMessageTurnKey(message)));
  return firstVisibleIndex < 0 ? messages : messages.slice(firstVisibleIndex);
};

export interface FlowExchange {
  key: string;
  turnId?: string;
  messages: Message[];
  userMessage?: Message;
  assistantMessage?: Message;
  label: string;
  createdAt: string;
}

const compactExchangeLabel = (content: string): string => {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "Untitled request";
  return normalized.length > 72 ? `${normalized.slice(0, 69).trimEnd()}…` : normalized;
};

export const groupFlowExchanges = (messages: Message[]): FlowExchange[] => {
  const exchanges: FlowExchange[] = [];
  const exchangeByKey = new Map<string, FlowExchange>();

  for (const message of messages) {
    const key = flowMessageTurnKey(message);
    let exchange = exchangeByKey.get(key);
    if (!exchange) {
      exchange = {
        key,
        turnId: message.turnId,
        messages: [],
        label: "Untitled request",
        createdAt: message.createdAt,
      };
      exchangeByKey.set(key, exchange);
      exchanges.push(exchange);
    }
    exchange.messages.push(message);
    if (message.role === "user" && !exchange.userMessage) {
      exchange.userMessage = message;
      exchange.label = compactExchangeLabel(message.content);
      exchange.createdAt = message.createdAt;
    } else if (message.role === "assistant") {
      exchange.assistantMessage = message;
    }
  }

  return exchanges;
};

export const selectFlowExchange = (
  messages: Message[],
  selectedTurnId?: string | null,
  activeTurnId?: string,
): FlowExchange | undefined => {
  const exchanges = groupFlowExchanges(messages);
  if (selectedTurnId) {
    const selected = exchanges.find((exchange) => exchange.turnId === selectedTurnId || exchange.key === selectedTurnId);
    if (selected) return selected;
  }
  if (activeTurnId) {
    const active = exchanges.find((exchange) => exchange.turnId === activeTurnId);
    if (active) return active;
  }
  return exchanges.at(-1);
};
