/** Shared pieces of the streaming adapters. */

/**
 * A stream that goes quiet has failed; the whole reply may take as long as it
 * needs. `touch` after every received piece; `idled` says the silence, not
 * the caller, ended the request.
 */
export function idleGuard(signal: AbortSignal | undefined, ms: number) {
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), ms);
  };
  touch();
  return {
    signal: AbortSignal.any([...(signal ? [signal] : []), idle.signal]),
    touch,
    stop: () => clearTimeout(timer),
    idled: () => idle.signal.aborted && !signal?.aborted,
  };
}

/** The events of a server-sent-events body: its `event:` name (if any) and its `data:` text. */
export async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      if (done) buffer += decoder.decode();
      // Events end at a blank line; the last one may end at the end of the body.
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = done ? "" : parts.pop()!;
      for (const part of done ? parts.filter(Boolean) : parts) {
        let event: string | null = null;
        const data: string[] = [];
        for (const line of part.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
