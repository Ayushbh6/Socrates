export type SocratesSurface = {
  id:
    | "global_identity"
    | "global_user_profile"
    | "global_skills"
    | "project_memory"
    | "project_notes"
    | "repo_docs"
    | "project_resources"
    | "conversation_attachments"
    | "project_skills"
  path: string
  aliases?: readonly string[]
  purpose: string
  durability: "durable" | "working" | "source_artifact"
  readTool: "soul" | "user_profile" | "skills" | "project_docs" | "repo_docs" | "list_project_resources" | "read"
  writeOwner: "memory_agent" | "skill_writer" | "socrates" | "backend" | "user"
  loadPolicy: "stable_core" | "router" | "on_demand"
  cacheClass: "stable_prefix" | "dynamic"
  mutation: "read_only_main_agent" | "dedicated_tool_only" | "backend_only" | "user_managed"
}

export const SOCRATES_SURFACES = [
  { id: "global_identity", path: "~/.Socrates/identity.md", purpose: "Socrates identity and operating principles", durability: "durable", readTool: "soul", writeOwner: "memory_agent", loadPolicy: "stable_core", cacheClass: "stable_prefix", mutation: "read_only_main_agent" },
  { id: "global_user_profile", path: "~/.Socrates/user_profile.md", purpose: "Cross-project user preferences and context", durability: "durable", readTool: "user_profile", writeOwner: "memory_agent", loadPolicy: "router", cacheClass: "dynamic", mutation: "read_only_main_agent" },
  { id: "global_skills", path: "~/.Socrates/skills/", aliases: ["~/.Socrates/skill/"], purpose: "Reusable cross-project procedures", durability: "durable", readTool: "skills", writeOwner: "skill_writer", loadPolicy: "on_demand", cacheClass: "dynamic", mutation: "read_only_main_agent" },
  { id: "project_memory", path: ".socrates/MEMORY.md", purpose: "Durable project state and standing project rules", durability: "durable", readTool: "project_docs", writeOwner: "socrates", loadPolicy: "router", cacheClass: "dynamic", mutation: "dedicated_tool_only" },
  { id: "project_notes", path: ".socrates/PROJECT_NOTES.md", purpose: "Active project state and open loops", durability: "working", readTool: "project_docs", writeOwner: "socrates", loadPolicy: "router", cacheClass: "dynamic", mutation: "dedicated_tool_only" },
  { id: "repo_docs", path: ".socrates/repo_docs/", purpose: "Durable repository doctrine and contracts", durability: "durable", readTool: "repo_docs", writeOwner: "socrates", loadPolicy: "router", cacheClass: "dynamic", mutation: "dedicated_tool_only" },
  { id: "project_resources", path: ".socrates/resources/", purpose: "User-managed project source material", durability: "source_artifact", readTool: "list_project_resources", writeOwner: "user", loadPolicy: "on_demand", cacheClass: "dynamic", mutation: "user_managed" },
  { id: "conversation_attachments", path: ".socrates/attachments/", purpose: "Conversation images and pasted-text sources", durability: "source_artifact", readTool: "read", writeOwner: "backend", loadPolicy: "on_demand", cacheClass: "dynamic", mutation: "backend_only" },
  { id: "project_skills", path: ".socrates/skills/", aliases: [".socrates/skill/"], purpose: "Reusable project procedures", durability: "durable", readTool: "skills", writeOwner: "skill_writer", loadPolicy: "on_demand", cacheClass: "dynamic", mutation: "read_only_main_agent" },
] as const satisfies readonly SocratesSurface[]

export const socratesSurface = (id: SocratesSurface["id"]): SocratesSurface => {
  const surface = SOCRATES_SURFACES.find((candidate) => candidate.id === id)
  if (!surface) throw new Error(`Unknown Socrates surface: ${id}`)
  return surface
}

export const renderSocratesSurfaceMap = (): string =>
  [
    "<socrates_surface_map>",
    "Use the owning tool; do not scan all surfaces by default.",
    ...SOCRATES_SURFACES.map((surface) => `- ${surface.path}: ${surface.purpose}; read=${surface.readTool}; write=${surface.writeOwner}; load=${surface.loadPolicy}`),
    "</socrates_surface_map>",
  ].join("\n")
