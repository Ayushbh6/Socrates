import { mkdir } from "node:fs/promises";
import path from "node:path";
import { EditInput } from "@socrates/contracts";
import { type HandlerContext, requireWorkspace, throwIfCancelled } from "../context";
import { boundedDiff, unifiedDiff } from "../diff";
import { ToolError } from "../errors";
import { currentHash, encodeText, hashBytes, notFound, readTextFile, statOrNull, writeAtomic, writeNew } from "../files";
import type { ToolHandler, ToolOutput } from "../handler";
import { withFileLocks, withWorkspaceLock } from "../locks";
import { findMatches, lineNumberAt, nearMiss } from "../match";
import type { ResolvedPath } from "../workspace";

/**
 * The stale-edit check (agent-harness.md, "edit"): a file this task observed
 * must still have the content hash the task last saw.
 */
export function assertFresh(ctx: HandlerContext, rel: string, hash: string): void {
  const observed = ctx.store.observedHash(ctx.binding.taskId, rel);
  if (observed && observed.hash !== hash) {
    throw new ToolError(
      "stale_file",
      `${rel} changed after this task last read or wrote it (another tool, a command, or the user modified it).`,
      `Read ${rel} again, then retry with its current text.`,
    );
  }
}

export function changedDuringCall(rel: string): ToolError {
  return new ToolError("stale_file", `${rel} changed while this call was running, so nothing was written.`, `Read ${rel} again, then retry with its current text.`);
}

type OneEdit = { old_text: string; new_text: string; replace_all?: boolean | undefined };

/** The call's replacements: one given directly, or the `edits` list, never both. */
function editsOf(input: EditInput): OneEdit[] {
  const single = input.old_text !== undefined || input.new_text !== undefined;
  if (input.edits && single) throw new ToolError("invalid_parameters", "Pass either old_text and new_text, or edits, not both.", "Put every replacement in edits, or make one call per replacement.");
  if (input.edits) return input.edits;
  if (input.old_text === undefined || input.new_text === undefined) throw new ToolError("invalid_parameters", "edit needs old_text and new_text, or edits.", "Pass old_text and new_text for one replacement, or edits for several.");
  return [{ old_text: input.old_text, new_text: input.new_text, replace_all: input.replace_all }];
}

/** Apply one replacement to the text so far; a failure names the edit and leaves the file untouched. */
function replace(text: string, edit: OneEdit, rel: string, label: string): { text: string; replacements: number; match: string } {
  const find = edit.old_text.replace(/\r\n/g, "\n");
  const replacementText = edit.new_text.replace(/\r\n/g, "\n");
  const unwritten = label ? " Nothing was written." : "";
  const found = findMatches(text, find);
  if (!found) {
    const near = nearMiss(text, find);
    const shown = near?.differences.slice(0, 3).map((d) => `at line ${d.line}: the file has ${JSON.stringify(d.file)} where old_text has ${JSON.stringify(d.old_text)}`) ?? [];
    const more = near && near.differences.length > 3 ? `, and in ${near.differences.length - 3} more line${near.differences.length === 4 ? "" : "s"}` : "";
    throw new ToolError(
      "old_text_not_found",
      `${label}old_text was not found in ${rel}.${near ? ` The closest text is at line${near.start_line === near.end_line ? ` ${near.start_line}` : `s ${near.start_line}–${near.end_line}`}, which differs ${shown.join("; ")}${more}.` : ""}${unwritten}`,
      near ? `Read ${rel} around line ${near.start_line} and copy the exact current text.` : `Read ${rel} and copy old_text exactly as it appears now.`,
      true,
      near ? { closest: near } : undefined,
    );
  }
  if (found.matches.length > 1 && !edit.replace_all) {
    const at = found.matches.slice(0, 5).map((m) => lineNumberAt(text, m.start));
    throw new ToolError(
      "old_text_ambiguous",
      `${label}old_text occurs ${found.matches.length} times in ${rel} (lines ${at.join(", ")}${found.matches.length > 5 ? ", …" : ""}).${unwritten}`,
      "Include more surrounding lines so old_text is unique, or set replace_all: true to change every occurrence.",
    );
  }
  if (found.unshiftable.length) {
    throw new ToolError(
      "old_text_indentation_mismatch",
      `${label}old_text matches ${rel} at line ${found.unshiftable.join(", ")} only when indentation is ignored, and its relative indentation differs from the file, so the replacement's indentation cannot be derived safely.${unwritten}`,
      `Read ${rel} and copy old_text and new_text with the file's exact indentation.`,
    );
  }
  let after = text;
  for (const m of [...found.matches].reverse()) {
    const replacement = m.reindent ? m.reindent(replacementText) : replacementText;
    after = after.slice(0, m.start) + replacement + after.slice(m.end);
  }
  return { text: after, replacements: found.matches.length, match: found.tier };
}

export const editTool: ToolHandler<EditInput> = {
  name: "edit",
  description: [
    "Replace text in one file, or create a new file. old_text must match the file and occur exactly once, unless replace_all is true (then every occurrence is replaced; zero still fails).",
    "For several changes to one file, pass edits: [{ old_text, new_text, replace_all? }] instead: they apply in order, each to the text the previous one left, and either all succeed or nothing is written.",
    "Copy old_text from read output without the line-number prefix. Include enough surrounding lines to make it unique. Exact matching is tried first; if nothing matches exactly, whole lines are matched ignoring trailing whitespace, then indentation, then typographic punctuation, and the result reports which. A miss names the closest lines and how they differ.",
    "To create a file that does not exist, pass an empty old_text and its whole content as new_text (missing folders are created); it never overwrites a file. Fails if the file changed since this task last read it; read it again first. Keeps the file's encoding (UTF-8 or UTF-16), byte-order mark, and each line's ending. Use apply_patch for changes across several files, moves, and deletes.",
  ].join(" "),
  schema: EditInput,
  concurrency: "serial",
  mutating: true,
  async execute(input, ctx) {
    const workspace = requireWorkspace(ctx);
    const edits = editsOf(input);
    const file = await ctx.path(input.path, "write");
    return withWorkspaceLock(workspace.root, () => withFileLocks([file.abs], async () => {
      ctx.recheckPath(file, "write");
      if (!(await statOrNull(file.abs))) return create(file, edits, ctx);
      const text = await readTextFile(file);
      assertFresh(ctx, file.rel, text.hash);
      let after = text.text;
      const done: { replacements: number; match: string }[] = [];
      for (const [i, edit] of edits.entries()) {
        const label = edits.length > 1 ? `edits[${i}]: ` : "";
        if (edit.old_text === "") {
          // An empty old_text fills an empty file; it never replaces content.
          if (after !== "") throw new ToolError("old_text_empty", `${label}old_text is empty, but ${file.rel} already has content.${label ? " Nothing was written." : ""}`, "Copy the exact text to replace into old_text. An empty old_text only creates a new file or fills an empty one.");
          after = edit.new_text.replace(/\r\n/g, "\n");
          done.push({ replacements: 1, match: "exact" });
          continue;
        }
        const r = replace(after, edit, file.rel, label);
        after = r.text;
        done.push({ replacements: r.replacements, match: r.match });
      }
      const replacements = done.reduce((n, d) => n + d.replacements, 0);
      const result: Record<string, unknown> = { path: file.rel, replacements, changed: after !== text.text, ...(edits.length > 1 ? { edits: done } : { match: done[0]!.match }) };
      if (after === text.text) {
        result.diff = "";
        return { content: JSON.stringify(result), result, observed: [{ path: file.rel, hash: text.hash }] };
      }
      const encoded = encodeText(after, text);
      throwIfCancelled(ctx.signal);
      // The file must still be exactly what this edit was computed from.
      if ((await currentHash(file.abs)) !== text.hash) throw changedDuringCall(file.rel);
      await writeAtomic(file.abs, encoded, text.mode);
      const { diff, truncated } = boundedDiff([unifiedDiff(file.rel, text.text, after)]);
      result.diff = diff;
      if (truncated) result.diff_truncated = true;
      return {
        content: JSON.stringify(result),
        result,
        observed: [{ path: file.rel, hash: hashBytes(encoded) }],
        facts: [{ kind: "file_changed", value: file.rel }],
        mutations: [{ path: file.rel, action: "updated", fromPath: null, before: text.text, after }],
      };
    }));
  },
};

/** Create a missing file from one edit with an empty old_text; anything else is a missing-file error. */
async function create(file: ResolvedPath, edits: OneEdit[], ctx: HandlerContext): Promise<ToolOutput> {
  const [edit] = edits;
  if (edits.length !== 1 || edit!.old_text !== "") {
    const missing = await notFound(file);
    throw new ToolError(missing.code, missing.message, `${missing.correction} To create it, call edit with an empty old_text and the whole content as new_text.`);
  }
  throwIfCancelled(ctx.signal);
  const content = edit!.new_text;
  await mkdir(path.dirname(file.abs), { recursive: true });
  if (!(await writeNew(file.abs, content))) {
    throw new ToolError("file_exists", `${file.rel} appeared while this edit ran, so nothing was written.`, `Read ${file.rel}, then edit it.`);
  }
  const { diff, truncated } = boundedDiff([unifiedDiff(file.rel, null, content)]);
  const result: Record<string, unknown> = { path: file.rel, created: true, replacements: 0, changed: true, diff, ...(truncated ? { diff_truncated: true } : {}) };
  return {
    content: JSON.stringify(result),
    result,
    observed: [{ path: file.rel, hash: hashBytes(content) }],
    facts: [{ kind: "file_changed", value: file.rel }],
    mutations: [{ path: file.rel, action: "created", fromPath: null, before: null, after: content }],
  };
}
