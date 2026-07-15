import { createWorkspaceShellSession, FileFreshnessTracker, type WorkspaceShellSession } from "@socrates/workspace"

export class ActiveTurns {
  private readonly idleWaiters = new Set<() => void>()
  private readonly turns = new Map<
    string,
    {
      controller: AbortController
      approvals: Map<string, (decision: { decision: "approved" | "rejected"; reason?: string }) => void>
      credentialInputs: Map<
        string,
        (decision: { decision: "submitted" | "cancelled"; value?: string; source: "user_input" | "workspace_env" }) => void
      >
      shellSession?: WorkspaceShellSession
      fileFreshness: FileFreshnessTracker
    }
  >()

  create(turnId: string): AbortController {
    const controller = new AbortController()
    this.turns.set(turnId, { controller, approvals: new Map(), credentialInputs: new Map(), fileFreshness: new FileFreshnessTracker() })
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

  waitForCredentialInput(
    turnId: string,
    credentialRequestId: string,
    source: "user_input" | "workspace_env",
    abortSignal?: AbortSignal,
  ): Promise<{ decision: "submitted" | "cancelled"; value?: string; source: "user_input" | "workspace_env" }> {
    const turn = this.turns.get(turnId)
    if (!turn) {
      return Promise.resolve({ decision: "cancelled", source })
    }
    return new Promise((resolve) => {
      const cleanup = () => {
        turn.credentialInputs.delete(credentialRequestId)
        abortSignal?.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        cleanup()
        resolve({ decision: "cancelled", source })
      }
      turn.credentialInputs.set(credentialRequestId, (decision) => {
        cleanup()
        resolve(decision)
      })
      abortSignal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  resolveCredentialInput(
    turnId: string,
    credentialRequestId: string,
    decision: { decision: "submitted" | "cancelled"; value?: string; source: "user_input" | "workspace_env" },
  ): boolean {
    const waiter = this.turns.get(turnId)?.credentialInputs.get(credentialRequestId)
    if (waiter) {
      waiter(decision)
      return true
    }
    return false
  }

  delete(turnId: string): void {
    const turn = this.turns.get(turnId)
    if (turn) {
      this.releaseTurnResources(turn, "Turn ended before approval was resolved.")
    }
    this.turns.delete(turnId)
    if (this.turns.size === 0) {
      for (const resolve of this.idleWaiters) resolve()
      this.idleWaiters.clear()
    }
  }

  abortAll(): void {
    for (const turn of this.turns.values()) {
      turn.controller.abort()
      this.releaseTurnResources(turn, "Turn was cancelled because Socrates is shutting down.")
    }
  }

  async waitForIdle(timeoutMs = 10_000): Promise<boolean> {
    if (this.turns.size === 0) return true
    let timeout: NodeJS.Timeout | undefined
    const idle = new Promise<boolean>((resolve) => {
      const onIdle = () => {
        clearTimeout(timeout)
        resolve(true)
      }
      this.idleWaiters.add(onIdle)
      timeout = setTimeout(() => {
        this.idleWaiters.delete(onIdle)
        resolve(false)
      }, timeoutMs)
      timeout.unref?.()
    })
    return idle
  }

  private releaseTurnResources(
    turn: {
      approvals: Map<string, (decision: { decision: "approved" | "rejected"; reason?: string }) => void>
      credentialInputs: Map<string, (decision: { decision: "submitted" | "cancelled"; value?: string; source: "user_input" | "workspace_env" }) => void>
      shellSession?: WorkspaceShellSession
    },
    reason: string,
  ): void {
    for (const waiter of [...turn.approvals.values()]) waiter({ decision: "rejected", reason })
    for (const waiter of [...turn.credentialInputs.values()]) waiter({ decision: "cancelled", source: "user_input" })
    turn.approvals.clear()
    turn.credentialInputs.clear()
    turn.shellSession?.dispose()
    delete turn.shellSession
  }
}
