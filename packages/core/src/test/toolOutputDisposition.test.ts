import { describe, expect, it } from "vitest"
import type { ModelMessage } from "@socrates/providers"
import { ToolOutputDispositionLedger } from "../context/toolOutputDisposition"

describe("ToolOutputDispositionLedger", () => {
  it("distills only the model-facing copy while retaining a retrieval path", () => {
    const toolMessage: ModelMessage = {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call_1",
        toolName: "read",
        output: { ok: true, output: { content: `UNIQUE_EXACT_MARKER ${"evidence ".repeat(6_000)}` } },
      }],
    }
    const messages: ModelMessage[] = [toolMessage]
    const ledger = new ToolOutputDispositionLedger(messages)

    ledger.recordBatch({ message: toolMessage, providerId: "deepseek", modelId: "deepseek-v4-pro" })
    expect(ledger.pendingResults()).toEqual(["result_1"])
    expect(JSON.stringify(messages)).toContain("UNIQUE_EXACT_MARKER")

    const output = ledger.apply({
      decisions: [{ result: "result_1", action: "distill", summary: "The source establishes the governing evidence." }],
    }, true)

    expect(output.piggybacked).toBe(true)
    expect(ledger.pendingResults()).toEqual([])
    expect(JSON.stringify(messages)).not.toContain("UNIQUE_EXACT_MARKER")
    expect(JSON.stringify(messages)).toContain("The source establishes the governing evidence.")
    expect(JSON.stringify(messages)).toContain("trace_retrieve")
  })

  it("ignores small outputs and keeps unresolved substantial outputs visible", () => {
    const small: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "small", toolName: "read", output: { ok: true, output: { content: "small" } } }],
    }
    const large: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "large", toolName: "read", output: { ok: true, output: { content: "large ".repeat(4_000) } } }],
    }
    const messages: ModelMessage[] = [small, large]
    const ledger = new ToolOutputDispositionLedger(messages)

    ledger.recordBatch({ message: small, providerId: "deepseek", modelId: "deepseek-v4-pro" })
    expect(ledger.pendingResults()).toEqual([])
    ledger.recordBatch({ message: large, providerId: "deepseek", modelId: "deepseek-v4-pro" })
    expect(ledger.pendingResults()).toEqual(["result_1"])

    ledger.apply({ decisions: [{ result: "result_1", action: "unresolved" }] }, true)
    expect(ledger.pendingResults()).toEqual(["result_1"])
    expect(JSON.stringify(messages)).toContain("unresolved")
    expect(JSON.stringify(messages)).toContain("large large")
  })
})
