import type { V2GoalRoutingCandidateSet } from "../v2/types"

export const GOAL_ROUTER_SYSTEM_PROMPT = [
  "You are Socrates' Goal Router Agent for one persistent Flow.",
  "Choose use for one listed focus or create when none fits. The backend handles whether a selected focus is current or resumed.",
  "The singleton General Conversation absorbs greetings, weather, recommendations, and other casual one-off talk; durable work gets its own focus.",
  "Treat the current focus as a candidate, not a default: use it only when the latest request advances, revises, or follows up on the same desired outcome or work product.",
  "A request that reviews, summarizes, reconciles, or asks about the active conversation, its work log, its earlier decisions, or what was just being done is a follow-up on the current focus; do not create a separate focus merely because the requested output is a summary or retrospective.",
  "Create a new focus for a separate outcome, deliverable, or body of work even when it appears mid-conversation or begins with ordinary transitions such as while we are here, also, or before that.",
  "Reuse a completed focus only when the user actually returns to that outcome; never decide from keyword or phrase matching.",
  "Use clarify only when at least two listed focuses are genuinely plausible, recent turns do not resolve it, and choosing wrong would materially matter.",
  "Candidates are numbered human-facing cards. Return their numbers, never internal ids.",
  "For use return exactly one candidate and title null. For create return no candidates and a short human-facing title. For clarify return two to five candidates and title null.",
  "Prefer the current focus when uncertainty is harmless.",
  "Return only the strict structured result. Do not return analysis, hidden reasoning, or chain of thought.",
].join(" ")

export type GoalRouterPromptInput = Readonly<{
  userMessage: string
  clarificationAnswer?: string
  recentTurns?: readonly Readonly<{ goalId?: string; user: string; assistant: string }>[]
  candidates: V2GoalRoutingCandidateSet
}>

export const buildGoalRouterUserContent = (input: GoalRouterPromptInput): string =>
  JSON.stringify({
    userMessage: truncate(input.userMessage, 6_000),
    ...(input.clarificationAnswer ? { clarificationAnswer: truncate(input.clarificationAnswer, 2_000) } : {}),
    recentTurns: (input.recentTurns ?? []).slice(-3).map((turn) => ({
      ...(turn.goalId ? { goalId: turn.goalId } : {}),
      user: truncate(turn.user, 600),
      assistant: truncate(turn.assistant, 800),
    })),
    currentCandidate: input.candidates.foreground?.candidate ?? null,
    candidates: input.candidates.candidates.map((candidate) => ({
      candidate: candidate.candidate,
      status: candidate.goal.status,
      title: truncate(candidate.goal.title, 180),
      note: truncate(candidate.capsule?.summary ?? candidate.goal.summary ?? "", 600),
    })),
  })

const truncate = (value: string, maxLength: number): string => value.length <= maxLength ? value : value.slice(0, maxLength)
