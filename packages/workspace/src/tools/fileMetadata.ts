import { createHash } from "node:crypto"
import fs from "node:fs"

export type LineEnding = "lf" | "crlf" | "cr" | "mixed" | "none"

export type FileSnapshot = {
  exists: boolean
  content?: string
  buffer?: Buffer
  contentHash?: string
  sizeBytes?: number
  mtimeMs?: number
  mode?: number
  lineEnding?: LineEnding
  lineCount?: number
}

export const hashBuffer = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex")

export const hashText = (text: string): string => hashBuffer(Buffer.from(text, "utf8"))

export const readFileSnapshot = (filePath: string, options: { includeText?: boolean } = {}): FileSnapshot => {
  if (!fs.existsSync(filePath)) {
    return { exists: false }
  }
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) {
    return {
      exists: true,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      mode: stat.mode,
    }
  }
  const buffer = fs.readFileSync(filePath)
  const content = options.includeText ? buffer.toString("utf8") : undefined
  return {
    exists: true,
    ...(content === undefined ? {} : { content, lineEnding: detectLineEnding(content), lineCount: countLines(content) }),
    buffer,
    contentHash: hashBuffer(buffer),
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode,
  }
}

export const detectLineEnding = (text: string): LineEnding => {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const withoutCrlf = text.replaceAll("\r\n", "")
  const lf = (withoutCrlf.match(/\n/g) ?? []).length
  const cr = (withoutCrlf.match(/\r/g) ?? []).length
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length
  if (kinds === 0) {
    return "none"
  }
  if (kinds > 1) {
    return "mixed"
  }
  if (crlf > 0) {
    return "crlf"
  }
  if (lf > 0) {
    return "lf"
  }
  return "cr"
}

export const countLines = (text: string): number => {
  if (text.length === 0) {
    return 0
  }
  return text.split(/\r\n|\r|\n/).length
}
