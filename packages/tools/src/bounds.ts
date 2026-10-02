import { countTokens, truncateTailToTokens, truncateToTokens } from "@socrates/shared";

/**
 * Bounded ingestion (agent-harness.md, "Bounded ingestion"): one universal
 * ceiling on what a single tool result may place in the prompt, measured with
 * the harness-standard o200k tokenizer.
 */
export const RESULT_CEILING_TOKENS = 10_000;

/** Upper bound on characters per token, used to pre-slice huge text before tokenizing. */
const MAX_CHARS_PER_TOKEN = 8;

/**
 * Keep the beginning and end of text within `maxTokens`, cutting at line
 * boundaries where possible, with an explicit omission marker. Errors and
 * summaries usually sit at the end of command output, so both ends survive.
 */
export function headTail(text: string, maxTokens: number, hint = ""): { text: string; truncated: boolean; omittedLines: number } {
  const window = maxTokens * MAX_CHARS_PER_TOKEN;
  if (text.length <= window && countTokens(text) <= maxTokens) return { text, truncated: false, omittedLines: 0 };
  const half = Math.max(1, Math.floor((maxTokens - 40) / 2));
  let head = truncateToTokens(text.slice(0, window), half).text;
  let tail = truncateTailToTokens(text.slice(-window), half).text;
  const headCut = head.lastIndexOf("\n");
  if (headCut > head.length / 2) head = head.slice(0, headCut + 1);
  const tailCut = tail.indexOf("\n");
  if (tailCut >= 0 && tailCut < tail.length / 2) tail = tail.slice(tailCut + 1);
  const omittedChars = Math.max(0, text.length - head.length - tail.length);
  const omittedLines = countLines(text.slice(head.length, text.length - tail.length));
  const marker = `\n[… ${omittedLines} lines (${omittedChars} characters) omitted${hint ? `; ${hint}` : ""} …]\n`;
  return { text: head + marker + tail, truncated: true, omittedLines };
}

/** Keep the beginning of text within `maxTokens`, with an explicit marker. */
export function head(text: string, maxTokens: number, hint = ""): { text: string; truncated: boolean } {
  const slice = text.slice(0, maxTokens * MAX_CHARS_PER_TOKEN);
  const cut = truncateToTokens(slice, maxTokens);
  if (!cut.truncated && slice.length === text.length) return { text, truncated: false };
  return { text: `${cut.text}\n[… ${text.length - cut.text.length} characters omitted${hint ? `; ${hint}` : ""} …]`, truncated: true };
}

/** Cut one line to `max` characters with a marker stating how much was cut. */
export function cutLine(line: string, max: number): string {
  if (line.length <= max) return line;
  // Never split a surrogate pair.
  const end = /[\uD800-\uDBFF]/.test(line[max - 1] ?? "") ? max - 1 : max;
  return `${line.slice(0, end)}… [line truncated: ${line.length - end} more characters]`;
}

function countLines(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
