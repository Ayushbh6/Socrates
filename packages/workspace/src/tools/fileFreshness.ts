import { SocratesError } from "@socrates/shared"
import { toWorkspaceRelativePath } from "./common"

export class FileFreshnessTracker {
  private readonly hashes = new Map<string, string>()

  record(path: string, contentHash: string | undefined, workspacePath: string): void {
    if (!contentHash) {
      return
    }
    this.hashes.set(toWorkspaceRelativePath(workspacePath, path), contentHash)
  }

  validate(path: string, actualHash: string | undefined, workspacePath: string): void {
    const relativePath = toWorkspaceRelativePath(workspacePath, path)
    const expected = this.hashes.get(relativePath)
    if (!expected) {
      throw new SocratesError("edit_stale_content", `read() has not been called on ${relativePath} in this turn. Call read("${relativePath}") first, then retry the edit.`, {
        details: { path: relativePath, actualHash },
        recoverable: true,
      })
    }
    if (actualHash !== expected) {
      throw new SocratesError("edit_stale_content", `File content changed since Socrates last read ${relativePath}. Call read("${relativePath}") again, then retry the edit.`, {
        details: { path: relativePath, expectedBaseContentHash: expected, actualHash },
        recoverable: true,
      })
    }
  }
}
