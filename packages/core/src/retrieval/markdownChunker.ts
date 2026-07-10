import { createHash } from "node:crypto"
import { estimateTextTokens } from "@socrates/providers"
import type { MarkdownChunk, RetrievalChunkIdentityInput } from "./types"

export const DEFAULT_RETRIEVAL_CHUNK_TOKENS = 500
export const DEFAULT_RETRIEVAL_CHUNK_OVERLAP = 150

export const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex")

export const retrievalChunkId = (input: RetrievalChunkIdentityInput): string =>
  sha256Hex([input.corpusKind, input.parentId, input.discriminator, input.chunkIndex, input.contentHash].join("\0"))

export const embeddingFingerprint = (input: {
  providerId: string
  modelId: string
  dimensions: number
  contentHash: string
}): string => sha256Hex([input.providerId, input.modelId, input.dimensions, input.contentHash].join("\0"))

export const chunkMarkdown = (
  value: string,
  options: { targetTokens?: number; overlapTokens?: number } = {},
): MarkdownChunk[] => {
  const text = value.replaceAll("\r\n", "\n").trim()
  if (!text) {
    return []
  }
  const targetTokens = Math.max(32, options.targetTokens ?? DEFAULT_RETRIEVAL_CHUNK_TOKENS)
  const overlapTokens = Math.min(Math.max(0, options.overlapTokens ?? DEFAULT_RETRIEVAL_CHUNK_OVERLAP), targetTokens - 1)
  const blocks = splitMarkdownBlocks(text).flatMap((block) => splitOversizedBlock(block, targetTokens, overlapTokens))
  const contents: string[] = []
  let current = ""

  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block
    if (!current || tokenCount(candidate) <= targetTokens) {
      current = candidate
      continue
    }
    contents.push(current.trim())
    const overlap = trailingTokenBoundedText(current, overlapTokens)
    current = overlap ? `${overlap}\n\n${block}` : block
    if (tokenCount(current) > targetTokens) {
      const forced = splitOversizedBlock(current, targetTokens, overlapTokens)
      contents.push(...forced.slice(0, -1).map((part) => part.trim()))
      current = forced.at(-1) ?? ""
    }
  }
  if (current.trim()) {
    contents.push(current.trim())
  }

  return contents.map((content, chunkIndex) => ({
    content,
    chunkIndex,
    tokenCount: tokenCount(content),
    contentHash: sha256Hex(content),
  }))
}

const splitMarkdownBlocks = (text: string): string[] => {
  const lines = text.split("\n")
  const blocks: string[] = []
  let current: string[] = []
  let fenced = false

  const flush = () => {
    const block = current.join("\n").trim()
    if (block) blocks.push(block)
    current = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("```")) {
      if (!fenced && current.length > 0) flush()
      current.push(line)
      fenced = !fenced
      if (!fenced) flush()
      continue
    }
    if (fenced) {
      current.push(line)
      continue
    }
    if (/^#{1,6}\s/.test(trimmed)) {
      flush()
      current.push(line)
      continue
    }
    if (!trimmed) {
      flush()
      continue
    }
    current.push(line)
  }
  flush()
  return blocks
}

const splitOversizedBlock = (block: string, targetTokens: number, overlapTokens: number): string[] => {
  if (tokenCount(block) <= targetTokens) {
    return [block]
  }
  const words = block.split(/\s+/).filter(Boolean)
  const parts: string[] = []
  let start = 0
  while (start < words.length) {
    let low = start + 1
    let high = words.length
    let end = low
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (tokenCount(words.slice(start, middle).join(" ")) <= targetTokens) {
        end = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    const part = words.slice(start, end).join(" ").trim()
    if (!part) break
    parts.push(part)
    if (end >= words.length) break
    const overlapStart = overlapTokens > 0 ? findOverlapStart(words, start, end, overlapTokens) : end
    start = Math.max(start + 1, overlapStart)
  }
  return parts
}

const findOverlapStart = (words: string[], lowerBound: number, end: number, overlapTokens: number): number => {
  let start = end
  while (start > lowerBound && tokenCount(words.slice(start - 1, end).join(" ")) <= overlapTokens) {
    start -= 1
  }
  return start
}

const trailingTokenBoundedText = (text: string, tokenLimit: number): string => {
  if (tokenLimit <= 0) return ""
  const words = text.split(/\s+/).filter(Boolean)
  let start = words.length
  while (start > 0 && tokenCount(words.slice(start - 1).join(" ")) <= tokenLimit) {
    start -= 1
  }
  return words.slice(start).join(" ")
}

const tokenCount = (value: string): number =>
  estimateTextTokens(value, { applySafetyMargin: false }).inputTokens
