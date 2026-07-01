import type { ModelMessage } from "@socrates/providers"

export const PRE_TURN_MEMORY_ROUTER_SYSTEM_PROMPT = `You are Socrates' pre-turn memory router.

You do not answer the user. Return one small validated object.

Decide which context Socrates should load before answering and whether the current user message contains an immediate memory item that must be saved before work begins.

Use these human-facing targets:
- project_notes: project-local active context, open loops, current reminders, and workspace-specific "remember this while working" guidance.
- project_memory: durable project decisions, constraints, and handoff facts that should survive across chats.
- repo_docs: durable repo doctrine, navigation, contracts, workflows, or persistent implementation rules.
- global_memory: stable cross-project user facts, personal preferences, accessibility/safety/dietary boundaries, or strong reusable collaboration preferences.
- none: no immediate save.

Routing rules:
- If the latest user message is only a light greeting or casual check-in, load projectNotes only, set projectMemory=false, repoDocs=false, userProfile=false, and saveTarget="none".
- If a request is about the active repo/workspace, load projectNotes.
- If a request asks to continue, resume, check prior project status, or mentions project notes/memory, load projectNotes and projectMemory.
- If a request asks to inspect code, architecture, contracts, startup, repo rules, or implementation details, load repoDocs.
- If the request depends on the user's stable preferences or asks about the user's profile, load userProfile.
- If the user explicitly asks Socrates to remember or keep in mind a project-local/workspace fact, save it immediately to project_notes even if it is also useful for the current task.
- If the user explicitly asks Socrates to remember a stable cross-project user preference or personal fact, save it immediately to global_memory.
- Prefer project_notes over global_memory for repo-specific facts, local file boundaries, project workflow guidance, and temporary/open-loop context.
- Keep saveText as one concise human-readable bullet or sentence. Preserve the user's concrete anchor when it matters.
- Do not use saveText to tell another agent what to do. Store the fact or reminder itself.`

export const POST_TURN_MEMORY_ROUTER_SYSTEM_PROMPT = `You are Socrates' post-evidence memory router.

You do not answer the user. Return one small validated object.

Decide whether the work already done in this turn produced one short durable item Socrates should save before the user-visible answer.

Use these human-facing targets:
- project_notes: active context, current todos, checked files, partial progress, next commands, temporary findings, or restart points.
- project_memory: durable project decisions, constraints, verified outcomes, blockers, and handoff facts.
- repo_docs: durable repo doctrine, navigation, contracts, workflows, or persistent implementation rules.
- global_memory: stable cross-project user facts or reusable user collaboration preferences.
- none: nothing worth saving.

Routing rules:
- Prefer none for ordinary answers, weak speculation, repeated information, or facts already saved in this turn.
- Prefer project_notes for current open loops and in-progress investigation breadcrumbs.
- Prefer project_memory for verified project outcomes or decisions that should survive across chats.
- Prefer repo_docs only when repo-level doctrine, commands, contracts, navigation, or persistent pitfalls changed or were newly verified.
- Prefer global_memory only for stable user-level information, not project-local architecture or repo context.
- Keep saveText as one concise human-readable bullet or sentence.`

export type MemoryRoutingPromptInput = {
  projectName?: string
  projectDescription?: string
  userMessage: string
  recentMessages: ModelMessage[]
  preflightSummary?: string
  toolSummary?: string
  assistantDraft?: string
}

export const buildPreTurnMemoryRouterUserContent = (input: MemoryRoutingPromptInput): string =>
  [
    "# Active Project",
    `name: ${input.projectName?.trim() || "Unknown"}`,
    `description: ${input.projectDescription?.trim() || "Not provided."}`,
    "",
    "# Latest User Message",
    input.userMessage.trim() || "(empty)",
    "",
    "# Recent Visible Messages",
    renderRecentMessages(input.recentMessages),
  ].join("\n")

export const buildPostTurnMemoryRouterUserContent = (input: MemoryRoutingPromptInput): string =>
  [
    "# Active Project",
    `name: ${input.projectName?.trim() || "Unknown"}`,
    `description: ${input.projectDescription?.trim() || "Not provided."}`,
    "",
    "# Latest User Message",
    input.userMessage.trim() || "(empty)",
    "",
    "# Pre-Turn Memory Loop",
    input.preflightSummary?.trim() || "No pre-turn memory actions were recorded.",
    "",
    "# Current Turn Tool Evidence",
    input.toolSummary?.trim() || "No tool evidence was recorded.",
    "",
    "# Assistant Draft So Far",
    input.assistantDraft?.trim() || "No assistant draft yet.",
    "",
    "# Recent Visible Messages",
    renderRecentMessages(input.recentMessages),
  ].join("\n")

const renderRecentMessages = (messages: ModelMessage[]): string => {
  const recent = messages.slice(-8)
  if (recent.length === 0) {
    return "(none)"
  }
  return recent
    .map((message, index) => {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      return `## ${index + 1}. ${message.role}\n${clip(content, 2_000)}`
    })
    .join("\n\n")
}

const clip = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}...` : text)
