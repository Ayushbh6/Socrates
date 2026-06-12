import type {
  ApplyPatchToolOutput,
  BashToolOutput,
  EditToolOutput,
  ListProjectResourcesToolOutput,
  ProjectDocsToolInput,
  ProjectDocsToolOutput,
  ReadToolOutput,
  RepoDocsToolInput,
  RepoDocsToolOutput,
  SearchToolOutput,
  SkillsToolInput,
  SkillsToolOutput,
  SoulToolInput,
  SoulToolOutput,
  ToolDocsToolInput,
  ToolDocsToolOutput,
  TraceRetrieveToolInput,
  TraceRetrieveToolOutput,
} from "@socrates/contracts"
import type { ToolExecutors } from "@socrates/core"
import { SocratesError } from "@socrates/shared"

export type MemoryAgentToolCallbacks = {
  traceRetrieve: (input: TraceRetrieveToolInput) => Promise<TraceRetrieveToolOutput> | TraceRetrieveToolOutput
  toolDocs: (input: ToolDocsToolInput) => Promise<ToolDocsToolOutput> | ToolDocsToolOutput
  skills: (input: SkillsToolInput) => Promise<SkillsToolOutput> | SkillsToolOutput
  projectDocs: (input: ProjectDocsToolInput) => Promise<ProjectDocsToolOutput> | ProjectDocsToolOutput
  repoDocs: (input: RepoDocsToolInput) => Promise<RepoDocsToolOutput> | RepoDocsToolOutput
  soul: (input: SoulToolInput) => Promise<SoulToolOutput> | SoulToolOutput
}

export const createMemoryAgentToolExecutors = (tools: MemoryAgentToolCallbacks): ToolExecutors => {
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
