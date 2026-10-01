export { createDefaultSocratesAgent, createV2SocratesAgent, findModelOption, listModels } from "./agent/createDefaultSocratesAgent"
export {
  SocratesAgent,
  type SocratesAgentContextPrecomputeInput,
  type SocratesAgentEvent,
  type SocratesAgentTurnInput,
  type StableCachePreludeSnapshot,
} from "./agent/SocratesAgent"
export {
  CompressorAgent,
  type CompressorAgentMode,
  type CompressorAgentModel,
  type CompressorAgentResult,
  type CompressorAgentRunInput,
} from "./agent/CompressorAgent"
export {
  StructuredToolAgentRunner,
  type StructuredToolAgentRunInput,
  type StructuredToolAgentRunResult,
} from "./agent/StructuredToolAgentRunner"
export {
  MemoryRouterAgent,
  type MemoryRouterAgentModelSettings,
  type MemoryRouterPostTurnInput,
  type MemoryRouterPreTurnInput,
} from "./agent/MemoryRouterAgent"
export {
  DEFAULT_COMPRESSOR_MODEL,
  DEFAULT_COMPRESSOR_FALLBACK_MODEL,
  DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS,
  COMPRESSOR_SYSTEM_PROMPT,
  buildCompressorUserMessageContent,
  estimateModelContextTokens,
  estimateTokens,
  prepareContextForModelCall,
  precomputeContextSnapshot,
  type CompleteCompactionSnapshotInput,
  type ContextCompactionLifecycleEvent,
  type ContextCompactionSummary,
  type ContextCompressionThresholds,
  type ContextCompressionRuntime,
  type FailCompactionSnapshotInput,
  type StartCompactionSnapshotInput,
} from "./context/contextCompression"
export { buildSocratesDynamicContext, buildSocratesSystemPrompt, socratesBasePrompt, type SocratesPromptContext } from "./prompts/socratesPrompt"
export { buildMemoryAgentSystemPrompt, memoryAgentBasePrompt, type MemoryAgentPromptContext } from "./prompts/memoryPrompt"
export { buildSkillWriterSystemPrompt, skillWriterBasePrompt, type SkillWriterPromptContext } from "./prompts/skillWriterPrompt"
export {
  SOCRATES_COMPRESSOR_SYSTEM_PROMPT,
  buildSocratesCompressorUserContent,
  renderChatCompactionMarkdown,
  type CompressorTurnInput,
  type SocratesCompressorUserPromptInput,
} from "./prompts/socratesCompressorPrompt"
export {
  MEMORY_AGENT_COMPRESSOR_SYSTEM_PROMPT,
  buildMemoryAgentCompressorUserContent,
  renderMemoryCompactionMarkdown,
  type MemoryAgentCompressorUserPromptInput,
} from "./prompts/memoryAgentCompressorPrompt"
export { createDefaultToolRegistry, createMemoryFinalizationToolRegistry, createMemoryRouterToolRegistry, createMemoryToolRegistry, createSkillWriterToolRegistry, createV2ToolRegistry, ToolRegistry } from "./tools/registry"
export type { ApprovalDecision, ApprovalRequest, ToolExecutorContext, ToolExecutors, ToolLifecycleEvent } from "./tools/types"
export * from "./retrieval"
export * from "./v2"
export { SOCRATES_SURFACES, renderSocratesSurfaceMap, socratesSurface, type SocratesSurface } from "@socrates/contracts"
