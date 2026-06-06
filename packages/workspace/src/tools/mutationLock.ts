import path from "node:path"
import type { BashToolInput } from "@socrates/contracts"

const workspaceMutationQueues = new Map<string, Promise<void>>()

export const withWorkspaceMutationLock = async <T>(workspacePath: string, operation: () => Promise<T>): Promise<T> => {
  const key = path.resolve(workspacePath)
  const previous = workspaceMutationQueues.get(key) ?? Promise.resolve()
  const waitForPrevious = previous.catch(() => undefined)
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = waitForPrevious.then(() => current)
  workspaceMutationQueues.set(key, tail)

  await waitForPrevious
  try {
    return await operation()
  } finally {
    release()
    if (workspaceMutationQueues.get(key) === tail) {
      workspaceMutationQueues.delete(key)
    }
  }
}

export const isWorkspaceMutationLocked = (workspacePath: string): boolean => workspaceMutationQueues.has(path.resolve(workspacePath))

export const shouldSerializeBashInput = (input: BashToolInput): boolean => {
  const operation = input.operation ?? "run"
  if (operation !== "run") {
    return false
  }
  const command = input.command?.trim() ?? ""
  if (!command || isLikelyBackgroundCommand(command)) {
    return false
  }
  return !isReadOnlyCommand(command)
}

const isLikelyBackgroundCommand = (command: string): boolean =>
  /\b(pnpm|npm|yarn|bun)\s+(dev|start|serve)\b|\b(next|vite|astro|webpack|turbo)\s+dev\b|\b(uvicorn|fastapi|flask|django-admin)\b|\b(npx|pnpm\s+dlx|yarn\s+dlx|bunx)\b/i.test(
    command,
  )

const isReadOnlyCommand = (command: string): boolean => {
  const trimmed = command.trim()
  return (
    /^(pwd|ls|find|rg|grep|cat|sed|head|tail|wc|where)\b/i.test(trimmed) ||
    /^git\s+(status|diff|log|show|rev-parse|ls-files)\b/i.test(trimmed) ||
    /^git\s+branch\s*(--show-current|--list|-a|-r|-v|-vv)?\s*$/i.test(trimmed) ||
    /^(Get-Location|Get-ChildItem|Get-Content|Select-String|Get-Command)\b/i.test(trimmed) ||
    /^(python|python3|py|node|pnpm|npm|yarn|bun)\s+(--version|-v|version)\b/i.test(trimmed)
  )
}
