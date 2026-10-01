import assert from "node:assert/strict";
import type { ModelClient, ModelMessage } from "@socrates/contracts";

/** Live two-request protocol check, including thinking/signature replay. */
export async function verifyProviderToolRoundTrip(model: ModelClient) {
  const system = "Call inspect_ledger exactly once with {selector: 'synthetic-goal'}. After reading its result, return the exact record_id as plain text. Do not call any further tools.";
  const messages: ModelMessage[] = [{role: "user", content: "Inspect the ledger and report the returned record ID."}];
  const tools = [{name: "inspect_ledger", description: "Look up a synthetic ledger record.", inputSchema: {type: "object", properties: {selector: {type: "string"}}, required: ["selector"], additionalProperties: false}}];
  const first = await model.complete({system, messages, tools, maxOutputTokens: 2000});
  assert.equal(first.toolCalls.length, 1); assert.equal(first.toolCalls[0]!.name, "inspect_ledger"); assert(first.raw);
  messages.push({role: "assistant", content: first.text, toolCalls: first.toolCalls, raw: first.raw});
  messages.push({role: "tool", toolCallId: first.toolCalls[0]!.id, toolName: "inspect_ledger", content: JSON.stringify({record_id: "synthetic-record-7391"})});
  const second = await model.complete({system, messages, tools, maxOutputTokens: 2000});
  assert(second.text.includes("synthetic-record-7391")); assert.equal(second.toolCalls.length, 0);
  return {provider: model.id, servedBy: second.servedBy ?? model.id, firstNativeMetadata: first.raw.provider, promptTokens: first.usage.promptTokens + second.usage.promptTokens, outputTokens: first.usage.outputTokens + second.usage.outputTokens};
}
