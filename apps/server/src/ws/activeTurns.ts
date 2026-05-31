import { createWorkspaceShellSession, FileFreshnessTracker, type WorkspaceShellSession } from "@socrates/workspace"

export class ActiveTurns {
  private readonly turns = new Map<
    string,
    {
      controller: AbortController
      approvals: Map<string, (decision: { decision: "approved" | "rejected"; reason?: string }) => void>
      shellSession?: WorkspaceShellSession
      fileFreshness: FileFreshnessTracker
    }
  >()

  create(turnId: string): AbortController {
    const controller = new AbortController()
    this.turns.set(turnId, { controller, approvals: new Map(), fileFreshness: new FileFreshnessTracker() })
    return controller
  }

  getFileFreshness(turnId: string): FileFreshnessTracker | undefined {
    return this.turns.get(turnId)?.fileFreshness
  }

  get(turnId: string): AbortController | undefined {
    return this.turns.get(turnId)?.controller
  }

  getShellSession(turnId: string, workspacePath: string): WorkspaceShellSession {
    const turn = this.turns.get(turnId)
    if (!turn) {
      throw new Error("Turn is no longer active.")
    }
    turn.shellSession ??= createWorkspaceShellSession(workspacePath)
    return turn.shellSession
  }

  resetShellSession(turnId: string, workspacePath: string): WorkspaceShellSession {
    const turn = this.turns.get(turnId)
    if (!turn) {
      throw new Error("Turn is no longer active.")
    }
    turn.shellSession?.dispose()
    turn.shellSession = createWorkspaceShellSession(workspacePath)
    return turn.shellSession
  }

  waitForApproval(
    turnId: string,
    approvalId: string,
    abortSignal?: AbortSignal,
  ): Promise<{ decision: "approved" | "rejected"; reason?: string }> {
    const turn = this.turns.get(turnId)
    if (!turn) {
      return Promise.resolve({ decision: "rejected", reason: "Turn is no longer active." })
    }
    return new Promise((resolve) => {
      const cleanup = () => {
        turn.approvals.delete(approvalId)
        abortSignal?.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        cleanup()
        resolve({ decision: "rejected", reason: "Turn was cancelled." })
      }
      turn.approvals.set(approvalId, (decision) => {
        cleanup()
        resolve(decision)
      })
      abortSignal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  resolveApproval(approvalId: string, decision: { decision: "approved" | "rejected"; reason?: string }): boolean {
    for (const turn of this.turns.values()) {
      const waiter = turn.approvals.get(approvalId)
      if (waiter) {
        waiter(decision)
        return true
      }
    }
    return false
  }

  delete(turnId: string): void {
    const turn = this.turns.get(turnId)
    if (turn) {
      for (const waiter of turn.approvals.values()) {
        waiter({ decision: "rejected", reason: "Turn ended before approval was resolved." })
      }
      turn.shellSession?.dispose()
    }
    this.turns.delete(turnId)
  }

  abortAll(): void {
    for (const [turnId, turn] of [...this.turns]) {
      turn.controller.abort()
      this.delete(turnId)
    }
  }
}
