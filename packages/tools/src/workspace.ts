import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ToolError } from "./errors";

export interface ResolvedPath {
  /** Absolute real path. */
  abs: string;
  /** Workspace-relative path with forward slashes ("." for the root), or the absolute path outside it. */
  rel: string;
}

/**
 * The selected workspace and its access policy (agent-harness.md, "Safety and
 * long-running work"). Every filesystem and terminal path goes through
 * `resolve`, which rejects paths outside the root, including escapes through
 * symbolic links, and protects repository metadata from mutation.
 */
export class WorkspaceRoot {
  private constructor(
    readonly name: string,
    /** The real (symlink-resolved) absolute root. */
    readonly root: string,
  ) {}

  static open(name: string, rootPath: string): WorkspaceRoot {
    let real: string;
    try {
      real = realpathSync(rootPath);
    } catch {
      throw new Error(`Workspace root does not exist: ${rootPath}`);
    }
    if (!statSync(real).isDirectory()) throw new Error(`Workspace root is not a directory: ${rootPath}`);
    return new WorkspaceRoot(name, real);
  }

  /**
   * Resolve a model-supplied path to its canonical location. Relative paths
   * are taken from the root; absolute paths are accepted only when they lie
   * inside it, unless `anywhere` is set by an access policy, which then
   * decides (agent-harness.md, "Access"); there `~` is the user's home.
   * Symbolic links are resolved first, so every policy (containment,
   * protected metadata) and every per-file record (stale-edit observations)
   * applies to the real target, never to an alias of it.
   */
  resolve(input: string, options: { write?: boolean; anywhere?: boolean } = {}): ResolvedPath {
    let raw = input.trim();
    if (!raw) throw new ToolError("invalid_path", "The path is empty.", "Pass a workspace-relative path such as src/index.ts.");
    if (raw.includes("\0")) throw new ToolError("invalid_path", "The path contains a NUL character.", "Pass a plain workspace-relative path.");
    if (options.anywhere && (raw === "~" || raw.startsWith("~/"))) raw = path.join(homedir(), raw.slice(1));
    const requested = path.resolve(this.root, raw);
    if (!options.anywhere && !isInside(this.root, requested)) throw outside(input);
    const abs = canonicalPath(requested);
    if (!options.anywhere && !isInside(this.root, abs)) throw outside(input);
    const rel = this.relative(abs);
    if (options.write && isRepositoryMetadata(rel)) {
      throw new ToolError("protected_path", `${raw} is repository metadata (${rel}) and cannot be modified with file tools.`, "Use git commands through terminal for repository operations.", false);
    }
    return { abs, rel };
  }

  relative(abs: string): string {
    if (!isInside(this.root, abs)) return abs.split(path.sep).join("/");
    const rel = path.relative(this.root, abs).split(path.sep).join("/");
    return rel === "" ? "." : rel;
  }
}

function isRepositoryMetadata(rel: string): boolean {
  return rel.split("/").some((part) => part.toLowerCase() === ".git");
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function canonicalPath(abs: string): string {
  let current = abs;
  const rest: string[] = [];
  while (true) {
    try {
      return path.join(realpathSync(current), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return abs;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function outside(input: string): ToolError {
  return new ToolError(
    "outside_workspace",
    `${input} is outside the selected workspace.`,
    "Use a path inside the workspace, relative to its root (for example src/index.ts).",
    false,
  );
}
