import { ReadInput } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import { RESULT_CEILING_TOKENS, cutLine } from "../bounds";
import { requireWorkspace } from "../context";
import { ToolError } from "../errors";
import { readTextFile, splitLines } from "../files";
import type { ToolHandler } from "../handler";

export const READ_DEFAULT_LIMIT = 2000;
export const READ_MAX_LINE_CHARS = 2000;
/** Room left under the ceiling for the header and paging footer. */
const FRAME_TOKENS = 200;

export const readTool: ToolHandler<ReadInput> = {
  name: "read",
  description: [
    "Read a window of lines from one UTF-8 text file in the workspace. Output lines are prefixed with their 1-based number and a colon (\"42: text\"); the prefix is not part of the file.",
    `Defaults: offset 1, limit ${READ_DEFAULT_LIMIT} lines. A window also stops at about ${RESULT_CEILING_TOKENS} tokens; when more remains the footer gives the next offset to continue from.`,
    `Lines longer than ${READ_MAX_LINE_CHARS} characters are cut with a marker. Use glob to list directories and grep to find text; binary files are rejected.`,
  ].join(" "),
  schema: ReadInput,
  concurrency: "parallel",
  mutating: false,
  async execute(input, ctx) {
    const file = requireWorkspace(ctx).resolve(input.path);
    const text = await readTextFile(file);
    const all = splitLines(text.text);
    const offset = input.offset ?? 1;
    const limit = input.limit ?? READ_DEFAULT_LIMIT;
    if (all.length === 0 && offset === 1) {
      const result = { path: file.rel, offset: 1, lines: [], total_lines: 0, truncated: false, next_offset: null };
      return { content: `${file.rel} is empty (0 lines).`, result, observed: [{ path: file.rel, hash: text.hash }] };
    }
    if (offset > all.length) {
      throw new ToolError("offset_out_of_range", `offset ${offset} is past the end of ${file.rel}, which has ${all.length} lines.`, `Use an offset between 1 and ${all.length}.`);
    }

    const lines: { number: number; text: string }[] = [];
    let tokens = 0;
    let cutLines = false;
    for (let i = offset - 1; i < all.length && lines.length < limit; i++) {
      const raw = all[i]!;
      const shown = cutLine(raw, READ_MAX_LINE_CHARS);
      if (shown !== raw) cutLines = true;
      const rendered = `${i + 1}: ${shown}`;
      const cost = countTokens(rendered) + 1;
      if (lines.length > 0 && tokens + cost > RESULT_CEILING_TOKENS - FRAME_TOKENS) break;
      tokens += cost;
      lines.push({ number: i + 1, text: shown });
    }
    const last = lines[lines.length - 1]!.number;
    const nextOffset = last < all.length ? last + 1 : null;
    const truncated = nextOffset !== null || cutLines;
    const result = { path: file.rel, offset, lines, total_lines: all.length, truncated, next_offset: nextOffset };

    const header = `${file.rel} — lines ${offset}–${last} of ${all.length}`;
    const footer = nextOffset !== null ? `\n[More lines remain: continue with read offset ${nextOffset}.]` : "";
    const content = `${header}\n${lines.map((l) => `${l.number}: ${l.text}`).join("\n")}${footer}`;
    return { content, result, observed: [{ path: file.rel, hash: text.hash }] };
  },
};
