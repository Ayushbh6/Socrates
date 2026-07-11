import crypto from "node:crypto"
import dns from "node:dns/promises"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import yauzl, { type Entry, type ZipFile } from "yauzl"
import type {
  CommitSkillImportResponse,
  SkillImportPreview,
  SkillImportScope,
  SkillImportWarning,
  SkillSummary,
} from "@socrates/contracts"
import { skillImportPreviewSchema } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import {
  parseSkillMarkdown,
  readSkillInfo,
  readSkillProvenance,
  SKILL_PROVENANCE_FILE,
  skillSummary,
  writeSkillProvenance,
} from "./memorySkills"

const MAX_ARCHIVE_BYTES = 30 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 30 * 1024 * 1024
const MAX_FILE_BYTES = 15 * 1024 * 1024
const MAX_SKILL_MD_BYTES = 512 * 1024
const MAX_FILES = 200
const MAX_PATH_LENGTH = 240
const MAX_PATH_DEPTH = 9
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1_000
const DOWNLOAD_TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 5

export type SkillImportTarget = {
  scope: SkillImportScope
  projectId?: string
  root: string
}

type SkillArchiveDownloadOptions = {
  fetchImpl?: typeof fetch
  resolveHostname?: (hostname: string) => Promise<string[]>
  signal?: AbortSignal
}

type StagedSkillImport = SkillImportPreview & {
  targetRoot: string
  sourceDirectory: string
}

export const previewSkillArchiveFromUrl = async (input: {
  socratesHome: string
  target: SkillImportTarget
  url: string
  options?: SkillArchiveDownloadOptions
}): Promise<SkillImportPreview> => {
  const archive = await downloadSkillArchive(input.url, input.options)
  return previewSkillArchive({
    socratesHome: input.socratesHome,
    target: input.target,
    filename: archive.filename,
    data: archive.data,
  })
}

export const downloadSkillArchive = async (
  sourceUrl: string,
  options: SkillArchiveDownloadOptions = {},
): Promise<{ data: Buffer; filename: string; finalUrl: string }> => {
  const fetchImpl = options.fetchImpl ?? fetch
  const resolveHostname = options.resolveHostname ?? resolvePublicAddresses
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  const abort = () => controller.abort()
  options.signal?.addEventListener("abort", abort, { once: true })
  let currentUrl = validatePublicSkillUrl(sourceUrl)

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await assertPublicHost(currentUrl.hostname, resolveHostname)
      const response = await fetchImpl(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/zip,application/octet-stream;q=0.9,*/*;q=0.1",
          "user-agent": "Socrates-skill-import/1.0",
        },
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        await response.body?.cancel()
        if (!location) throw new SocratesError("skill_import_redirect_invalid", "Skill ZIP URL redirected without a destination.", { recoverable: true })
        if (redirects === MAX_REDIRECTS) throw new SocratesError("skill_import_redirect_limit", `Skill ZIP URL may redirect at most ${MAX_REDIRECTS} times.`, { recoverable: true })
        currentUrl = validatePublicSkillUrl(new URL(location, currentUrl).toString())
        continue
      }
      if (!response.ok) {
        throw new SocratesError("skill_import_download_failed", `Skill ZIP download returned HTTP ${response.status}.`, {
          recoverable: true,
          details: { status: response.status, url: currentUrl.toString() },
        })
      }
      const declaredBytes = parsePositiveContentLength(response.headers.get("content-length"))
      if (declaredBytes !== undefined && declaredBytes > MAX_ARCHIVE_BYTES) {
        throw new SocratesError("skill_import_size_invalid", "Skill ZIP may not exceed 30 MB.", {
          recoverable: true,
          details: { maxBytes: MAX_ARCHIVE_BYTES, declaredBytes },
        })
      }
      const data = await readBoundedResponse(response, MAX_ARCHIVE_BYTES)
      if (data.length === 0 || data[0] !== 0x50 || data[1] !== 0x4b) {
        throw new SocratesError("skill_import_zip_required", "The supplied URL did not return a ZIP package.", { recoverable: true })
      }
      const filename = skillArchiveFilename(response.headers.get("content-disposition"), currentUrl)
      return { data, filename, finalUrl: currentUrl.toString() }
    }
    throw new SocratesError("skill_import_redirect_limit", `Skill ZIP URL may redirect at most ${MAX_REDIRECTS} times.`, { recoverable: true })
  } catch (error) {
    if (error instanceof SocratesError) throw error
    if (error instanceof Error && error.name === "AbortError") {
      throw new SocratesError("skill_import_download_timeout", `Skill ZIP download timed out after ${DOWNLOAD_TIMEOUT_MS / 1_000} seconds.`, { recoverable: true })
    }
    throw new SocratesError("skill_import_download_failed", error instanceof Error ? error.message : "Skill ZIP download failed.", { recoverable: true })
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", abort)
  }
}

export const previewSkillArchive = async (input: {
  socratesHome: string
  target: SkillImportTarget
  filename: string
  data: Buffer
}): Promise<SkillImportPreview> => {
  if (!input.filename.toLowerCase().endsWith(".zip")) {
    throw new SocratesError("skill_import_zip_required", "Import a .zip Agent Skill package.", { recoverable: true })
  }
  if (input.data.length === 0 || input.data.length > MAX_ARCHIVE_BYTES) {
    throw new SocratesError("skill_import_size_invalid", "Skill ZIP must be between 1 byte and 30 MB.", {
      recoverable: true,
      details: { maxBytes: MAX_ARCHIVE_BYTES, receivedBytes: input.data.length },
    })
  }

  cleanupExpiredPreviews(input.socratesHome)
  const previewId = createId("skillimp")
  const previewRoot = previewDirectory(input.socratesHome, previewId)
  fs.mkdirSync(previewRoot, { recursive: true, mode: 0o700 })
  try {
    const extracted = await extractSkillZip(input.data, previewRoot)
    const skillFile = path.join(extracted.sourceDirectory, "SKILL.md")
    const content = fs.readFileSync(skillFile, "utf8")
    const parsed = parseSkillMarkdown(content, skillFile)
    if (!parsed) {
      throw new SocratesError(
        "skill_import_invalid_skill_md",
        "SKILL.md must have valid YAML frontmatter with a matching lowercase name and a non-empty description.",
        { recoverable: true },
      )
    }
    const packageHash = crypto.createHash("sha256").update(input.data).digest("hex")
    const existingInfo = readSkillInfo(input.target.scope, input.target.root, path.join(input.target.root, parsed.name, "SKILL.md"))
    const existing = existingInfo ? skillSummary(existingInfo) : undefined
    const warnings = [...extracted.warnings, ...skillContentWarnings(extracted.textFiles)]
    if (parsed.allowedTools) {
      warnings.push({
        code: "allowed_tools_not_preapproved",
        severity: "warning",
        message: "This package declares allowed-tools. Socrates will not convert that declaration into automatic tool approval.",
        path: `${parsed.name}/SKILL.md`,
      })
    }
    const installedAt = nowIso()
    const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString()
    const preview: SkillImportPreview = {
      previewId,
      scope: input.target.scope,
      ...(input.target.projectId ? { projectId: input.target.projectId } : {}),
      skill: {
        id: `${input.target.scope}:${parsed.name}`,
        name: parsed.name,
        description: parsed.description,
        scope: input.target.scope,
        path: `${parsed.name}/SKILL.md`,
        enabled: true,
        source: "imported",
        contentHash: packageHash,
        installedAt,
        sourceLabel: boundedFilename(input.filename),
      },
      package: {
        filename: boundedFilename(input.filename),
        fileCount: extracted.files.length,
        totalBytes: extracted.totalBytes,
        sha256: packageHash,
        files: extracted.files,
      },
      metadata: {
        ...(parsed.license ? { license: parsed.license } : {}),
        ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
        ...(parsed.metadata?.author ? { author: parsed.metadata.author.slice(0, 200) } : {}),
        ...(parsed.metadata?.version ? { version: parsed.metadata.version.slice(0, 100) } : {}),
        ...(parsed.allowedTools ? { allowedTools: parsed.allowedTools } : {}),
      },
      conflict: { exists: Boolean(existing), ...(existing ? { existing } : {}) },
      warnings: warnings.slice(0, 50),
      expiresAt,
    }
    const staged: StagedSkillImport = {
      ...preview,
      targetRoot: path.resolve(input.target.root),
      sourceDirectory: path.resolve(extracted.sourceDirectory),
    }
    fs.writeFileSync(path.join(previewRoot, "preview.json"), `${JSON.stringify(staged, null, 2)}\n`, { mode: 0o600 })
    return skillImportPreviewSchema.parse(preview)
  } catch (error) {
    fs.rmSync(previewRoot, { recursive: true, force: true })
    throw error
  }
}

export const commitSkillImport = (input: {
  socratesHome: string
  target: SkillImportTarget
  previewId: string
  conflictStrategy: "reject" | "replace"
}): CommitSkillImportResponse => {
  const staged = readStagedPreview(input.socratesHome, input.previewId)
  if (staged.scope !== input.target.scope || staged.projectId !== input.target.projectId || staged.targetRoot !== path.resolve(input.target.root)) {
    throw new SocratesError("skill_import_scope_mismatch", "Skill import preview does not match the requested destination.", { recoverable: true })
  }
  if (Date.parse(staged.expiresAt) <= Date.now()) {
    fs.rmSync(previewDirectory(input.socratesHome, input.previewId), { recursive: true, force: true })
    throw new SocratesError("skill_import_preview_expired", "Skill import preview expired. Upload the package again.", { recoverable: true })
  }
  const sourceSkillFile = path.join(staged.sourceDirectory, "SKILL.md")
  const parsed = parseSkillMarkdown(fs.readFileSync(sourceSkillFile, "utf8"), sourceSkillFile)
  if (!parsed || parsed.name !== staged.skill.name) {
    throw new SocratesError("skill_import_stage_invalid", "Staged skill no longer matches its preview.", { recoverable: true })
  }

  fs.mkdirSync(input.target.root, { recursive: true })
  const destination = safeChild(input.target.root, parsed.name)
  const exists = fs.existsSync(destination)
  if (exists && input.conflictStrategy !== "replace") {
    throw new SocratesError("skill_already_exists", "A skill with this name already exists in the selected scope.", {
      recoverable: true,
      details: { name: parsed.name, scope: input.target.scope },
    })
  }

  const incoming = safeChild(input.target.root, `.incoming-${input.previewId}`)
  const backup = safeChild(input.target.root, `.backup-${input.previewId}`)
  fs.rmSync(incoming, { recursive: true, force: true })
  fs.rmSync(backup, { recursive: true, force: true })
  fs.cpSync(staged.sourceDirectory, incoming, { recursive: true, errorOnExist: true, force: false })
  writeSkillProvenance(incoming, {
    source: "imported",
    enabled: true,
    installedAt: staged.skill.installedAt ?? nowIso(),
    sourceLabel: staged.package.filename,
    contentHash: staged.package.sha256,
  })

  try {
    if (exists) fs.renameSync(destination, backup)
    fs.renameSync(incoming, destination)
    const installed = readSkillInfo(input.target.scope, input.target.root, path.join(destination, "SKILL.md"))
    if (!installed) throw new Error("Installed skill did not pass post-install validation.")
    fs.rmSync(backup, { recursive: true, force: true })
    fs.rmSync(previewDirectory(input.socratesHome, input.previewId), { recursive: true, force: true })
    return { skill: skillSummary(installed), replaced: exists, warnings: staged.warnings }
  } catch (error) {
    fs.rmSync(incoming, { recursive: true, force: true })
    if (fs.existsSync(backup)) {
      fs.rmSync(destination, { recursive: true, force: true })
      fs.renameSync(backup, destination)
    } else if (!exists) {
      fs.rmSync(destination, { recursive: true, force: true })
    }
    throw new SocratesError("skill_import_install_failed", "Skill could not be installed atomically.", {
      recoverable: true,
      details: { cause: error instanceof Error ? error.message : String(error) },
    })
  }

}

export const setSkillEnabled = (input: { target: SkillImportTarget; name: string; enabled: boolean }): SkillSummary => {
  const skillDir = safeChild(input.target.root, input.name)
  const info = readSkillInfo(input.target.scope, input.target.root, path.join(skillDir, "SKILL.md"))
  if (!info) throw new SocratesError("skill_not_found", "Skill was not found.", { recoverable: true })
  const current = readSkillProvenance(skillDir)
  writeSkillProvenance(skillDir, {
    source: current?.source ?? "generated",
    enabled: input.enabled,
    ...(current?.installedAt ? { installedAt: current.installedAt } : {}),
    ...(current?.sourceLabel ? { sourceLabel: current.sourceLabel } : {}),
    ...(current?.contentHash ? { contentHash: current.contentHash } : {}),
  })
  const updated = readSkillInfo(input.target.scope, input.target.root, path.join(skillDir, "SKILL.md"))
  if (!updated) throw new SocratesError("skill_state_update_failed", "Skill state could not be updated.", { recoverable: false })
  return skillSummary(updated)
}

const extractSkillZip = async (
  data: Buffer,
  previewRoot: string,
): Promise<{ sourceDirectory: string; files: string[]; totalBytes: number; warnings: SkillImportWarning[]; textFiles: Array<{ path: string; text: string }> }> => {
  const zip = await openZip(data)
  const files: string[] = []
  const textFiles: Array<{ path: string; text: string }> = []
  const warnings: SkillImportWarning[] = []
  let totalBytes = 0
  let rootName: string | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => reject(error)
      zip.once("error", fail)
      zip.once("end", resolve)
      zip.on("entry", (entry) => {
        void handleEntry(entry).catch(reject)
      })
      const handleEntry = async (entry: Entry): Promise<void> => {
        const fileName = entry.fileName
        if (isIgnoredArchivePath(fileName)) {
          zip.readEntry()
          return
        }
        validateArchivePath(fileName)
        const segments = fileName.split("/").filter(Boolean)
        rootName ??= segments[0]
        if (segments[0] !== rootName) throw new SocratesError("skill_import_multiple_roots", "Skill ZIP must contain exactly one top-level directory.", { recoverable: true })
        if (fileName.endsWith("/")) {
          zip.readEntry()
          return
        }
        if (segments.at(-1) === SKILL_PROVENANCE_FILE) {
          throw new SocratesError("skill_import_reserved_file", `Skill package cannot contain ${SKILL_PROVENANCE_FILE}.`, { recoverable: true })
        }
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new SocratesError("skill_import_encrypted", "Encrypted ZIP entries are not supported.", { recoverable: true })
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
        if ((unixMode & 0o170000) === 0o120000) throw new SocratesError("skill_import_symlink_rejected", "Skill ZIP cannot contain symbolic links.", { recoverable: true, details: { path: fileName } })
        if (files.length >= MAX_FILES) throw new SocratesError("skill_import_file_limit", `Skill ZIP may contain at most ${MAX_FILES} files.`, { recoverable: true })
        if (entry.uncompressedSize > MAX_FILE_BYTES || (fileName.endsWith("/SKILL.md") && entry.uncompressedSize > MAX_SKILL_MD_BYTES)) {
          throw new SocratesError("skill_import_file_too_large", "A skill file exceeds the allowed size.", { recoverable: true, details: { path: fileName, bytes: entry.uncompressedSize } })
        }
        totalBytes += entry.uncompressedSize
        if (totalBytes > MAX_EXTRACTED_BYTES) throw new SocratesError("skill_import_extracted_size_limit", "Extracted skill content may not exceed 30 MB.", { recoverable: true })
        const content = await readEntry(zip, entry)
        const destination = safeChild(previewRoot, fileName)
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })
        fs.writeFileSync(destination, content, { mode: 0o600 })
        files.push(fileName)
        if (isProbablyText(content)) textFiles.push({ path: fileName, text: content.toString("utf8").slice(0, 1_000_000) })
        zip.readEntry()
      }
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
  if (!rootName || files.length === 0) throw new SocratesError("skill_import_empty", "Skill ZIP contains no files.", { recoverable: true })
  const sourceDirectory = safeChild(previewRoot, rootName)
  if (!fs.existsSync(path.join(sourceDirectory, "SKILL.md"))) {
    throw new SocratesError("skill_import_skill_md_missing", "Skill ZIP must contain SKILL.md at the root of its single top-level directory.", { recoverable: true })
  }
  const parsed = parseSkillMarkdown(fs.readFileSync(path.join(sourceDirectory, "SKILL.md"), "utf8"), path.join(sourceDirectory, "SKILL.md"))
  if (!parsed || parsed.name !== rootName) {
    throw new SocratesError("skill_import_directory_mismatch", "The top-level directory must exactly match the SKILL.md name.", { recoverable: true, details: { directory: rootName } })
  }
  return { sourceDirectory, files: files.sort(), totalBytes, warnings, textFiles }
}

const openZip = (data: Buffer): Promise<ZipFile> =>
  new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(new SocratesError("skill_import_zip_invalid", "Skill ZIP could not be opened.", { recoverable: true, details: { cause: error?.message } }))
      else resolve(zip)
    })
  })

const readEntry = (zip: ZipFile, entry: Entry): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(new SocratesError("skill_import_entry_read_failed", "A skill ZIP entry could not be read.", { recoverable: true, details: { path: entry.fileName } }))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > MAX_FILE_BYTES || bytes > entry.uncompressedSize) stream.destroy(new Error("Skill entry exceeded its declared size."))
        else chunks.push(chunk)
      })
      stream.once("error", reject)
      stream.once("end", () => resolve(Buffer.concat(chunks)))
    })
  })

const validateArchivePath = (fileName: string): void => {
  if (!fileName || fileName.length > MAX_PATH_LENGTH || fileName.includes("\\") || fileName.includes("\0") || path.posix.isAbsolute(fileName)) {
    throw new SocratesError("skill_import_path_invalid", "Skill ZIP contains an invalid path.", { recoverable: true, details: { path: fileName.slice(0, MAX_PATH_LENGTH) } })
  }
  const segments = fileName.split("/").filter(Boolean)
  if (segments.length === 0 || segments.length > MAX_PATH_DEPTH || segments.some((segment) => segment === "." || segment === ".." || segment === ".git" || segment === "node_modules")) {
    throw new SocratesError("skill_import_path_invalid", "Skill ZIP paths must be shallow, relative, and exclude repository or dependency directories.", { recoverable: true, details: { path: fileName } })
  }
}

const skillContentWarnings = (files: Array<{ path: string; text: string }>): SkillImportWarning[] => {
  const rules: Array<{ code: string; pattern: RegExp; message: string }> = [
    { code: "network_access", pattern: /\b(curl|wget|Invoke-WebRequest|requests\.|fetch\(|https?:\/\/)/i, message: "Contains network access or external URL instructions. Review the referenced destination before use." },
    { code: "package_install", pattern: /\b(pip|pipx|uv|npm|pnpm|yarn|bun)\s+(?:install|add|run)|\bnpx\s+/i, message: "Contains package installation or on-demand package execution instructions." },
    { code: "destructive_command", pattern: /\b(?:sudo|rm\s+-rf|git\s+(?:push|reset|clean)|docker\s+system\s+prune)\b/i, message: "Contains potentially destructive or privileged command instructions." },
    { code: "secret_material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:api[_-]?key|secret|token)\s*[:=]\s*["'][^"']{12,}/i, message: "May contain embedded secret material. Review before installing." },
  ]
  const warnings: SkillImportWarning[] = []
  for (const file of files) {
    for (const rule of rules) {
      if (rule.pattern.test(file.text)) warnings.push({ code: rule.code, severity: "warning", message: rule.message, path: file.path })
    }
  }
  return warnings
}

const readStagedPreview = (socratesHome: string, previewId: string): StagedSkillImport => {
  if (!/^skillimp_[a-f0-9]{32}$/.test(previewId)) throw new SocratesError("skill_import_preview_invalid", "Skill import preview id is invalid.", { recoverable: true })
  const filePath = path.join(previewDirectory(socratesHome, previewId), "preview.json")
  if (!fs.existsSync(filePath)) throw new SocratesError("skill_import_preview_not_found", "Skill import preview was not found.", { recoverable: true })
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as StagedSkillImport
  const { targetRoot, sourceDirectory, ...publicPreview } = value
  skillImportPreviewSchema.parse(publicPreview)
  if (typeof value.targetRoot !== "string" || typeof value.sourceDirectory !== "string") throw new SocratesError("skill_import_preview_invalid", "Skill import preview metadata is invalid.", { recoverable: false })
  const expectedRoot = previewDirectory(socratesHome, previewId)
  if (!path.resolve(value.sourceDirectory).startsWith(`${path.resolve(expectedRoot)}${path.sep}`)) throw new SocratesError("skill_import_preview_invalid", "Skill import source escaped its staging directory.", { recoverable: false })
  return value
}

const cleanupExpiredPreviews = (socratesHome: string): void => {
  const root = path.join(socratesHome, ".skill-imports")
  if (!fs.existsSync(root)) return
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^skillimp_[a-f0-9]{32}$/.test(entry.name)) continue
    const full = path.join(root, entry.name)
    if (Date.now() - fs.statSync(full).mtimeMs > PREVIEW_TTL_MS) fs.rmSync(full, { recursive: true, force: true })
  }
}

const validatePublicSkillUrl = (value: string): URL => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new SocratesError("skill_import_url_invalid", "Skill import requires a valid public HTTPS URL.", { recoverable: true })
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new SocratesError("skill_import_url_invalid", "Skill import only supports public HTTPS URLs without embedded credentials.", { recoverable: true })
  }
  parsed.hash = ""
  return parsed
}

const resolvePublicAddresses = async (hostname: string): Promise<string[]> => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

const assertPublicHost = async (hostname: string, resolveHostname: (hostname: string) => Promise<string[]>): Promise<void> => {
  const normalized = hostname.toLowerCase().replace(/\.$/, "")
  if (!normalized || normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    throw new SocratesError("skill_import_private_url", "Skill import URLs cannot target localhost or private networks.", { recoverable: true })
  }
  const addresses = net.isIP(normalized) ? [normalized] : await resolveHostname(normalized)
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new SocratesError("skill_import_private_url", "Skill import URLs cannot resolve to localhost or private networks.", {
      recoverable: true,
      details: { hostname: normalized },
    })
  }
}

const isPrivateAddress = (address: string): boolean => {
  const normalized = address.toLowerCase().split("%")[0]!
  if (net.isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number)
    const a = parts[0]!
    const b = parts[1]!
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (net.isIP(normalized) === 6) {
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff")) return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1]
    return mapped ? isPrivateAddress(mapped) : false
  }
  return true
}

const parsePositiveContentLength = (value: string | null): number | undefined => {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

const readBoundedResponse = async (response: Response, maxBytes: number): Promise<Buffer> => {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done || !value) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new SocratesError("skill_import_size_invalid", "Skill ZIP may not exceed 30 MB.", {
          recoverable: true,
          details: { maxBytes },
        })
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

const skillArchiveFilename = (contentDisposition: string | null, finalUrl: URL): string => {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition ?? "")?.[1]
  const plain = /filename="?([^";]+)"?/i.exec(contentDisposition ?? "")?.[1]
  let candidate = plain
  if (encoded) {
    try {
      candidate = decodeURIComponent(encoded)
    } catch {
      candidate = encoded
    }
  }
  candidate = path.basename(candidate ?? path.posix.basename(finalUrl.pathname) ?? "skill.zip")
  if (!candidate.toLowerCase().endsWith(".zip")) candidate = `${candidate || "skill"}.zip`
  return boundedFilename(candidate)
}

const previewDirectory = (socratesHome: string, previewId: string): string => safeChild(path.join(socratesHome, ".skill-imports"), previewId)

const safeChild = (root: string, relativePath: string): string => {
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, relativePath)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new SocratesError("skill_import_path_escape", "Skill path escaped its allowed root.", { recoverable: false })
  return resolved
}

const isIgnoredArchivePath = (value: string): boolean => value === ".DS_Store" || value.startsWith("__MACOSX/") || value.endsWith("/.DS_Store")
const isProbablyText = (value: Buffer): boolean => !value.subarray(0, Math.min(value.length, 8_192)).includes(0)
const boundedFilename = (value: string): string => path.basename(value).slice(0, 240) || "skill.zip"
