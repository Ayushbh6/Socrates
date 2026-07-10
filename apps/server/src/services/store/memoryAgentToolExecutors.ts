import type {
  ApplyPatchToolOutput,
  BashToolOutput,
  EditFilesToolInput,
  EditFilesToolOutput,
  EditToolOutput,
  ListProjectResourcesToolOutput,
  MemoryNoteToolOutput,
  MemoryNotesToolInput,
  MemoryNotesToolOutput,
  ProjectsToolInput,
  ProjectsToolOutput,
  ReadToolOutput,
  SearchToolOutput,
  SkillsToolInput,
  SkillsToolOutput,
  SoulToolInput,
  SoulToolOutput,
  ToolDocsToolInput,
  ToolDocsToolOutput,
  TraceRetrieveGlobalToolInput,
  TraceRetrieveGlobalToolOutput,
  UrlFetchToolOutput,
  UserProfileToolInput,
  UserProfileToolOutput,
} from "@socrates/contracts"
import type { ToolExecutors } from "@socrates/core"
import { SocratesError } from "@socrates/shared"
import { currentRuntimeTime } from "./runtimeContext"

export type MemoryAgentToolCallbacks = {
  traceRetrieve: (input: TraceRetrieveGlobalToolInput) => Promise<TraceRetrieveGlobalToolOutput> | TraceRetrieveGlobalToolOutput
  projects: (input: ProjectsToolInput) => Promise<ProjectsToolOutput> | ProjectsToolOutput
  toolDocs: (input: ToolDocsToolInput) => Promise<ToolDocsToolOutput> | ToolDocsToolOutput
  skills: (input: SkillsToolInput) => Promise<SkillsToolOutput> | SkillsToolOutput
  soul: (input: SoulToolInput) => Promise<SoulToolOutput> | SoulToolOutput
  userProfile: (input: UserProfileToolInput) => Promise<UserProfileToolOutput> | UserProfileToolOutput
  memoryNotes: (input: MemoryNotesToolInput) => Promise<MemoryNotesToolOutput> | MemoryNotesToolOutput
  editFiles: (input: EditFilesToolInput) => Promise<EditFilesToolOutput> | EditFilesToolOutput
}

export const createMemoryAgentToolExecutors = (tools: MemoryAgentToolCallbacks): ToolExecutors => {
  const unavailable = async <T>(): Promise<T> => {
    throw new SocratesError("memory_agent_tool_unavailable", "This tool is not available to the backend memory agent.", { recoverable: true })
  }
  return {
    read: () => unavailable<ReadToolOutput>(),
    search: () => unavailable<SearchToolOutput>(),
    url_fetch: () => unavailable<UrlFetchToolOutput>(),
    edit: () => unavailable<EditToolOutput>(),
    apply_patch: () => unavailable<ApplyPatchToolOutput>(),
    bash: () => unavailable<BashToolOutput>(),
    current_time: () => Promise.resolve(currentRuntimeTime()),
    trace_retrieve: async (input) => tools.traceRetrieve(input as TraceRetrieveGlobalToolInput),
    projects: async (input) => tools.projects(input),
    tool_docs: async (input) => tools.toolDocs(input),
    skills: async (input) => tools.skills(input),
    memory_notes: async (input) => tools.memoryNotes(input),
    project_docs: () => unavailable(),
    repo_docs: () => unavailable(),
    soul: async (input) => tools.soul(input),
    user_profile: async (input) => tools.userProfile(input),
    edit_files: async (input) => tools.editFiles(input),
    memory_note: () => unavailable<MemoryNoteToolOutput>(),
    list_project_resources: () => unavailable<ListProjectResourcesToolOutput>(),
  }
}
