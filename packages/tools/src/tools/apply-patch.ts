import { mkdir, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { ApplyPatchInput } from "@socrates/contracts";
import { requireWorkspace } from "../context";
import { boundedDiff, unifiedDiff } from "../diff";
import { ToolError } from "../errors";
import { type TextFile, encodeText, hashBytes, readTextFile, statOrNull, writeAtomic } from "../files";
import type { FileMutation, ToolHandler } from "../handler";
import { PATCH_FORMAT_HINT, applyChunks, parsePatch } from "../patch";
import type { ResolvedPath } from "../workspace";
import { assertFresh } from "./edit";

interface PlannedChange {
  action: FileMutation["action"];
  source: ResolvedPath;
  target: ResolvedPath;
  before: TextFile | null;
  after: string | null;
}

export const applyPatchTool: ToolHandler<ApplyPatchInput> = {
  name: "apply_patch",
  description: [
    "Create, update, move, or delete one or more files with one patch. The whole patch is validated first and then applied atomically: every file change succeeds or none does.",
    PATCH_FORMAT_HINT,
    'Paths are workspace-relative. Context lines must match the current file (read it first); "@@ line" may name a nearby line such as a function signature to anchor a chunk. Use "*** Move to: path" after Update File to rename.',
    "Prefer edit for one small replacement; use apply_patch for new files, several hunks, or coordinated multi-file changes.",
  ].join(" "),
  schema: ApplyPatchInput,
  concurrency: "serial",
  mutating: true,
  async execute(input, ctx) {
    const workspace = requireWorkspace(ctx);
    const hunks = parsePatch(input.patch);

    // Validate every operation before touching the filesystem.
    const touched = new Set<string>();
    const claim = (p: ResolvedPath) => {
      if (touched.has(p.rel)) throw new ToolError("invalid_patch", `${p.rel} appears more than once in the patch.`, "Combine all changes to one file into a single Update File section.");
      touched.add(p.rel);
    };
    const resolve = (raw: string) => {
      if (path.isAbsolute(raw)) throw new ToolError("invalid_patch", `Patch paths must be workspace-relative; got ${raw}.`, "Use a path relative to the workspace root, such as src/index.ts.");
      return workspace.resolve(raw, { write: true });
    };
    const planned: PlannedChange[] = [];
    for (const hunk of hunks) {
      const source = resolve(hunk.path);
      claim(source);
      const info = await statOrNull(source.abs);
      if (hunk.kind === "add") {
        if (info) throw new ToolError("file_exists", `${source.rel} already exists, so it cannot be added.`, `Use "*** Update File: ${source.rel}" to change it, or delete it first.`);
        planned.push({ action: "created", source, target: source, before: null, after: hunk.lines.length ? `${hunk.lines.join("\n")}\n` : "" });
        continue;
      }
      if (!info || !info.isFile()) throw new ToolError("file_not_found", `${source.rel} does not exist, so it cannot be ${hunk.kind === "delete" ? "deleted" : "updated"}.`, `Check the path with glob; use "*** Add File: ${source.rel}" to create it.`);
      const before = await readTextFile(source);
      assertFresh(ctx, source.rel, before.hash);
      if (hunk.kind === "delete") {
        planned.push({ action: "deleted", source, target: source, before, after: null });
        continue;
      }
      const after = applyChunks(source.rel, before.text, hunk.chunks);
      let target = source;
      if (hunk.moveTo) {
        target = resolve(hunk.moveTo);
        claim(target);
        if (await statOrNull(target.abs)) throw new ToolError("file_exists", `Cannot move ${source.rel} to ${target.rel}: the destination exists.`, "Choose a new destination, or delete the existing file in the same patch first.");
      }
      planned.push({ action: hunk.moveTo ? "moved" : "updated", source, target, before, after });
    }

    // Commit. On any failure, restore every file already written.
    const undo: (() => Promise<void>)[] = [];
    try {
      for (const change of planned) {
        if (change.after !== null) {
          const createdDir = await mkdir(path.dirname(change.target.abs), { recursive: true });
          if (createdDir) undo.push(() => rm(createdDir, { recursive: true, force: true }));
          const original = change.action === "updated" ? await readFile(change.target.abs) : null;
          await writeAtomic(change.target.abs, encodeText(change.after, change.before ?? { eol: "\n", bom: false }), change.before?.mode);
          undo.push(original ? () => writeAtomic(change.target.abs, original.toString("utf8"), change.before?.mode) : () => rm(change.target.abs, { force: true }));
        }
        if (change.action === "deleted" || change.action === "moved") {
          const original = await readFile(change.source.abs);
          await unlink(change.source.abs);
          undo.push(() => writeAtomic(change.source.abs, original.toString("utf8"), change.before?.mode));
        }
      }
    } catch (error) {
      for (const restore of undo.reverse()) await restore().catch(() => {});
      throw error;
    }

    const files = planned.map((c) => ({ path: c.target.rel, action: c.action, ...(c.action === "moved" ? { from: c.source.rel } : {}) }));
    const { diff, truncated } = boundedDiff(planned.map((c) => unifiedDiff(c.target.rel, c.before?.text ?? null, c.after)));
    const result: Record<string, unknown> = { files, changed_files: planned.length, diff };
    if (truncated) result.diff_truncated = true;
    return {
      content: JSON.stringify(result),
      result,
      observed: planned.flatMap((c) => [
        ...(c.source.rel !== c.target.rel || c.after === null ? [{ path: c.source.rel, hash: null }] : []),
        ...(c.after !== null ? [{ path: c.target.rel, hash: hashBytes(encodeText(c.after, c.before ?? { eol: "\n", bom: false })) }] : []),
      ]),
      facts: planned.map((c) => ({ kind: "file_changed" as const, value: c.target.rel })),
      mutations: planned.map((c) => ({
        path: c.target.rel,
        action: c.action,
        fromPath: c.action === "moved" ? c.source.rel : null,
        before: c.before?.text ?? null,
        after: c.after,
      })),
    };
  },
};
