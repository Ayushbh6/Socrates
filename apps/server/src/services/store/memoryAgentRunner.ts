import type {
  ApplyPatchToolOutput,
  BashToolOutput,
  EditToolOutput,
  ListProjectResourcesToolOutput,
  ProviderId,
  ProjectDocsToolInput,
  ProjectDocsToolOutput,
  ReadToolOutput,
  RepoDocsToolInput,
  RepoDocsToolOutput,
  RuntimeConfig,
  SearchToolOutput,
  SkillsToolInput,
  SkillsToolOutput,
  SoulToolInput,
  SoulToolOutput,
  ToolDocsToolInput,
  ToolDocsToolOutput,
  TraceRetrieveToolInput,
  TraceRetrieveToolOutput,
  ThinkingEffort,
} from "@socrates/contracts"
import { createMemoryToolRegistry, SocratesAgent, type ToolExecutors } from "@socrates/core"
import type { ModelProvider } from "@socrates/providers"
import { SocratesError } from "@socrates/shared"

const MEMORY_AGENT_RUNTIME_CONFIG = (input: MemoryAgentModelSettings): RuntimeConfig => ({
  providerId: input.providerId,
  modelId: input.modelId,
  thinkingEnabled: input.thinkingEnabled,
  ...(input.thinkingEffort ? { thinkingEffort: input.thinkingEffort } : {}),
  approvalMode: "read_only_auto",
  sandboxMode: "read_only",
})

export type MemoryAgentModelSettings = {
  providerId: ProviderId
  modelId: string
  thinkingEnabled: boolean
  thinkingEffort?: ThinkingEffort
}

export type MemoryAgentRunInput = {
  provider: ModelProvider
  modelSettings: MemoryAgentModelSettings
  evidence: string
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  workspacePath?: string
  socratesHome: string
  tools: MemoryAgentToolCallbacks
}

export type MemoryAgentToolCallbacks = {
  traceRetrieve: (input: TraceRetrieveToolInput) => Promise<TraceRetrieveToolOutput> | TraceRetrieveToolOutput
  toolDocs: (input: ToolDocsToolInput) => Promise<ToolDocsToolOutput> | ToolDocsToolOutput
  skills: (input: SkillsToolInput) => Promise<SkillsToolOutput> | SkillsToolOutput
  projectDocs: (input: ProjectDocsToolInput) => Promise<ProjectDocsToolOutput> | ProjectDocsToolOutput
  repoDocs: (input: RepoDocsToolInput) => Promise<RepoDocsToolOutput> | RepoDocsToolOutput
  soul: (input: SoulToolInput) => Promise<SoulToolOutput> | SoulToolOutput
}

export const MEMORY_AGENT_SYSTEM_PROMPT = [
  "You are the Socrates backend memory agent. You maintain Socrates memory after user turns; you are not the chat assistant.",
  "You are a real tool-using agent. Read before you patch. Use trace_retrieve when older conversation/tool evidence would make a memory update more reliable.",
  "Available tools: trace_retrieve for prior conversation/tool evidence; tool_docs for global tool guidance; skills for existing reusable skills; project_docs and repo_docs for read/search project context; soul for identity and operating principles.",
  "Do not call write/edit/shell tools. Project docs and repo docs are read/search only for this worker. Your final JSON patch proposals are the only write channel.",
  "Return exactly one JSON object and no markdown fence, prose, prefix, or suffix.",
  "Allowed top-level keys: no_op, skillPatches, toolUsageDocPatches, soulPatchProposals.",
  "If there is no durable learning, return {\"no_op\":true}.",
  "skillPatches, toolUsageDocPatches, and soulPatchProposals are arrays of patch objects.",
  "Patch object schema: {\"path\": optional string, \"document\": optional \"identity\"|\"operating_principles\", \"expectedBeforeHash\": optional sha256, \"oldText\": exact existing text, \"newText\": replacement text, \"rationale\": short reason, \"sourceTurnIds\": array of source turn ids}.",
  "Patch oldText must be copied exactly from the current target text. Use small, unique oldText spans. Prefer no_op over broad rewrites.",
  "Only propose patches when the evidence clearly supports a durable memory update. Prefer no_op over speculative edits.",
  "Never include secrets, credentials, private keys, long verbatim quotes, or sensitive user data. Redact them if they appear in evidence.",
  "Never invent identity changes. Soul proposals must be rare, narrow, evidence-backed, and appropriate for long-lived identity or operating principles.",
  "Soul patches must preserve the target document's markdown section structure. Add or adjust bullets inside the best matching section instead of replacing the file.",
  "Tool-usage docs should explain exact usage patterns, common mistakes, and investigation workflows in polished markdown.",
  "Skills should be reusable cross-project lessons in Agent Skills format. Prefer topic folders such as skills/release-workflows/SKILL.md, skills/frontend-debugging/SKILL.md, or skills/memory-and-retrieval/SKILL.md.",
  "Every SKILL.md patch must preserve YAML frontmatter with name and description and keep the body concise.",
  "Do not write project MEMORY, PROJECT_NOTES, repo_docs, diary entries, or project skills.",
].join("\n")

export const runMemoryAgentTurn = async (input: MemoryAgentRunInput): Promise<string> => {
  const agent = new SocratesAgent(input.provider, createMemoryToolRegistry())
  const runtimeConfig = MEMORY_AGENT_RUNTIME_CONFIG(input.modelSettings)
  let text = ""
  for await (const event of agent.streamTurn({
    projectId: input.projectId,
    conversationId: input.conversationId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    providerId: input.modelSettings.providerId,
    modelId: input.modelSettings.modelId,
    runtimeConfig,
    messages: [{ role: "user", content: input.evidence }],
    systemPromptOverride: MEMORY_AGENT_SYSTEM_PROMPT,
    workspacePath: input.workspacePath ?? input.socratesHome,
    toolExecutors: memoryAgentToolExecutors(input.tools),
    requestApproval: async () => ({
      decision: "rejected",
      reason: "Backend memory agent is read-only while gathering evidence; writes must be returned as validated patch proposals.",
    }),
    maxToolCallsPerTurn: 60,
    maxParallelToolCalls: 4,
    maxConfirmedToolErrorsPerTurn: 8,
  })) {
    if (event.type === "model.answer.delta") {
      text += event.text
    }
    if (event.type === "model.failed") {
      throw event.error
    }
  }
  return text
}

const memoryAgentToolExecutors = (tools: MemoryAgentToolCallbacks): ToolExecutors => {
  const unavailable = async <T>(): Promise<T> => {
    throw new SocratesError("memory_agent_tool_unavailable", "This tool is not available to the backend memory agent.", { recoverable: true })
  }
  return {
    read: () => unavailable<ReadToolOutput>(),
    search: () => unavailable<SearchToolOutput>(),
    edit: () => unavailable<EditToolOutput>(),
    apply_patch: () => unavailable<ApplyPatchToolOutput>(),
    bash: () => unavailable<BashToolOutput>(),
    trace_retrieve: async (input) => tools.traceRetrieve(input),
    tool_docs: async (input) => tools.toolDocs(input),
    skills: async (input) => tools.skills(input),
    project_docs: async (input) => {
      if (input.operation === "edit") {
        throw new SocratesError("memory_agent_project_docs_read_only", "The backend memory agent may only read/search project docs.", { recoverable: true })
      }
      return tools.projectDocs(input)
    },
    repo_docs: async (input) => {
      if (input.operation === "edit") {
        throw new SocratesError("memory_agent_repo_docs_read_only", "The backend memory agent may only read/search repo docs.", { recoverable: true })
      }
      return tools.repoDocs(input)
    },
    soul: async (input) => tools.soul(input),
    list_project_resources: () => unavailable<ListProjectResourcesToolOutput>(),
  }
}
