import type { ModelClient } from "@socrates/contracts";

/** The model that names standard-mode chats when nothing else is chosen (architecture/server.md, "Chat names"). */
export const DEFAULT_TITLER = { provider: "openrouter", model: "xiaomi/mimo-v2.6-flash" } as const;

/** How long a chat's name may be, in words. */
const TITLE_WORDS = 8;

const SYSTEM = `You name a chat in a sidebar list, the way a chat app does. Reply with the name only: two to six words, plain text, in the user's language, sentence case, with no quotes, no ending punctuation, and no emoji. Name what the chat is about, not that it is a chat.`;

/** A chat's name until it gets a better one: the start of its first message. */
export function provisionalTitle(message: string, images = 0): string {
  const words = message.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (!words.length) return images ? (images === 1 ? "An image" : `${images} images`) : "New chat";
  const head = words.slice(0, 6).join(" ");
  return words.length > 6 ? `${head}…` : head;
}

/** A model's reply cut down to a name, or null when nothing usable is left. */
export function cleanTitle(text: string): string | null {
  const line = text.replace(/<think>[\s\S]*?<\/think>/g, "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const plain = line.replace(/^(title|name)\s*:\s*/i, "").replace(/^["'“”‘’`*#\s]+|["'“”‘’`*\s.!?:;]+$/g, "").trim();
  if (!plain) return null;
  const words = plain.split(/\s+/);
  return words.length > TITLE_WORDS ? words.slice(0, TITLE_WORDS).join(" ") : plain;
}

/** Ask the model for a chat's name from its first question and answer. */
export async function nameChat(model: ModelClient, input: { message: string; answer: string; trace: { goalId: string; taskId: string; turnId: string; userEventId: string }; signal?: AbortSignal }): Promise<string | null> {
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const response = await model.complete({
    system: SYSTEM,
    messages: [{ role: "user", content: `First message:\n${clip(input.message, 2000)}\n\nFirst answer:\n${clip(input.answer, 1500)}` }],
    maxOutputTokens: 400,
    ...(input.signal ? { signal: input.signal } : {}),
    trace: { role: "other", ...input.trace },
  });
  return cleanTitle(response.text);
}
