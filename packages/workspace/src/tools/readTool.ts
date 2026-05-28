import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { ReadToolInput, ReadToolOutput } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { clampCharLimit, emptyTruncation, isProbablyBinary, resolveWorkspacePath, toWorkspaceRelativePath, truncateText } from "./common"
import { detectLineEnding, hashBuffer } from "./fileMetadata"

const execFileAsync = promisify(execFile)

const nonVisionModelIds = new Set(["z-ai/glm-5.1", "xiaomi/mimo-v2.5-pro", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"])

export const readWorkspacePath = async (
  input: ReadToolInput,
  context: { workspacePath: string; runtimeConfig?: { providerId?: string; modelId?: string } },
): Promise<ReadToolOutput> => {
  const absolutePath = resolveWorkspacePath(context.workspacePath, input.path)
  const relativePath = toWorkspaceRelativePath(context.workspacePath, absolutePath)
  const charLimit = clampCharLimit(input.charLimit)

  let stat
  try {
    stat = await fs.stat(absolutePath)
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code === "ENOENT") {
      return {
        path: relativePath,
        kind: "missing",
        truncation: emptyTruncation(charLimit),
        warnings: ["Path does not exist."],
      }
    }
    throw error
  }

  if (stat.isDirectory()) {
    const entries = (await fs.readdir(absolutePath, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, 200)
      .map((entry) => ({
        name: entry.name,
        path: toWorkspaceRelativePath(context.workspacePath, path.join(absolutePath, entry.name)),
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      }))
    return {
      path: relativePath,
      kind: "directory",
      entries,
      truncation: {
        truncated: entries.length === 200,
        charLimit,
        returnedLength: entries.length,
      },
    }
  }

  const fileBuffer = await fs.readFile(absolutePath)
  const fileMetadata = {
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    contentHash: hashBuffer(fileBuffer),
  }
  const ext = path.extname(absolutePath).toLowerCase()
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg"].includes(ext)) {
    const isSvg = ext === ".svg"
    const svgText = isSvg ? fileBuffer.toString("utf8") : undefined
    const content = svgText === undefined ? undefined : truncateText(svgText, charLimit, input.offset)
    const nativeVisionSupported = !context.runtimeConfig?.modelId || !nonVisionModelIds.has(context.runtimeConfig.modelId)
    return {
      path: relativePath,
      kind: "image",
      ...(content ? { content: content.text } : {}),
      ...fileMetadata,
      ...(svgText === undefined ? {} : { lineEnding: detectLineEnding(svgText) }),
      mimeType: imageMimeType(ext),
      image: {
        mediaType: imageMimeType(ext),
        nativeVisionSupported,
        description: nativeVisionSupported
          ? "Image metadata is available. Native vision providers may inspect the image directly in a later provider pass."
          : "The selected model does not support native vision, so it cannot directly inspect this image. Use a vision-capable model for visual understanding.",
      },
      truncation: content?.truncation ?? emptyTruncation(charLimit),
      ...(nativeVisionSupported
        ? {}
        : { warnings: ["The selected model does not support native vision and cannot directly inspect image pixels."] }),
    }
  }

  if (ext === ".pdf") {
    const extracted = await tryExtractCommand("pdftotext", [absolutePath, "-"])
    if (extracted !== null) {
      const truncated = truncateText(extracted, charLimit, input.offset)
      return { path: relativePath, kind: "pdf", content: truncated.text, ...fileMetadata, truncation: truncated.truncation }
    }
    return {
      path: relativePath,
      kind: "pdf",
      ...fileMetadata,
      truncation: emptyTruncation(charLimit),
      warnings: ["PDF text extraction is unavailable because pdftotext failed or is not installed."],
    }
  }

  if ([".docx", ".doc", ".rtf", ".odt"].includes(ext)) {
    const extracted = (await tryExtractCommand("textutil", ["-convert", "txt", "-stdout", absolutePath])) ?? (await extractZippedXml(absolutePath, "word/document.xml"))
    if (extracted !== null) {
      const truncated = truncateText(extracted, charLimit, input.offset)
      return { path: relativePath, kind: "document", content: truncated.text, ...fileMetadata, truncation: truncated.truncation }
    }
  }

  if ([".pptx", ".ppt"].includes(ext)) {
    const extracted = await extractZippedXml(absolutePath, "ppt/slides/*.xml")
    if (extracted !== null) {
      const truncated = truncateText(extracted, charLimit, input.offset)
      return { path: relativePath, kind: "presentation", content: truncated.text, ...fileMetadata, truncation: truncated.truncation }
    }
  }

  if (isProbablyBinary(fileBuffer)) {
    return {
      path: relativePath,
      kind: "binary",
      ...fileMetadata,
      truncation: emptyTruncation(charLimit),
      warnings: ["Binary file was not read into model context."],
    }
  }

  const text = fileBuffer.toString("utf8")
  const truncated = truncateText(text, charLimit, input.offset)
  return {
    path: relativePath,
    kind: [".csv", ".tsv"].includes(ext) ? "spreadsheet" : "file",
    content: truncated.text,
    ...fileMetadata,
    lineEnding: detectLineEnding(text),
    truncation: truncated.truncation,
  }
}

const tryExtractCommand = async (command: string, args: string[]): Promise<string | null> => {
  try {
    const result = await execFileAsync(command, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 2_000_000 })
    return result.stdout
  } catch {
    return null
  }
}

const extractZippedXml = async (filePath: string, member: string): Promise<string | null> => {
  const output = await tryExtractCommand("unzip", ["-p", filePath, member])
  return output === null ? null : stripXml(output)
}

const stripXml = (text: string): string =>
  text
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/&amp;/g, "&")
    .replaceAll(/&lt;/g, "<")
    .replaceAll(/&gt;/g, ">")
    .replaceAll(/\s+/g, " ")
    .trim()

const imageMimeType = (ext: string): string => {
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".png":
      return "image/png"
    case ".gif":
      return "image/gif"
    case ".webp":
      return "image/webp"
    case ".svg":
      return "image/svg+xml"
    case ".heic":
      return "image/heic"
    default:
      throw new SocratesError("unsupported_image_type", "Unsupported image type", { details: { ext } })
  }
}
