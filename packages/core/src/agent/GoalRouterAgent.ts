import { z } from "zod"
import {
  v2GoalRouterOutputSchema,
  type RuntimeConfig,
  type V2GoalRouterOutput,
  type WorkerModelSettings,
} from "@socrates/contracts"
import type { ModelProvider, ModelUsage } from "@socrates/providers"
import { buildGoalRouterUserContent, GOAL_ROUTER_SYSTEM_PROMPT } from "../prompts/goalRouterPrompt"
import { createGoalRouterToolRegistry } from "../tools/registry"
import type { V2GoalRoutingCandidateSet } from "../v2/types"
import { StructuredToolAgentRunner } from "./StructuredToolAgentRunner"

export type GoalRouterAgentModelSettings = Pick<
  WorkerModelSettings,
  "providerId" | "authMode" | "modelId" | "thinkingEnabled" | "thinkingEffort"
>

export type GoalRouterAgentInput = Readonly<{
  modelSettings: GoalRouterAgentModelSettings
  projectId: string
  flowId: string
  turnId: string
  workspacePath: string
  userMessage: string
  candidates: V2GoalRoutingCandidateSet
  recentTurns?: readonly Readonly<{ goalId?: string; user: string; assistant: string }>[]
  clarificationAnswer?: string
  cacheKey?: string
  abortSignal?: AbortSignal
  onUsage?: (usage: ModelUsage) => void
}>

export class GoalRouterAgent {
  private readonly runner = new StructuredToolAgentRunner()

  constructor(private readonly provider: ModelProvider) {}

  async route(input: GoalRouterAgentInput): Promise<V2GoalRouterOutput> {
    const result = await this.runner.run({
      provider: this.provider,
      providerId: input.modelSettings.providerId,
      modelId: input.modelSettings.modelId,
      runtimeConfig: routerRuntimeConfig(input.modelSettings),
      system: GOAL_ROUTER_SYSTEM_PROMPT,
      userContent: buildGoalRouterUserContent({
        userMessage: input.userMessage,
        candidates: input.candidates,
        ...(input.recentTurns ? { recentTurns: input.recentTurns } : {}),
        ...(input.clarificationAnswer ? { clarificationAnswer: input.clarificationAnswer } : {}),
      }),
      schema: createValidatedGoalRouterOutputSchema(input.candidates),
      toolRegistry: createGoalRouterToolRegistry(),
      toolExecutors: {},
      maxToolCalls: 0,
      projectId: input.projectId,
      conversationId: input.flowId,
      sessionId: input.flowId,
      turnId: input.turnId,
      workspacePath: input.workspacePath,
      ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.onUsage ? { onUsage: input.onUsage } : {}),
    })
    return result.output
  }
}

const createValidatedGoalRouterOutputSchema = (candidates: V2GoalRoutingCandidateSet) => {
  const candidateNumbers = new Set(candidates.candidates.map((candidate) => candidate.candidate))
  return v2GoalRouterOutputSchema.superRefine((value, context) => {
    if (value.candidates.some((candidate) => !candidateNumbers.has(candidate))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidates"], message: "Candidates must be unique numbers from the provided list." })
    }
  })
}

const routerRuntimeConfig = (settings: GoalRouterAgentModelSettings): RuntimeConfig => ({
  providerId: settings.providerId,
  authMode: settings.authMode ?? "api_key",
  modelId: settings.modelId,
  thinkingEnabled: settings.thinkingEnabled,
  ...(settings.thinkingEffort ? { thinkingEffort: settings.thinkingEffort } : {}),
  approvalMode: "read_only_auto",
  sandboxMode: "read_only",
})
