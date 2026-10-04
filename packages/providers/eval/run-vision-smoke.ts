import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";
import {parseEnv} from "node:util";
import type {ImageData, ModelMessage} from "@socrates/contracts";
import {PROVIDER_DEFAULTS, type Provider, detectVision, makeModel} from "../src";

/**
 * Live image check: the model must name the word and the circle's colour in a
 * synthetic label, shown once with the user's message and once in a tool
 * result after a real function call. A model that cannot see is reported.
 */
if (process.env.SOCRATES_ENV_FILE) {
  const values = parseEnv(readFileSync(process.env.SOCRATES_ENV_FILE, "utf8"));
  for (const key of Object.values(PROVIDER_DEFAULTS).flatMap(d => [...d.keys])) if (!process.env[key] && values[key]) process.env[key] = values[key];
}
const provider = process.env.SOCRATES_PROVIDER ?? "gemini";
const name = process.env.SOCRATES_MODEL ?? PROVIDER_DEFAULTS[provider as Provider].main;
const image: ImageData = {mediaType: "image/png", data: readFileSync(path.join(import.meta.dirname, "../../tools/test/fixture-label.png")).toString("base64")};
const correct = (text: string) => /orchid/i.test(text) && /yellow|gold/i.test(text);

const vision = await detectVision(provider, name);
const model = makeModel(provider, name, process.env, {vision});
if (!vision) {
  console.log(JSON.stringify({provider: model.id, vision}));
  process.exit(0);
}
const question = "What word is in the image, and what colour is the circle? One line.";
const direct = await model.complete({system: "Answer briefly.", messages: [{role: "user", content: question, images: [image]}], maxOutputTokens: 4000, onText: () => {}});
assert(correct(direct.text), `user image: ${direct.text}`);

const tools = [{name: "read", description: "Read a file; images are shown to you.", inputSchema: {type: "object", properties: {path: {type: "string"}}, required: ["path"]}}];
const messages: ModelMessage[] = [{role: "user", content: `Read label.png with the read tool. ${question}`}];
const first = await model.complete({system: "Use the read tool before answering.", messages, tools, maxOutputTokens: 4000, onText: () => {}});
assert.equal(first.toolCalls.length, 1, "expected one read call");
messages.push({role: "assistant", content: first.text, toolCalls: first.toolCalls, ...(first.raw ? {raw: first.raw} : {})});
messages.push({role: "tool", toolCallId: first.toolCalls[0]!.id, toolName: "read", content: "label.png — image, 400×400 PNG, 11 KB, shown below.", images: [image]});
const second = await model.complete({system: "Use the read tool before answering.", messages, tools, maxOutputTokens: 4000, onText: () => {}});
assert(correct(second.text), `tool image: ${second.text}`);
console.log(JSON.stringify({pass: true, provider: model.id, vision, direct: direct.text.trim(), tool: second.text.trim()}));
