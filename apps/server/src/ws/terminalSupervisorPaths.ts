import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"

export const terminalSupervisorProtocolVersion = "pty-v4-20260715-lifecycle"

export const terminalSupervisorSocketPath = (scope: string): string => {
  const hash = crypto.createHash("sha256").update(`${scope}:${terminalSupervisorProtocolVersion}`).digest("hex").slice(0, 16)
  return process.platform === "win32" ? `\\\\.\\pipe\\socrates-terminal-${hash}` : path.join(os.tmpdir(), `socrates-terminal-${hash}.sock`)
}

export const terminalHostSocketPath = (supervisorSocketPath: string, terminalId: string): string => {
  const suffix = crypto.createHash("sha256").update(terminalId).digest("hex").slice(0, 16)
  return process.platform === "win32"
    ? `\\\\.\\pipe\\socrates-terminal-host-${suffix}`
    : path.join(path.dirname(supervisorSocketPath), `socrates-terminal-host-${suffix}.sock`)
}
