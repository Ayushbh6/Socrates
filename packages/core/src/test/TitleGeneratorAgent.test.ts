import { describe, expect, it } from "vitest"
import type { ModelProvider, StructuredModelRequest } from "@socrates/providers"
import { TitleGeneratorAgent } from "../agent/TitleGeneratorAgent"

describe("TitleGeneratorAgent", () => {
  it("uses the shared structured runner with multimodal input, strict repair, and no tools", async () => {
    const requests: StructuredModelRequest<unknown>[] = []
    let streamCalls = 0
    const outputs: unknown[] = [
      { title: "", prose: "invalid extra output" },
      { title: "Goal Router Homogeneity" },
    ]
    const provider: ModelProvider = {
      countTokens: async (request) => ({
        providerId: request.providerId,
        modelId: request.modelId,
        inputTokens: 12,
        baseTokens: 12,
        method: "local_tiktoken",
        safetyMarginPercent: 0,
      }),
      async *stream() {
        streamCalls += 1
        yield { type: "model.completed" }
      },
      async generateStructured<TOutput>(request: StructuredModelRequest<TOutput>) {
        requests.push(request as StructuredModelRequest<unknown>)
        return {
          output: outputs.shift() as TOutput,
          usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        }
      },
    }

    const result = await new TitleGeneratorAgent().run({
      provider,
      modelSettings: {
        providerId: "openrouter",
        authMode: "api_key",
        modelId: "meta-llama/llama-4-maverick",
        thinkingEnabled: false,
      },
      userContent: [
        { type: "text", text: "Make the goal router conform." },
        { type: "image", mediaType: "image/png", data: "data:image/png;base64,AAAA", fileName: "settings.png" },
      ],
      projectId: "proj_1",
      conversationId: "conv_1",
      sessionId: "sess_1",
      turnId: "turn_1",
      workspacePath: "/tmp/socrates-title-test",
    })

    expect(result.output).toEqual({ title: "Goal Router Homogeneity" })
    expect(result.usages).toHaveLength(2)
    expect(streamCalls).toBe(0)
    expect(requests).toHaveLength(2)
    expect(requests[0]).toMatchObject({
      providerId: "openrouter",
      modelId: "meta-llama/llama-4-maverick",
      sessionId: "sess_1",
      providerRouting: { omitReasoning: true },
    })
    expect(requests[0]?.system).toContain("Socrates Title Generator Agent")
    expect(requests[0]?.messages[0]?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image", fileName: "settings.png" }),
    ]))
    expect(JSON.stringify(requests[1]?.messages)).toContain("failed validation")
  })
})
