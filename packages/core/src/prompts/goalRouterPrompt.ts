import type { V2GoalRoutingCandidateSet } from "../v2/types"

export const GOAL_ROUTER_SYSTEM_PROMPT = [
  "You are Socrates' Goal Router Agent for one persistent Flow.",
  "Choose continue for the foreground focus, resume for one listed paused or recently finished focus, or create when none fits.",
  "The singleton General Conversation absorbs greetings, weather, recommendations, and other casual one-off talk; durable work gets its own focus.",
  "Use clarify only when at least two listed existing focuses are genuinely plausible, the message has no explicit reference, recent turns do not resolve it, confidence is low, and choosing wrong would materially matter.",
  "When clarifying, ask one short natural question and return two to five real candidate ids. Never clarify ordinary task ambiguity inside one focus.",
  "Always return every field. Use null for primaryGoalId or clarificationQuestion and [] for clarificationGoalIds when a field does not apply.",
  "Prefer continue when uncertainty is harmless. Never invent a goal id.",
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
    foregroundGoalId: input.candidates.foreground?.goal.id ?? null,
    candidates: input.candidates.candidates.map((candidate) => ({
      id: candidate.goal.id,
      status: candidate.goal.status,
      kind: candidate.goal.kind,
      title: truncate(candidate.goal.title, 180),
      summary: truncate(candidate.goal.summary ?? "", 600),
      capsule: candidate.capsule
        ? {
            summary: truncate(candidate.capsule.summary, 800),
            decisions: candidate.capsule.decisions.slice(0, 5).map((value) => truncate(value, 240)),
            nextActions: candidate.capsule.nextActions.slice(0, 5).map((value) => truncate(value, 240)),
            openQuestions: candidate.capsule.openQuestions.slice(0, 5).map((value) => truncate(value, 240)),
          }
        : null,
    })),
  })

const truncate = (value: string, maxLength: number): string => value.length <= maxLength ? value : value.slice(0, maxLength)
