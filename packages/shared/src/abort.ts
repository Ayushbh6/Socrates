/** Stop awaiting an operation that may ignore cancellation. Its late result is
 * consumed, never applied by the caller. Give an already settling operation
 * one event-loop turn to return its exact outcome before rejecting. */
export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { timer ??= setTimeout(() => { cleanup(); reject(signal.reason ?? new Error("Aborted")); }, 0); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
