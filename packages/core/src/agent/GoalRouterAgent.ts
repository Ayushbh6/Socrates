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
  maxSecondaryGoalLinks: number
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
      schema: createValidatedGoalRouterOutputSchema(input.candidates, input.maxSecondaryGoalLinks),
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

const createValidatedGoalRouterOutputSchema = (
  candidates: V2GoalRoutingCandidateSet,
  maxSecondaryGoalLinks: number,
) => {
  const candidateById = new Map(candidates.candidates.map((candidate) => [candidate.goal.id, candidate]))
  return v2GoalRouterOutputSchema.superRefine((value, context) => {
    const primaryGoalId = value.primaryGoalId ?? undefined
    if (value.action === "continue" && (!primaryGoalId || candidates.foreground?.goal.id !== primaryGoalId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["primaryGoalId"], message: "Continue must target the foreground goal." })
    }
    if (value.action === "resume" && (!primaryGoalId || !candidates.parked.some((candidate) => candidate.goal.id === primaryGoalId))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["primaryGoalId"], message: "Resume must target one listed parked goal." })
    }
    if (value.action === "create" && primaryGoalId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["primaryGoalId"], message: "Create cannot target an existing goal." })
    }
    if (value.action === "clarify") {
      if (!value.clarificationQuestion?.trim()) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["clarificationQuestion"], message: "Clarify requires one question." })
      }
      const ids = uniqueStrings(value.clarificationGoalIds).filter((id) => candidateById.has(id))
      if (ids.length < 2 || ids.length !== value.clarificationGoalIds.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["clarificationGoalIds"], message: "Clarify requires two to five unique listed goal ids." })
      }
    } else if (value.clarificationQuestion !== null || value.clarificationGoalIds.length > 0) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["clarificationQuestion"], message: "Non-clarify actions must clear clarification fields." })
    }
    const secondaryIds = uniqueStrings(value.secondaryGoalIds)
    if (
      secondaryIds.length !== value.secondaryGoalIds.length ||
      secondaryIds.length > maxSecondaryGoalLinks ||
      secondaryIds.some((id) => id === primaryGoalId || !candidateById.has(id))
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["secondaryGoalIds"], message: "Secondary goal ids must be unique listed non-primary goals within the configured limit." })
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

const uniqueStrings = (values: readonly string[]): string[] => [...new Set(values)]
