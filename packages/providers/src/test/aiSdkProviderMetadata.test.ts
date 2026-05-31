import { describe, expect, it } from "vitest"
import type { Schema } from "ai"
import {
  applyPatchToolInputSchema,
  applyPatchToolModelInputSchema,
  editToolInputSchema,
  editToolModelInputSchema,
  traceRetrieveToolModelInputSchema,
} from "@socrates/contracts"
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

  it("passes OpenAI reasoning metadata back as provider options on assistant reasoning parts", () => {
    expect(
      toAiModelMessage({
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
          },
          {
            type: "tool-call",
            toolCallId: "fc_1",
            toolName: "read",
            input: { path: "README.md" },
            providerMetadata: { openai: { itemId: "fc_item_1" } },
          },
        ],
      }),
    ).toEqual({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "",
          providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
        },
        {
          type: "tool-call",
          toolCallId: "fc_1",
          toolName: "read",
          input: { path: "README.md" },
          providerOptions: { openai: { itemId: "fc_item_1" } },
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

  it("keeps runtime schemas flat while exposing model-friendly schemas", () => {
    const editObject = editToolInputSchema._def.schema
    expect(editObject._def.typeName).toBe("ZodObject")
    expect(editToolModelInputSchema._def.typeName).toBe("ZodUnion")
    expect(editToolModelInputSchema.safeParse({ path: "README.md", content: "new", oldString: "old", newString: "new" }).success).toBe(false)
    expect("operations" in editObject.shape).toBe(false)
    expect(editObject.shape.path).toBeDefined()
    expect(applyPatchToolInputSchema.safeParse({ patch: "--- a/README.md\n+++ b/README.md\n" }).success).toBe(true)
    expect(applyPatchToolInputSchema.safeParse({ patchText: "*** Begin Patch\n*** End Patch" }).success).toBe(true)
    expect(applyPatchToolModelInputSchema._def.typeName).toBe("ZodObject")
    expect(applyPatchToolModelInputSchema.shape.patchText).toBeDefined()
    expect("patch" in applyPatchToolModelInputSchema.shape).toBe(false)
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
      inputSchema: traceRetrieveToolModelInputSchema,
    }) as Schema

    expect(schema.jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    })
    const serialized = JSON.stringify(schema.jsonSchema)
    expect(serialized).not.toContain('"None"')
    expect(serialized).not.toContain('"oneOf"')
    expect(serialized).not.toContain('"anyOf"')
    expect(serialized).toContain("handle")
    expect(serialized).toContain("conversationId")
    expect(serialized).toContain("turnId")
    expect(serialized).toContain("messageId")
    expect(serialized).toContain("toolId")
    expect(serialized).toContain("toolCallId")
    expect(serialized).toContain("conversationLimit")
    expect(serialized).toContain("conversationTitle")
    expect(serialized).toContain("audit")
    expect(serialized).not.toContain("conversationHint")
    expect(serialized).not.toContain("includeRaw")

    await expect(Promise.resolve(schema.validate?.({ query: "screenshot" }))).resolves.toEqual({
      success: true,
      value: { query: "screenshot" },
    })
    await expect(Promise.resolve(schema.validate?.({ query: "terminal output", mode: "audit", include: ["shell"], conversationLimit: 25 }))).resolves.toEqual({
      success: true,
      value: { query: "terminal output", mode: "audit", include: ["shell"], conversationLimit: 25 },
    })
    await expect(Promise.resolve(schema.validate?.({ query: "old decision", mode: "semantic", scope: "project", limit: 8 }))).resolves.toEqual({
      success: true,
      value: { query: "old decision", mode: "semantic", scope: "project", limit: 8 },
    })
    expect((await Promise.resolve(schema.validate?.({ query: "old decision", mode: "semantic", conversationLimit: 25 })))?.success).toBe(false)
    expect((await Promise.resolve(schema.validate?.({ query: "old decision", mode: "combined", conversationLimit: 25 })))?.success).toBe(false)
    expect((await Promise.resolve(schema.validate?.({ query: "README", mode: "exact", include: ["messages"] })))?.success).toBe(false)
    await expect(
      Promise.resolve(
        schema.validate?.({
          query: "previous screenshots",
          command: "",
          paths: [],
          include: [],
          handle: "",
          conversationId: "",
        }),
      ),
    ).resolves.toEqual({
      success: true,
      value: { query: "previous screenshots" },
    })
    await expect(
      Promise.resolve(
        schema.validate?.({
          query: "previous screenshots",
          conversationId: "conv_1",
          messageId: "msg_1",
          mode: "exact",
        }),
      ),
    ).resolves.toEqual({
      success: true,
      value: { operation: "inspect", messageId: "msg_1" },
    })
    await expect(Promise.resolve(schema.validate?.({ messageId: "msg_1" }))).resolves.toEqual({
      success: true,
      value: { operation: "inspect", messageId: "msg_1" },
    })
    await expect(Promise.resolve(schema.validate?.({ mode: "audit", toolId: "tcall_1" }))).resolves.toEqual({
      success: true,
      value: { operation: "inspect", toolCallId: "tcall_1" },
    })
    expect((await Promise.resolve(schema.validate?.({ toolId: "tcall_1" })))?.success).toBe(false)
    const invalid = await Promise.resolve(schema.validate?.({ operation: "inspect" }))
    expect(invalid?.success).toBe(false)
    await expect(Promise.resolve(schema.validate?.({ operation: "inspect", messageId: "msg_1" }))).resolves.toEqual({
      success: true,
      value: { operation: "inspect", messageId: "msg_1" },
    })
    await expect(
      Promise.resolve(
        schema.validate?.({
          operation: "inspect",
          messageId: "msg_1",
          scope: "project",
          mode: "exact",
          conversationLimit: 25,
        }),
      ),
    ).resolves.toEqual({
      success: true,
      value: { operation: "inspect", messageId: "msg_1" },
    })
  })
})
