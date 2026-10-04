import type { ImageData, ModelMessage } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { detectVision, knownVision, makeModel, toAnthropicMessages, toGeminiSteps, toOpenAIMessages } from "../src";

const image: ImageData = { mediaType: "image/png", data: "iVBORw0KGgo=" };
const conversation: ModelMessage[] = [
  { role: "user", content: "What is in these?", images: [image] },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", input: { path: "a.png" } }, { id: "c2", name: "read", input: { path: "b.txt" } }, { id: "c3", name: "read", input: { path: "c.png" } }] },
  { role: "tool", toolCallId: "c1", toolName: "read", content: "a.png — image", images: [image] },
  { role: "tool", toolCallId: "c2", toolName: "read", content: "b.txt — text" },
  { role: "tool", toolCallId: "c3", toolName: "read", content: "c.png — image", images: [image] },
  { role: "user", content: "Go on." },
];

describe("images to each provider", () => {
  it("gives Anthropic images before the user's text and inside tool results", () => {
    const out = toAnthropicMessages(conversation);
    expect(out[0]!.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: image.data } }, { type: "text", text: "What is in these?" }]);
    const results = out[2]!.content as { type: string; content?: unknown }[];
    expect(results[0]!.content).toEqual([{ type: "text", text: "a.png — image" }, { type: "image", source: { type: "base64", media_type: "image/png", data: image.data } }]);
    expect(results[1]!.content).toBe("b.txt — text");
  });

  it("gives OpenAI-compatible models user images as parts, and tool images in one user message after the tool results", () => {
    const out = toOpenAIMessages(conversation) as { role: string; content: unknown }[];
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "tool", "user", "user"]);
    expect(out[0]!.content).toEqual([{ type: "text", text: "What is in these?" }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } }]);
    expect(out[2]!.content).toBe("a.png — image\n[The image follows in the next message.]");
    expect(out[5]!.content).toEqual([
      { type: "text", text: "Image from read (c1):" }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
      { type: "text", text: "Image from read (c3):" }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
    ]);
    expect(out[6]!.content).toBe("Go on.");
  });

  it("gives Gemini images as content beside text, in the user's input and the function's result", () => {
    const steps = toGeminiSteps(conversation, "gemini:interactions:g");
    expect(steps[0]).toEqual({ type: "user_input", content: [{ type: "text", text: "What is in these?" }, { type: "image", data: image.data, mime_type: "image/png" }] });
    expect(steps.find((s) => s.type === "function_result" && s.call_id === "c1")).toMatchObject({ result: [{ type: "text", text: "a.png — image" }, { type: "image", data: image.data, mime_type: "image/png" }] });
  });
});

describe("which models can see", () => {
  const list = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as unknown as typeof fetch;

  it("knows Claude, Gemini and OpenAI's vision models, and asks DeepSeek and OpenRouter per model", async () => {
    expect([knownVision("anthropic", "claude-haiku-4-5"), knownVision("gemini", "gemini-3.8-flash"), knownVision("openai", "gpt-5"), knownVision("openai", "gpt-3.5-turbo"), knownVision("deepseek", "deepseek-flash")]).toEqual([true, true, true, false, false]);
    const deepseek = list({ data: [{ id: "deepseek-flash", input_modalities: ["text", "image"] }, { id: "deepseek-v4-pro", input_modalities: ["text"] }] });
    expect(await detectVision("deepseek", "deepseek-flash", {}, deepseek)).toBe(true);
    expect(await detectVision("deepseek", "deepseek-v4-pro", {}, deepseek)).toBe(false);
    const openrouter = list({ data: [{ id: "z-ai/glm-5.3-flash", architecture: { input_modalities: ["text", "image"] } }] });
    expect(await detectVision("openrouter", "z-ai/glm-5.3-flash", {}, openrouter)).toBe(true);
    // A failed lookup or an unlisted model falls back to what is known.
    expect(await detectVision("openrouter", "z-ai/glm-5.3-flash", {}, list({}, false))).toBe(false);
    expect(await detectVision("openrouter", "other/model", {}, openrouter)).toBe(false);
    expect(await detectVision("gemini", "gemini-3.8-flash", {}, list({}, false))).toBe(true);
  });

  it("builds each model with what it can see", () => {
    expect(makeModel("deepseek", "deepseek-flash", { DEEPSEEK_API_KEY: "k" }, { vision: true }).vision).toBe(true);
    expect(makeModel("deepseek", "deepseek-flash", { DEEPSEEK_API_KEY: "k" }).vision).toBe(false);
    expect(makeModel("gemini", "gemini-3.8-flash", { GEMINI_API_KEY: "k" }).vision).toBe(true);
  });
});
