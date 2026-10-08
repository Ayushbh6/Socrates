import type { Effort, ModelClient } from "@socrates/contracts";

/** The model that names standard-mode chats when nothing else is chosen (architecture/server.md, "Chat names"). */
export const DEFAULT_TITLER = { provider: "openrouter", model: "xiaomi/mimo-v2.6-flash" } as const;

/** How long a chat's name may be, in words. */
const TITLE_WORDS = 8;

const SYSTEM = `You name a chat in a sidebar list, the way a chat app does.

You get the user's first message and, only for context, the start of the answer. Name the topic: what the user wants to do, make or understand, as a short noun phrase in your own words.

- Two to six words, sentence case, in the user's language. Plain text: no quotes, no ending punctuation, no emoji.
- Never reuse the opening words of the message or of the answer. An answer that begins "Done" or "Both are up" says nothing about the topic.
- Name what the chat is about, not that it is a chat, and not what Socrates did.
- Use the answer only when the message is too vague to name by itself.

Examples:
Message: Can you look at why my checkout test keeps timing out on CI? It started after the last merge.
Name: Checkout test timing out on CI

Message: Start the dev server in the background on port 3000 and tell me when it is ready.
Name: Local dev server on port 3000

Message: what should I cook for six people on friday, one is vegetarian
Name: Friday dinner for six

Reply with the name only.`;

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

/** Lower-case words without punctuation, for comparing a name with the text it came from. */
const words = (text: string): string[] => text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter(Boolean);

/**
 * Whether a name is only the start of the message or of the answer: the
 * answer's opening words ("Both are up"), or four or more of the message's.
 */
export function copiesStart(title: string, message: string, answer: string): boolean {
  const name = words(title);
  const starts = (text: string, least: number) => name.length >= least && words(text).slice(0, name.length).join(" ") === name.join(" ");
  return starts(answer, 2) || starts(message, 4);
}

/** Ask the model for a chat's name from its first question and answer; a name that only copies their opening words is asked for again once. */
export async function nameChat(
  model: ModelClient,
  input: { message: string; answer: string; trace: { goalId: string; taskId: string; turnId: string; userEventId: string }; effort?: Effort; signal?: AbortSignal },
): Promise<string | null> {
  const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const content = `<message>\n${clip(input.message, 1500)}\n</message>\n\n<answer_start>\n${clip(input.answer, 600)}\n</answer_start>`;
  let again = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await model.complete({
      system: SYSTEM,
      messages: [{ role: "user", content: content + again }],
      // Room for a model that thinks before it names; the name itself is a few tokens.
      maxOutputTokens: 1500,
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      trace: { role: "other", ...input.trace },
    });
    const title = cleanTitle(response.text);
    if (!title) return null;
    if (!copiesStart(title, input.message, input.answer)) return title;
    again = `\n\nYou named it "${title}", which only repeats the opening words. Name the topic in your own words.`;
  }
  return null;
}
