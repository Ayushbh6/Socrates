import { describe, expect, it } from "vitest"
import { normalizeAiSdkToolCallPart, toAiModelMessage } from "../ai-sdk/AiSdkProvider"

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

  it("passes provider metadata back on assistant tool-call messages", () => {
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
          providerMetadata: { google: { thoughtSignature: "sig_1" } },
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
})
