import assert from "node:assert/strict";
import type { ModelClient, ModelMessage } from "@socrates/contracts";

/**
 * Live two-request protocol check, including thinking/signature replay. With
 * `stream`, both requests are streamed: the pieces must add up to the reply's
 * text, and the streamed first reply must continue the conversation as well as
 * a plain one does. A third, longer reply must arrive in more than one piece.
 */
export async function verifyProviderToolRoundTrip(model: ModelClient, options: {stream?: boolean} = {}) {
  const pieces: string[] = [];
  const thought: string[] = [];
  let thoughtPieces = 0;
  const onText = options.stream ? {onText: (delta: string) => { pieces.push(delta); }, onReasoning: (delta: string) => { thought.push(delta); thoughtPieces++; }} : {};
  // Streamed thinking must add up to the reply's readable reasoning, when the model shows any.
  const checkPieces = (text: string, reasoning?: string) => { if (options.stream) { assert.equal(pieces.join(""), text); assert.equal(thought.join(""), reasoning ?? ""); pieces.length = 0; thought.length = 0; } };
  const system = "Call inspect_ledger exactly once with {selector: 'synthetic-goal'}. After reading its result, return the exact record_id as plain text. Do not call any further tools.";
  const messages: ModelMessage[] = [{role: "user", content: "Inspect the ledger and report the returned record ID."}];
  const tools = [{name: "inspect_ledger", description: "Look up a synthetic ledger record.", inputSchema: {type: "object", properties: {selector: {type: "string"}}, required: ["selector"], additionalProperties: false}}];
  const first = await model.complete({system, messages, tools, maxOutputTokens: 2000, ...onText});
  checkPieces(first.text, first.reasoning);
  assert.equal(first.toolCalls.length, 1); assert.equal(first.toolCalls[0]!.name, "inspect_ledger"); assert(first.raw);
  messages.push({role: "assistant", content: first.text, toolCalls: first.toolCalls, raw: first.raw});
  messages.push({role: "tool", toolCallId: first.toolCalls[0]!.id, toolName: "inspect_ledger", content: JSON.stringify({record_id: "synthetic-record-7391"})});
  const second = await model.complete({system, messages, tools, maxOutputTokens: 2000, ...onText});
  checkPieces(second.text, second.reasoning);
  assert(second.text.includes("synthetic-record-7391")); assert.equal(second.toolCalls.length, 0);
  let pieceCount: number | undefined;
  if (options.stream) {
    const long = await model.complete({system: "Answer in plain text.", messages: [{role: "user", content: "Write the numbers one to twenty as words, one per line."}], maxOutputTokens: 2000, ...onText});
    assert.equal(pieces.join(""), long.text); assert.equal(thought.join(""), long.reasoning ?? ""); assert(pieces.length > 1, "a long reply should arrive in several pieces"); pieceCount = pieces.length;
  }
  return {provider: model.id, ...(pieceCount ? {streamedPieces: pieceCount, thinkingPieces: thoughtPieces} : {}), servedBy: second.servedBy ?? model.id, firstNativeMetadata: first.raw.provider, promptTokens: first.usage.promptTokens + second.usage.promptTokens, outputTokens: first.usage.outputTokens + second.usage.outputTokens};
}
