import { structuredPatch } from "diff";
import { head } from "./bounds";

/** Diffs shown to the model are bounded; the complete mutation stays in the event log. */
export const DIFF_MAX_TOKENS = 4_000;

/** A unified diff of one file without the ---/+++ header noise. */
export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  const patch = structuredPatch(path, path, before ?? "", after ?? "", "", "", { context: 3 });
  const label = before === null ? `+++ ${path} (created)` : after === null ? `--- ${path} (deleted)` : `*** ${path}`;
  const hunks = patch.hunks.map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines.filter((l) => !l.startsWith("\\"))].join("\n"));
  return [label, ...hunks].join("\n");
}

export function boundedDiff(parts: string[]): { diff: string; truncated: boolean } {
  const bounded = head(parts.join("\n"), DIFF_MAX_TOKENS, "the complete change is in the event log");
  return { diff: bounded.text, truncated: bounded.truncated };
}

/** Lines added and removed, for the one-line activity form. */
export function lineCounts(before: string | null, after: string | null): { added: number; removed: number } {
  const patch = structuredPatch("a", "a", before ?? "", after ?? "", "", "", { context: 0 });
  let added = 0;
  let removed = 0;
  for (const h of patch.hunks) for (const l of h.lines) l.startsWith("+") ? added++ : l.startsWith("-") ? removed++ : null;
  return { added, removed };
}
