import type {
  V2Approval,
  V2CredentialInputRequest,
  V2Feedback,
  V2FlowSnapshot,
  V2Message,
  V2MessageWindow,
  V2GoalRoutingRun,
  V2ServerEvent,
  V2Terminal,
  V2ToolCall,
} from "@socrates/contracts";
import { V2_FLOW_SNAPSHOT_MESSAGE_LIMIT } from "@socrates/contracts";

export interface V2StreamingMessage {
  answer: string;
  reasoning: string;
  modelCallId?: string;
  turnId?: string;
}

export interface V2FlowRuntimeState {
  snapshot: V2FlowSnapshot;
  streams: Record<string, V2StreamingMessage>;
  toolCalls: Record<string, V2ToolCall>;
  approvals: Record<string, V2Approval>;
  terminals: Record<string, V2Terminal>;
  terminalOutputs: Record<string, V2TerminalOutputChunk[]>;
  credentialRequests: Record<string, V2CredentialInputRequest>;
  feedbackByMessageId: Record<string, V2Feedback>;
  pendingClarification?: V2GoalRoutingRun;
  lastRuntimeError: string | null;
}

export type V2TerminalOutputChunk = Extract<V2ServerEvent, { type: "v2.terminal.output" }>["payload"];

export type V2FlowRuntimeAction =
  | { type: "hydrate"; snapshot: V2FlowSnapshot }
  | { type: "prepend_messages"; messages: V2Message[]; messageWindow: V2MessageWindow }
  | { type: "event"; event: V2ServerEvent }
  | { type: "clear_error" };

export const initialV2FlowRuntimeState = (snapshot: V2FlowSnapshot): V2FlowRuntimeState => ({
  snapshot,
  streams: {},
  toolCalls: {},
  approvals: Object.fromEntries(snapshot.pendingApprovals.map((approval) => [approval.id, approval])),
  terminals: Object.fromEntries(snapshot.activeTerminals.map((terminal) => [terminal.id, terminal])),
  terminalOutputs: {},
  credentialRequests: {},
  feedbackByMessageId: {},
  ...(snapshot.pendingClarification ? { pendingClarification: snapshot.pendingClarification } : {}),
  lastRuntimeError: null,
});

const upsertById = <T extends { id: string }>(items: T[], item: T): T[] => {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
};

const sortMessages = (messages: V2Message[]): V2Message[] =>
  [...messages].sort((left, right) => left.ordinal - right.ordinal || left.createdAt.localeCompare(right.createdAt));

const mergeMessages = (left: V2Message[], right: V2Message[]): V2Message[] => {
  const byId = new Map(left.map((message) => [message.id, message]));
  for (const message of right) byId.set(message.id, message);
  return sortMessages([...byId.values()]);
};

const withMessage = (snapshot: V2FlowSnapshot, message: V2Message): V2FlowSnapshot => {
  const messages = sortMessages(upsertById(snapshot.messages, message));
  const clientExpandedHistory = snapshot.messages.length > V2_FLOW_SNAPSHOT_MESSAGE_LIMIT;
  if (clientExpandedHistory || messages.length <= V2_FLOW_SNAPSHOT_MESSAGE_LIMIT) {
    return { ...snapshot, messages };
  }
  const bounded = messages.slice(-V2_FLOW_SNAPSHOT_MESSAGE_LIMIT);
  return {
    ...snapshot,
    messages: bounded,
    messageWindow: {
      hasEarlier: true,
      beforeOrdinal: bounded[0]!.ordinal,
    },
  };
};

const mergeAuthoritativeSnapshot = (
  current: V2FlowSnapshot,
  incoming: V2FlowSnapshot,
): V2FlowSnapshot => {
  const currentOldest = current.messages[0]?.ordinal;
  const incomingOldest = incoming.messages[0]?.ordinal;
  if (currentOldest === undefined || incomingOldest === undefined || currentOldest >= incomingOldest) return incoming;
  return {
    ...incoming,
    messages: mergeMessages(current.messages, incoming.messages),
    messageWindow: current.messageWindow,
  };
};

export function v2FlowRuntimeReducer(
  state: V2FlowRuntimeState,
  action: V2FlowRuntimeAction,
): V2FlowRuntimeState {
  if (action.type === "hydrate") {
    return initialV2FlowRuntimeState(action.snapshot);
  }
  if (action.type === "prepend_messages") {
    return {
      ...state,
      snapshot: {
        ...state.snapshot,
        messages: mergeMessages(action.messages, state.snapshot.messages),
        messageWindow: action.messageWindow,
      },
    };
  }
  if (action.type === "clear_error") {
    return { ...state, lastRuntimeError: null };
  }

  const event = action.event;
  switch (event.type) {
    case "v2.connection.ready":
      return state;
    case "v2.flow.snapshot":
      return {
        ...state,
        snapshot: mergeAuthoritativeSnapshot(state.snapshot, event.payload.snapshot),
        approvals: {
          ...state.approvals,
          ...Object.fromEntries(event.payload.snapshot.pendingApprovals.map((approval) => [approval.id, approval])),
        },
        terminals: {
          ...state.terminals,
          ...Object.fromEntries(event.payload.snapshot.activeTerminals.map((terminal) => [terminal.id, terminal])),
        },
        lastRuntimeError: null,
        ...(event.payload.snapshot.pendingClarification
          ? { pendingClarification: event.payload.snapshot.pendingClarification }
          : { pendingClarification: undefined }),
      };
    case "v2.turn.started":
      return {
        ...state,
        snapshot: {
          ...withMessage(state.snapshot, event.payload.userMessage),
          activeTurn: event.payload.turn,
        },
        lastRuntimeError: null,
      };
    case "v2.turn.updated": {
      const terminal = ["completed", "failed", "cancelled"].includes(event.payload.turn.status);
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          ...(terminal ? { activeTurn: undefined } : { activeTurn: event.payload.turn }),
        },
      };
    }
    case "v2.terminal.output": {
      const current = state.terminalOutputs[event.payload.terminalId] ?? [];
      if (current.some((chunk) => chunk.sequence === event.payload.sequence)) return state;
      const next = [...current, event.payload]
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-300);
      return {
        ...state,
        terminalOutputs: {
          ...state.terminalOutputs,
          [event.payload.terminalId]: next,
        },
      };
    }
    case "v2.message.delta": {
      const current = state.streams[event.payload.messageId] ?? { answer: "", reasoning: "" };
      return {
        ...state,
        streams: {
          ...state.streams,
          [event.payload.messageId]: {
            ...current,
            ...(event.turnId ? { turnId: event.turnId } : {}),
            [event.payload.channel]: `${current[event.payload.channel]}${event.payload.text}`,
            ...(event.payload.modelCallId ? { modelCallId: event.payload.modelCallId } : {}),
          },
        },
      };
    }
    case "v2.message.completed": {
      const streams = { ...state.streams };
      delete streams[event.payload.message.id];
      for (const [messageId, stream] of Object.entries(streams)) {
        if (event.payload.message.turnId && stream.turnId === event.payload.message.turnId) {
          delete streams[messageId];
        }
      }
      return {
        ...state,
        snapshot: withMessage(state.snapshot, event.payload.message),
        streams,
      };
    }
    case "v2.goal.routed": {
      if (!event.payload.goal) return state;
      const goals = upsertById(state.snapshot.goals, event.payload.goal).sort((left, right) => left.ordinal - right.ordinal);
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          goals,
          ...(event.payload.goal.status === "foreground"
            ? {
                foregroundGoal: event.payload.goal,
                flow: { ...state.snapshot.flow, foregroundGoalId: event.payload.goal.id },
              }
            : {}),
        },
      };
    }
    case "v2.routing.clarification.requested":
      return {
        ...state,
        pendingClarification: event.payload.routingRun,
        snapshot: withMessage(state.snapshot, event.payload.message),
      };
    case "v2.routing.clarification.resolved":
      return {
        ...state,
        pendingClarification: undefined,
        snapshot: withMessage(state.snapshot, event.payload.answerMessage),
      };
    case "v2.goal.transitioned": {
      const goal = event.payload.goal;
      const goals = upsertById(state.snapshot.goals, goal).sort((left, right) => left.ordinal - right.ordinal);
      const isForeground = goal.status === "foreground";
      const wasForeground = state.snapshot.flow.foregroundGoalId === goal.id;
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          goals,
          ...(isForeground ? { foregroundGoal: goal } : wasForeground ? { foregroundGoal: undefined } : {}),
          flow: {
            ...state.snapshot.flow,
            ...(isForeground
              ? { foregroundGoalId: goal.id }
              : wasForeground
                ? { foregroundGoalId: undefined }
                : {}),
          },
        },
      };
    }
    case "v2.goal.capsule.updated":
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          latestCapsules: upsertById(state.snapshot.latestCapsules, event.payload.capsule),
        },
      };
    case "v2.tool.call.updated":
      return {
        ...state,
        toolCalls: { ...state.toolCalls, [event.payload.toolCall.id]: event.payload.toolCall },
      };
    case "v2.approval.updated": {
      const approval = event.payload.approval;
      return {
        ...state,
        approvals: { ...state.approvals, [approval.id]: approval },
        snapshot: {
          ...state.snapshot,
          pendingApprovals: approval.status === "pending"
            ? upsertById(state.snapshot.pendingApprovals, approval)
            : state.snapshot.pendingApprovals.filter((candidate) => candidate.id !== approval.id),
        },
      };
    }
    case "v2.feedback.updated":
      return {
        ...state,
        feedbackByMessageId: {
          ...state.feedbackByMessageId,
          [event.payload.feedback.messageId]: event.payload.feedback,
        },
      };
    case "v2.credential.input.requested":
      return {
        ...state,
        credentialRequests: {
          ...state.credentialRequests,
          [event.payload.request.id]: event.payload.request,
        },
      };
    case "v2.credential.input.resolved": {
      const credentialRequests = { ...state.credentialRequests };
      delete credentialRequests[event.payload.request.id];
      return { ...state, credentialRequests };
    }
    case "v2.terminal.updated": {
      const terminal = event.payload.terminal;
      const active = ["starting", "running", "awaiting_input", "detached"].includes(terminal.status);
      return {
        ...state,
        terminals: { ...state.terminals, [terminal.id]: terminal },
        snapshot: {
          ...state.snapshot,
          activeTerminals: active
            ? upsertById(state.snapshot.activeTerminals, terminal)
            : state.snapshot.activeTerminals.filter((candidate) => candidate.id !== terminal.id),
        },
      };
    }
    case "v2.error.created":
      return { ...state, lastRuntimeError: event.payload.error.message };
    case "v2.context.disposition.updated":
    case "v2.artifact.created":
    case "v2.speech.job.updated":
      return state;
    default:
      // Lifecycle telemetry (routing workers, handover, and compaction) is
      // rendered from the activity feed and does not mutate snapshot state.
      return state;
  }
}

const recentActivityEvent = (event: V2ServerEvent): boolean =>
  event.type === "v2.tool.call.updated"
  || event.type === "v2.approval.updated"
  || event.type === "v2.feedback.updated"
  || event.type === "v2.terminal.updated"
  || event.type === "v2.terminal.output";

export const hydrateV2RecentActivity = (
  state: V2FlowRuntimeState,
  events: V2ServerEvent[],
): V2FlowRuntimeState => {
  const hydrated = events
    .filter(recentActivityEvent)
    .reduce((current, event) => v2FlowRuntimeReducer(current, { type: "event", event }), state);
  // HTTP snapshot hydration remains authoritative for active lifecycle state.
  return { ...hydrated, snapshot: state.snapshot, lastRuntimeError: state.lastRuntimeError };
};
