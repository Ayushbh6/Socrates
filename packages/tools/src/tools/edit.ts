import { EditInput } from "@socrates/contracts";
import { type HandlerContext, requireWorkspace, throwIfCancelled } from "../context";
import { boundedDiff, unifiedDiff } from "../diff";
import { ToolError } from "../errors";
import { currentHash, encodeText, hashBytes, readTextFile, writeAtomic } from "../files";
import type { ToolHandler } from "../handler";
import { withWorkspaceLock } from "../locks";
import { findMatches, lineNumberAt, nearMisses } from "../match";

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

export const editTool: ToolHandler<EditInput> = {
  name: "edit",
  description: [
    "Replace text in one existing file. old_text must match the file and occur exactly once, unless replace_all is true (then every occurrence is replaced; zero still fails).",
    "Copy old_text from read output without the line-number prefix. Include enough surrounding lines to make it unique. Exact matching is tried first; if nothing matches exactly, whole lines are matched ignoring trailing whitespace, then indentation, then typographic punctuation, and the result reports which.",
    "Fails if the file changed since this task last read it; read it again first. Preserves the file's line endings. Does not create files: use apply_patch for new files and multi-file changes.",
  ].join(" "),
  schema: EditInput,
  concurrency: "serial",
  mutating: true,
  async execute(input, ctx) {
    const workspace = requireWorkspace(ctx);
    const file = await ctx.path(input.path, "write");
    return withWorkspaceLock(workspace.root, async () => {
      const text = await readTextFile(file);
      assertFresh(ctx, file.rel, text.hash);
      const find = input.old_text.replace(/\r\n/g, "\n");
      const replacementText = input.new_text.replace(/\r\n/g, "\n");
      const found = findMatches(text.text, find);
      if (!found) {
        const near = nearMisses(text.text, find);
        throw new ToolError(
          "old_text_not_found",
          `old_text was not found in ${file.rel}.${near.length ? ` Its first line appears at line ${near.join(", ")}, but the following lines differ.` : ""}`,
          near.length ? `Read ${file.rel} around line ${near[0]} and copy the exact current text.` : `Read ${file.rel} and copy old_text exactly as it appears now.`,
        );
      }
      if (found.matches.length > 1 && !input.replace_all) {
        const at = found.matches.slice(0, 5).map((m) => lineNumberAt(text.text, m.start));
        throw new ToolError(
          "old_text_ambiguous",
          `old_text occurs ${found.matches.length} times in ${file.rel} (lines ${at.join(", ")}${found.matches.length > 5 ? ", …" : ""}).`,
          "Include more surrounding lines so old_text is unique, or set replace_all: true to change every occurrence.",
        );
      }
      if (found.unshiftable.length) {
        throw new ToolError(
          "old_text_indentation_mismatch",
          `old_text matches ${file.rel} at line ${found.unshiftable.join(", ")} only when indentation is ignored, and its relative indentation differs from the file, so the replacement's indentation cannot be derived safely.`,
          `Read ${file.rel} and copy old_text and new_text with the file's exact indentation.`,
        );
      }
      let after = text.text;
      for (const m of [...found.matches].reverse()) {
        const replacement = m.reindent ? m.reindent(replacementText) : replacementText;
        after = after.slice(0, m.start) + replacement + after.slice(m.end);
      }
      const result: Record<string, unknown> = { path: file.rel, replacements: found.matches.length, changed: after !== text.text, match: found.tier };
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
    });
  },
};
