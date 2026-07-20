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
