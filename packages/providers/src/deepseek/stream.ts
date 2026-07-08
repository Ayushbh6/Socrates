import type { DeepSeekChatCompletionChunk } from "./types"

export const readDeepSeekSse = async function* (
  response: Response,
  onChunk?: () => void,
): AsyncIterable<DeepSeekChatCompletionChunk> {
  const reader = response.body?.getReader()
  if (!reader) {
    const value = (await response.json()) as DeepSeekChatCompletionChunk
    yield value
    return
  }
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      onChunk?.()
      buffer += decoder.decode(value, { stream: true })
      const chunks = parseSseBuffer(buffer, false)
      buffer = chunks.remainder
      for (const chunk of chunks.values) {
        yield chunk
      }
    }
    buffer += decoder.decode()
    const chunks = parseSseBuffer(buffer, true)
    for (const chunk of chunks.values) {
      yield chunk
    }
  } finally {
    reader.releaseLock()
  }
}

const parseSseBuffer = (
  buffer: string,
  final: boolean,
): { values: DeepSeekChatCompletionChunk[]; remainder: string } => {
  const values: DeepSeekChatCompletionChunk[] = []
  let cursor = 0
  for (;;) {
    const lineBreak = buffer.indexOf("\n", cursor)
    if (lineBreak < 0) {
      break
    }
    const line = buffer.slice(cursor, lineBreak).trim()
    cursor = lineBreak + 1
    const value = parseSseLine(line)
    if (value) {
      values.push(value)
    }
  }
  const remainder = final ? "" : buffer.slice(cursor)
  if (final) {
    const value = parseSseLine(buffer.slice(cursor).trim())
    if (value) {
      values.push(value)
    }
  }
  return { values, remainder }
}

const parseSseLine = (line: string): DeepSeekChatCompletionChunk | undefined => {
  if (!line || line.startsWith(":") || !line.startsWith("data:")) {
    return undefined
  }
  const data = line.slice("data:".length).trim()
  if (!data || data === "[DONE]") {
    return undefined
  }
  return JSON.parse(data) as DeepSeekChatCompletionChunk
}
