import type { UrlFetchToolInput, UrlFetchToolOutput } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"

const defaultCharLimit = 20_000
const maxBodyBytes = 1_000_000

const textContentTypePattern =
  /^(text\/|application\/(?:json|ld\+json|x-ndjson|xml|xhtml\+xml|javascript)|image\/svg\+xml\b)|\+(?:json|xml)\b/i

export const fetchUrlForTool = async (input: UrlFetchToolInput, signal?: AbortSignal): Promise<UrlFetchToolOutput> => {
  const charLimit = input.charLimit ?? defaultCharLimit
  const byteLimit = Math.min(Math.max(charLimit * 8, 64_000), maxBodyBytes)
  const timeoutMs = input.timeoutMs ?? 15_000
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })

  try {
    const response = await fetch(input.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.8,*/*;q=0.2",
        "user-agent": "Socrates-url-fetch/1.0",
      },
    })
    const contentType = response.headers.get("content-type") ?? undefined
    const contentLength = parseContentLength(response.headers.get("content-length"))
    const warnings: string[] = []

    if (contentLength !== undefined && contentLength > byteLimit) {
      warnings.push(`Content-Length is ${contentLength} bytes; url_fetch will read at most ${byteLimit} bytes.`)
    }

    if (contentType && !isTextContentType(contentType)) {
      return {
        url: input.url,
        finalUrl: response.url,
        status: response.status,
        ok: response.ok,
        redirected: response.redirected,
        contentType,
        ...(contentLength === undefined ? {} : { contentLength }),
        sizeBytes: 0,
        truncation: { truncated: false, charLimit, returnedLength: 0 },
        warnings: [...warnings, "Non-text response body was not returned."],
      }
    }

    const { bytes, truncated } = await readBodyBytes(response, byteLimit)
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
    const text = decoded.length > charLimit ? decoded.slice(0, charLimit) : decoded
    const title = extractTitle(text)
    const textTruncated = truncated || decoded.length > charLimit

    return {
      url: input.url,
      finalUrl: response.url,
      status: response.status,
      ok: response.ok,
      redirected: response.redirected,
      ...(contentType ? { contentType } : {}),
      ...(contentLength === undefined ? {} : { contentLength }),
      sizeBytes: bytes.byteLength,
      text,
      ...(title ? { title } : {}),
      truncation: {
        truncated: textTruncated,
        charLimit,
        ...(textTruncated ? { originalLength: decoded.length } : {}),
        returnedLength: text.length,
        ...(decoded.length > charLimit ? { nextOffset: charLimit } : {}),
      },
      ...(warnings.length > 0 || truncated ? { warnings: truncated ? [...warnings, "Response body was truncated before decoding."] : warnings } : {}),
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new SocratesError("url_fetch_timeout", `URL fetch timed out after ${timeoutMs}ms.`, { recoverable: true })
    }
    throw new SocratesError("url_fetch_failed", error instanceof Error ? error.message : "URL fetch failed.", { recoverable: true })
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  }
}

const parseContentLength = (value: string | null): number | undefined => {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

const isTextContentType = (value: string): boolean => textContentTypePattern.test(value.toLowerCase())

const readBodyBytes = async (response: Response, byteLimit: number): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
  if (!response.body) {
    return { bytes: new Uint8Array(), truncated: false }
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done || !value) {
        break
      }
      const remaining = byteLimit - total
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, Math.max(remaining, 0)))
        total = byteLimit
        truncated = true
        await reader.cancel()
        break
      }
      chunks.push(value)
      total += value.byteLength
      if (total >= byteLimit) {
        truncated = true
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes: merged, truncated }
}

const extractTitle = (text: string): string | undefined => {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)
  if (!match?.[1]) {
    return undefined
  }
  return decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim()).slice(0, 300)
}

const decodeHtmlEntities = (text: string): string =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
