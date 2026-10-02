import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ToolError } from "./errors";

export interface ResolvedPath {
  /** Absolute path inside the workspace. */
  abs: string;
  /** Workspace-relative path with forward slashes; "." for the root. */
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
   * Resolve a model-supplied path. Relative paths are taken from the root;
   * absolute paths are accepted only when they lie inside it.
   */
  resolve(input: string, options: { write?: boolean } = {}): ResolvedPath {
    const raw = input.trim();
    if (!raw) throw new ToolError("invalid_path", "The path is empty.", "Pass a workspace-relative path such as src/index.ts.");
    if (raw.includes("\0")) throw new ToolError("invalid_path", "The path contains a NUL character.", "Pass a plain workspace-relative path.");
    const abs = path.resolve(this.root, raw);
    if (!isInside(this.root, abs)) throw outside(input);
    // A symbolic link anywhere along the path must not lead outside the root.
    const real = realOfNearestExisting(abs);
    if (!isInside(this.root, real)) throw outside(input);
    const rel = this.relative(abs);
    if (options.write && (rel === ".git" || rel.startsWith(".git/"))) {
      throw new ToolError("protected_path", `${rel} is repository metadata and cannot be modified with file tools.`, "Use git commands through terminal for repository operations.", false);
    }
    return { abs, rel };
  }

  relative(abs: string): string {
    const rel = path.relative(this.root, abs).split(path.sep).join("/");
    return rel === "" ? "." : rel;
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realOfNearestExisting(abs: string): string {
  let current = abs;
  const rest: string[] = [];
  while (true) {
    try {
      return path.join(realpathSync(current), ...rest.reverse());
    } catch {
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
