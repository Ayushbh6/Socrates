import path from "node:path";
import { ToolError } from "./errors";

/**
 * Where file and command tools may work, and when they ask first
 * (agent-harness.md, "Access"). Without a policy the goal's workspace is the
 * boundary and only the classic approvals apply.
 */
export interface AccessPolicy {
  /** Folders the tools use without asking; null means anywhere on the computer. */
  folders: string[] | null;
  /** "ask": every edit, patch, command and changing MCP call asks first; "auto": none does. */
  approvals: "ask" | "auto";
  /** Never read, searched, changed or used as a working directory, in any mode. */
  protected: string[];
}

/** A path and what the user allowed for it in one run. */
export interface AccessGrant {
  path: string;
  write: boolean;
}

/** Whether `candidate` is `folder` or lies inside it. macOS compares without case, as its disks do. */
export function within(folder: string, candidate: string): boolean {
  const fold = (p: string) => (process.platform === "darwin" ? p.toLowerCase() : p);
  const rel = path.relative(fold(folder), fold(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export function isProtected(policy: AccessPolicy, abs: string): boolean {
  return policy.protected.some((folder) => within(folder, abs));
}

export function protectedPath(input: string): ToolError {
  return new ToolError("protected_path", `${input} is inside Socrates' own data, which tools never read or change.`, "Leave Socrates' data folders alone and continue without them.", false);
}

/** The `<ACCESS>` lines of the working-agent context. */
export function describeAccess(policy: AccessPolicy): string {
  return [
    policy.folders === null
      ? "files: anywhere on this computer by absolute path (Socrates' own data folders excepted)."
      : `files: ${policy.folders.length ? policy.folders.join(", ") : "no folders yet"}. Any other path, including the workspace when it is not listed, asks the user first, who may refuse.`,
    policy.approvals === "ask"
      ? "approvals: the user approves each edit, patch, command and changing MCP call before it runs, and may refuse. Reading and searching need no approval."
      : "approvals: edits, patches and commands run without asking.",
  ].join("\n");
}
