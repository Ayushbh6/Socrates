import { mkdir, readFile, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { ApplyPatchInput } from "@socrates/contracts";
import { type HandlerContext, requireWorkspace, throwIfCancelled } from "../context";
import { boundedDiff, unifiedDiff } from "../diff";
import { ToolError } from "../errors";
import { NEW_FILE, type TextFile, currentHash, encodeText, hashBytes, readTextFile, statOrNull, writeAtomic, writeNew } from "../files";
import type { FileMutation, ToolHandler, ToolOutput } from "../handler";
import { withFileLocks, withWorkspaceLock } from "../locks";
import { PATCH_FORMAT_HINT, type PatchHunk, applyChunks, parsePatch } from "../patch";
import type { ResolvedPath } from "../workspace";
import { assertFresh, changedDuringCall } from "./edit";

interface PlannedChange {
  action: FileMutation["action"];
  source: ResolvedPath;
  target: ResolvedPath;
  before: TextFile | null;
  after: string | null;
}

const encoded = (c: PlannedChange) => encodeText(c.after!, c.before ?? NEW_FILE);

/**
 * Commit a validated plan file by file. Each file is checked again
 * immediately before it is replaced, created, or removed: a source must still
 * have the content the plan was computed from, and a new path must still be
 * free. On any failure every file already written is restored, except one the
 * user changed again in the meantime, which is left as it is and named.
 */
async function commit(planned: PlannedChange[], ctx: HandlerContext): Promise<void> {
  const undo: { path: string; restore: () => Promise<boolean> }[] = [];
  const unchanged = (abs: string, hash: string) => async () => (await currentHash(abs)) === hash;
  try {
    for (const change of planned) {
      throwIfCancelled(ctx.signal);
      if (change.before && (await currentHash(change.source.abs)) !== change.before.hash) throw changedDuringCall(change.source.rel);
      if (change.after !== null) {
        const content = encoded(change);
        const written = hashBytes(content);
        const isWritten = unchanged(change.target.abs, written);
        if (change.action === "updated") {
          const original = await readFile(change.target.abs);
          await writeAtomic(change.target.abs, content, change.before?.mode);
          undo.push({ path: change.target.rel, restore: async () => {
            if (!(await isWritten())) return false;
            await writeAtomic(change.target.abs, original, change.before?.mode);
            return true;
          } });
        } else {
          const createdDir = await mkdir(path.dirname(change.target.abs), { recursive: true });
          if (createdDir) {
            // Remove only empty directories this patch created. A concurrent
            // user file inside one must survive rollback.
            const dirs: string[] = [];
            for (let dir = path.dirname(change.target.abs); ; dir = path.dirname(dir)) {
              dirs.push(dir);
              if (dir === createdDir) break;
            }
            undo.push({ path: path.dirname(change.target.rel), restore: async () => {
              for (const dir of dirs) {
                try { await rmdir(dir); }
                catch (error) {
                  const code = (error as NodeJS.ErrnoException).code;
                  if (code === "ENOENT") continue;
                  if (code === "ENOTEMPTY" || code === "EEXIST") return true;
                  throw error;
                }
              }
              return true;
            } });
          }
          if (!(await writeNew(change.target.abs, content, change.before?.mode))) {
            throw new ToolError("file_exists", `${change.target.rel} appeared while the patch was being applied, so nothing was written.`, `Check ${change.target.rel}, then rebuild the patch.`);
          }
          undo.push({ path: change.target.rel, restore: async () => {
            if (!(await isWritten())) return false;
            await rm(change.target.abs, { force: true });
            return true;
          } });
        }
      }
      if (change.action === "deleted" || change.action === "moved") {
        const original = await readFile(change.source.abs);
        if (hashBytes(original) !== change.before!.hash) throw changedDuringCall(change.source.rel);
        await unlink(change.source.abs);
        undo.push({ path: change.source.rel, restore: async () => writeNew(change.source.abs, original, change.before?.mode) });
      }
    }
    throwIfCancelled(ctx.signal);
  } catch (error) {
    const conflicts: string[] = [];
    for (const step of undo.reverse()) if (!(await step.restore().catch(() => false))) conflicts.push(step.path);
    if (conflicts.length) {
      throw new ToolError("patch_rollback_conflict", `The patch failed. Rollback could not restore ${conflicts.join(", ")}; concurrent changes were preserved.`, "Inspect the named files and rebuild the patch from their current contents.", false, { conflicts, cause: error instanceof ToolError ? error.body() : String(error) });
    }
    throw error;
  }
}

/** Validate every operation of a parsed patch, then commit it. Paths were resolved, and any approval answered, before the lock. */
async function applyHunks(hunks: PatchHunk[], paths: Map<string, ResolvedPath>, ctx: HandlerContext): Promise<ToolOutput> {
  // Validate every operation before touching the filesystem.
  const touched = new Set<string>();
  const claim = (p: ResolvedPath) => {
    if (touched.has(p.rel)) throw new ToolError("invalid_patch", `${p.rel} appears more than once in the patch.`, "Combine all changes to one file into a single Update File section.");
    touched.add(p.rel);
  };
  const resolve = (raw: string) => paths.get(raw)!;
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

  throwIfCancelled(ctx.signal);
  await commit(planned, ctx);

  const files = planned.map((c) => ({ path: c.target.rel, action: c.action, ...(c.action === "moved" ? { from: c.source.rel } : {}) }));
  const { diff, truncated } = boundedDiff(planned.map((c) => unifiedDiff(c.target.rel, c.before?.text ?? null, c.after)));
  const result: Record<string, unknown> = { files, changed_files: planned.length, diff };
  if (truncated) result.diff_truncated = true;
  return {
    content: JSON.stringify(result),
    result,
    observed: planned.flatMap((c) => [
      ...(c.source.rel !== c.target.rel || c.after === null ? [{ path: c.source.rel, hash: null }] : []),
      ...(c.after !== null ? [{ path: c.target.rel, hash: hashBytes(encoded(c)) }] : []),
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
}

export const applyPatchTool: ToolHandler<ApplyPatchInput> = {
  name: "apply_patch",
  description: [
    "Add, update, move or delete files with one patch, validated first; on failure everything written is rolled back (the user's own changes are kept, conflicts reported).",
    PATCH_FORMAT_HINT,
    'Context lines must match the current file (read it first); "@@ <line>" may name a nearby line, such as a function signature, to anchor a chunk. "*** Move to: path" after Update File renames. For one small replacement prefer edit.',
  ].join(" "),
  schema: ApplyPatchInput,
  concurrency: "serial",
  mutating: true,
  async execute(input, ctx) {
    const workspace = requireWorkspace(ctx);
    const hunks = parsePatch(input.patch);
    const paths = new Map<string, ResolvedPath>();
    for (const raw of hunks.flatMap((h) => (h.kind === "update" && h.moveTo ? [h.path, h.moveTo] : [h.path]))) {
      if (paths.has(raw)) continue;
      if (path.isAbsolute(raw) && !ctx.access) throw new ToolError("invalid_patch", `Patch paths must be workspace-relative; got ${raw}.`, "Use a path relative to the workspace root, such as src/index.ts.");
      paths.set(raw, await ctx.path(raw, "write"));
    }
    return withWorkspaceLock(workspace.root, () => withFileLocks([...paths.values()].map((p) => p.abs), () => {
      for (const file of paths.values()) ctx.recheckPath(file, "write");
      return applyHunks(hunks, paths, ctx);
    }));
  },
};
