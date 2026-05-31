import path from "node:path"

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
