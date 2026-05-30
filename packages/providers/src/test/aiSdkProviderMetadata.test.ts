import { describe, expect, it } from "vitest"
import type { Schema } from "ai"
import { applyPatchToolInputSchema, editToolInputSchema, editToolModelInputSchema, traceRetrieveToolInputSchema } from "@socrates/contracts"
import { inputSchemaForAiTool, normalizeAiSdkToolCallPart, toAiModelMessage } from "../ai-sdk/AiSdkProvider"

describe("AI SDK provider metadata", () => {
  it("preserves Gemini thought signatures from streamed tool calls", () => {
    expect(
      normalizeAiSdkToolCallPart({
        toolCallId: "call_1",
        toolName: "read",
        input: { path: "README.md" },
        providerMetadata: { google: { thoughtSignature: "sig_1" } },
      }),
    ).toEqual({
      toolCallId: "call_1",
      toolName: "read",
      input: { path: "README.md" },
      providerMetadata: { google: { thoughtSignature: "sig_1" } },
    })
  })

  it("passes provider metadata back as provider options on assistant tool-call messages", () => {
    expect(
      toAiModelMessage({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "read",
            input: { path: "README.md" },
            providerMetadata: { google: { thoughtSignature: "sig_1" } },
          },
        ],
      }),
    ).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "read",
          input: { path: "README.md" },
          providerOptions: { google: { thoughtSignature: "sig_1" } },
        },
      ],
    })
  })

  it("maps Socrates image parts to AI SDK image parts without the data URL prefix", () => {
    expect(
      toAiModelMessage({
        role: "user",
        content: [
          { type: "text", text: "what do you see?" },
          { type: "image", mediaType: "image/png", data: "data:image/png;base64,aGVsbG8=", fileName: "screenshot.png" },
        ],
      }),
    ).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what do you see?" },
        { type: "image", mediaType: "image/png", image: "aGVsbG8=" },
      ],
    })
  })

  it("keeps runtime edit flat while exposing a mutually exclusive model schema", () => {
    const editObject = editToolInputSchema._def.schema
    expect(editObject._def.typeName).toBe("ZodObject")
    expect(editToolModelInputSchema._def.typeName).toBe("ZodUnion")
    expect(editToolModelInputSchema.safeParse({ path: "README.md", content: "new", oldString: "old", newString: "new" }).success).toBe(false)
    expect(applyPatchToolInputSchema._def.typeName).toBe("ZodObject")
    expect("operations" in editObject.shape).toBe(false)
    expect(editObject.shape.path).toBeDefined()
    expect(applyPatchToolInputSchema.shape.patch).toBeDefined()
  })

  it("exposes edit as an object JSON schema for OpenAI-compatible providers", async () => {
    const schema = inputSchemaForAiTool({
      name: "edit",
      description: "Create or modify one file.",
      inputSchema: editToolModelInputSchema,
    }) as Schema

    expect(schema.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["path"],
    })
    expect(JSON.stringify(schema.jsonSchema)).not.toContain('"None"')
    expect(JSON.stringify(schema.jsonSchema)).not.toContain('"anyOf"')
    expect(JSON.stringify(schema.jsonSchema)).not.toContain('"oneOf"')

    await expect(Promise.resolve(schema.validate?.({ path: "README.md", oldString: "old", newString: "new" }))).resolves.toEqual({
      success: true,
      value: { path: "README.md", oldString: "old", newString: "new" },
    })
    await expect(Promise.resolve(schema.validate?.({ path: "README.md", content: "new", overwrite: true }))).resolves.toEqual({
      success: true,
      value: { path: "README.md", content: "new", overwrite: true },
    })
    const invalid = await Promise.resolve(schema.validate?.({ path: "README.md", content: "new", oldString: "old", newString: "new" }))
    expect(invalid?.success).toBe(false)
  })

  it("exposes trace_retrieve as an object JSON schema for strict providers", async () => {
    const schema = inputSchemaForAiTool({
      name: "trace_retrieve",
      description: "Search or inspect previous trace documents.",
      inputSchema: traceRetrieveToolInputSchema,
    }) as Schema

    expect(schema.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    })
    expect(JSON.stringify(schema.jsonSchema)).not.toContain('"None"')

    await expect(Promise.resolve(schema.validate?.({ query: "screenshot" }))).resolves.toEqual({
      success: true,
      value: { query: "screenshot" },
    })
    const invalid = await Promise.resolve(schema.validate?.({ operation: "inspect" }))
    expect(invalid?.success).toBe(false)
  })
})
