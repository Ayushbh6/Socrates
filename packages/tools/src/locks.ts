/**
 * One mutation lock per workspace root, shared by every runner in the
 * process, so file mutations of different runs on the same workspace never
 * interleave between their freshness check and their write.
 */
const tails = new Map<string, Promise<unknown>>();

export async function withWorkspaceLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(root) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.catch(() => {});
  tails.set(root, tail);
  try {
    return await run;
  } finally {
    if (tails.get(root) === tail) tails.delete(root);
  }
}
