import type {
  ApplyPatchToolOutput,
  BashToolOutput,
  EditFilesToolOutput,
  EditToolOutput,
  ListProjectResourcesToolOutput,
  MemoryNoteToolOutput,
  MemoryNotesToolOutput,
  ProjectDocsToolInput,
  ProjectDocsToolOutput,
  ReadToolOutput,
  RepoDocsToolInput,
  RepoDocsToolOutput,
  SearchToolOutput,
  SkillWriteToolInput,
  SkillWriteToolOutput,
  SkillsToolInput,
  SkillsToolOutput,
  SoulToolInput,
  SoulToolOutput,
  TraceRetrieveGlobalToolInput,
  TraceRetrieveGlobalToolOutput,
  UrlFetchToolOutput,
  UserProfileToolInput,
  UserProfileToolOutput,
} from "@socrates/contracts"
import type { ToolExecutors } from "@socrates/core"
import { SocratesError } from "@socrates/shared"
import { currentRuntimeTime } from "./runtimeContext"

export type SkillWriterToolCallbacks = {
  traceRetrieve: (input: TraceRetrieveGlobalToolInput) => Promise<TraceRetrieveGlobalToolOutput> | TraceRetrieveGlobalToolOutput
  skills: (input: SkillsToolInput) => Promise<SkillsToolOutput> | SkillsToolOutput
  soul: (input: SoulToolInput) => Promise<SoulToolOutput> | SoulToolOutput
  userProfile: (input: UserProfileToolInput) => Promise<UserProfileToolOutput> | UserProfileToolOutput
  projectDocs: (input: ProjectDocsToolInput) => Promise<ProjectDocsToolOutput> | ProjectDocsToolOutput
  repoDocs: (input: RepoDocsToolInput) => Promise<RepoDocsToolOutput> | RepoDocsToolOutput
  skillWrite: (input: SkillWriteToolInput) => Promise<SkillWriteToolOutput> | SkillWriteToolOutput
}

export const createSkillWriterToolExecutors = (tools: SkillWriterToolCallbacks): ToolExecutors => {
  const unavailable = async <T>(): Promise<T> => {
    throw new SocratesError("skill_writer_tool_unavailable", "This tool is not available to the Skill Writer Agent.", { recoverable: true })
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
    tool_docs: () => unavailable(),
    skills: async (input) => tools.skills(input),
    project_docs: async (input) => tools.projectDocs(input),
    repo_docs: async (input) => tools.repoDocs(input),
    soul: async (input) => tools.soul(input),
    user_profile: async (input) => tools.userProfile(input),
    list_project_resources: () => unavailable<ListProjectResourcesToolOutput>(),
    edit_files: () => unavailable<EditFilesToolOutput>(),
    memory_note: () => unavailable<MemoryNoteToolOutput>(),
    memory_notes: () => unavailable<MemoryNotesToolOutput>(),
    skill_write: async (input) => tools.skillWrite(input),
  }
}
