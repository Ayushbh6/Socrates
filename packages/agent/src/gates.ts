import type { CallTrace, DecisionQuestion, DeciderClient } from "@socrates/contracts";
import { RETRY_AFTER_MS } from "@socrates/retrieval";
import { abortable } from "@socrates/shared";

/**
 * The memory gates (agent-harness.md, "Memory"): one request to the decider
 * for each user message, with two yes/no questions. The decider only says how
 * likely each is; the agent still decides what to do. A gate is never needed:
 * without a key, past a timeout, or after a failure, the turn goes on as if it
 * had not been asked.
 */

/** At or above this chance that remembered information would help, the candidates are searched more widely. */
export const RECALL_AT = 0.5;
/** At or above this chance, and with nothing found, the agent is told to look before it guesses or asks. */
export const RECALL_STRONG_AT = 0.85;
/** At or above this chance that the message states something lasting, the agent is reminded it can save. */
export const SAVE_AT = 0.4;

/** A decision slower than this is dropped for this turn. */
export const GATE_TIMEOUT_MS = 2_000;
/** What is sent: the message and the previous answer, cut short. */
export const GATE_MESSAGE_CHARS = 2_000;
export const GATE_ANSWER_CHARS = 800;

export const GATE_QUESTIONS = {
  recall: {
    instructions: "Would the assistant answer the user's latest message noticeably better if it first looked up what it already knows about this user: their personal facts, preferences, habits, past decisions or earlier conversations? Answer yes only when the message refers to, or depends on, something about the user or the past that is not in the message itself.",
    yes: "The reply depends on remembered information about the user or an earlier conversation.",
    no: "The message is self-contained, or about the current work only.",
  },
  save: {
    instructions: "Does the user, in their latest message, state a lasting fact about themselves, a standing preference or rule for how the assistant should work, a decision that has been made, or a correction of the assistant, that would still matter in future conversations?",
    yes: "A durable personal fact, standing preference or rule, decision, or correction.",
    no: "A one-off request, a question, a reaction, or something relevant only to this moment.",
  },
} as const satisfies Record<string, DecisionQuestion>;

/** What is asked of a finished turn (agent-harness.md, "Work memory"): is it worth writing down for the project? */
export const WORK_QUESTION = {
  instructions: "The assistant just finished a piece of work for the user in a software project. Did the work succeed (its checks passed, or the user's goal was reached) and establish something worth writing down for next time: a repeatable procedure for this project (the steps of a kind of change that will come up again), or a lesson (a surprise or mistake and how it was fixed)? A one-off edit, a question, exploration, and work that failed or is unfinished are not worth writing down.",
  yes: "A verified, repeatable procedure or lesson for this project.",
  no: "A one-off change, a question, exploration, or work that failed or is unfinished.",
} as const satisfies DecisionQuestion;

/** The decider's chance of yes for each question it was asked; null for one that was not. */
export interface GateReading {
  recall: number | null;
  save: number | null;
}

export interface GateInput {
  /** The user's message for this turn. */
  message: string;
  /** The answer this message follows in its chat, if any. */
  previousAnswer: string | null;
  /** Names of the images attached to the message. */
  attachments: string[];
  /** Which questions are worth asking: recall when memories are used, save when they are saved. */
  ask: { recall: boolean; save: boolean };
  trace: CallTrace;
}

const cut = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/** The text the questions are about: the message, with the answer it follows when there is one. */
export function gateState(input: Pick<GateInput, "message" | "previousAnswer" | "attachments">): string {
  const message = cut(input.message.trim(), GATE_MESSAGE_CHARS);
  const images = input.attachments.length ? `\n[Attached: ${input.attachments.slice(0, 5).join(", ")}]` : "";
  const previous = input.previousAnswer?.trim();
  return previous ? `The assistant's previous reply (cut short):\n${cut(previous, GATE_ANSWER_CHARS)}\n\nThe user's latest message:\n${message}${images}` : `${message}${images}`;
}

export class MemoryGate {
  private unavailableUntil = 0;

  constructor(private readonly options: { decider: DeciderClient; timeoutMs?: number; now?: () => number; log?: (message: string) => void }) {}

  /** The reading for one message, or null when nothing was asked, the decider is paused, or it failed or was too slow. Never throws. */
  async read(input: GateInput, signal?: AbortSignal): Promise<GateReading | null> {
    if ((!input.ask.recall && !input.ask.save) || !input.message.trim()) return null;
    const questions = { ...(input.ask.recall ? { recall: GATE_QUESTIONS.recall } : {}), ...(input.ask.save ? { save: GATE_QUESTIONS.save } : {}) };
    const answer = await this.ask(gateState(input), questions, input.trace, signal);
    return answer && { recall: answer.recall ?? null, save: answer.save ?? null };
  }

  /** The chance that a finished turn is worth writing down for the project, or null when it could not be asked. Never throws. */
  async readWork(input: { state: string; trace: CallTrace }, signal?: AbortSignal): Promise<number | null> {
    const answer = await this.ask(input.state, { work: WORK_QUESTION }, input.trace, signal);
    return answer?.work ?? null;
  }

  private async ask(state: string, questions: Record<string, DecisionQuestion>, trace: CallTrace, signal?: AbortSignal): Promise<Record<string, number> | null> {
    const now = (this.options.now ?? Date.now)();
    if (signal?.aborted || now < this.unavailableUntil) return null;
    const limit = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? GATE_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    try {
      // Raced as well as passed down, so a client that ignores the signal cannot hold up the reply.
      return (await abortable(this.options.decider.decide({ state, questions, trace }, limit), limit)).probabilities;
    } catch (error) {
      if (!signal?.aborted) {
        this.unavailableUntil = now + RETRY_AFTER_MS;
        this.options.log?.(`the memory decider failed; skipped for ${RETRY_AFTER_MS / 1000}s: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    }
  }
}
