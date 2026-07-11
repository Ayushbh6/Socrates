import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import YAML from "yaml"
import type { SkillScope, SkillSummary } from "@socrates/contracts"

export const SKILL_PROVENANCE_FILE = ".socrates-skill.json"

export type SkillProvenance = {
  source: "generated" | "imported"
  enabled: boolean
  installedAt?: string
  sourceLabel?: string
  contentHash?: string
}

export type SkillInfo = SkillSummary & {
  root: string
  skillDir: string
  skillFile: string
  content: string
}

export const discoverSkills = (scope: SkillScope, root: string): SkillInfo[] => {
  if (!fs.existsSync(root)) {
    return []
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const skillFile = path.join(root, entry.name, "SKILL.md")
      const info = readSkillInfo(scope, root, skillFile)
      return info ? [info] : []
    })
}

export const readSkillInfo = (scope: SkillScope, root: string, skillFile: string): SkillInfo | undefined => {
  if (!fs.existsSync(skillFile) || !fs.statSync(skillFile).isFile()) {
    return undefined
  }
  const content = fs.readFileSync(skillFile, "utf8")
  const parsed = parseSkillMarkdown(content, skillFile)
  if (!parsed) {
    return undefined
  }
  const skillDir = path.dirname(skillFile)
  const stats = fs.statSync(skillFile)
  const provenance = readSkillProvenance(skillDir)
  const contentHash = provenance?.contentHash ?? crypto.createHash("sha256").update(content).digest("hex")
  return {
    name: parsed.name,
    description: parsed.description,
    scope,
    path: path.relative(root, skillFile).replaceAll(path.sep, "/"),
    updatedAt: stats.mtime.toISOString(),
    root,
    skillDir,
    skillFile,
    content,
    enabled: provenance?.enabled ?? true,
    source: scope === "builtin" ? "builtin" : provenance?.source ?? "generated",
    contentHash,
    ...(provenance?.installedAt ? { installedAt: provenance.installedAt } : {}),
    ...(provenance?.sourceLabel ? { sourceLabel: provenance.sourceLabel } : {}),
  }
}

export type ParsedSkillMarkdown = {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string
}

export const parseSkillMarkdown = (content: string, skillFile: string): ParsedSkillMarkdown | undefined => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match?.[1]) {
    return undefined
  }
  let frontmatter: unknown
  try {
    frontmatter = YAML.parse(match[1])
  } catch {
    return undefined
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return undefined
  const fields = frontmatter as Record<string, unknown>
  const name = typeof fields.name === "string" ? fields.name.trim() : ""
  const description = typeof fields.description === "string" ? fields.description.trim() : ""
  if (!name || !description || description.length > 1_024 || !isValidSkillName(name)) {
    return undefined
  }
  const directoryName = path.basename(path.dirname(skillFile))
  if (directoryName !== name) {
    return undefined
  }
  const license = optionalBoundedString(fields.license, 500)
  const compatibility = optionalBoundedString(fields.compatibility, 500)
  const allowedTools = optionalBoundedString(fields["allowed-tools"], 1_000)
  const metadata =
    fields.metadata && typeof fields.metadata === "object" && !Array.isArray(fields.metadata)
      ? Object.fromEntries(
          Object.entries(fields.metadata as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .slice(0, 40),
        )
      : undefined
  return {
    name,
    description,
    ...(license ? { license } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}

export const validateSkillWriteMarkdown = (content: string, skillFile: string): { name: string; description: string } | undefined => {
  const parsed = parseSkillMarkdown(content, skillFile)
  if (!parsed) return undefined
  const body = stripFrontmatter(content).trim()
  if (body.length < 120 || !/^#{1,3}\s+\S+/m.test(body) || !/^(?:\s*[-*]\s+|\s*\d+[.)]\s+)\S+/m.test(body)) {
    return undefined
  }
  return parsed
}

export const stripFrontmatter = (content: string): string => content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")

export const slugSkillName = (input: string): string => {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48)
    .replace(/-+$/g, "")
  return isValidSkillName(slug) ? slug : "general"
}

export const uniqueSkillName = (root: string, desiredName: string): string => {
  const base = slugSkillName(desiredName)
  let candidate = base
  let index = 2
  while (fs.existsSync(path.join(root, candidate))) {
    candidate = `${base}-${index}`
    index += 1
  }
  return candidate
}

export const skillSummary = (skill: SkillInfo): SkillSummary => ({
  id: `${skill.scope}:${skill.name}`,
  name: skill.name,
  description: skill.description,
  scope: skill.scope,
  path: skill.path,
  ...(skill.updatedAt ? { updatedAt: skill.updatedAt } : {}),
  ...(skill.enabled === undefined ? {} : { enabled: skill.enabled }),
  ...(skill.source ? { source: skill.source } : {}),
  ...(skill.contentHash ? { contentHash: skill.contentHash } : {}),
  ...(skill.installedAt ? { installedAt: skill.installedAt } : {}),
  ...(skill.sourceLabel ? { sourceLabel: skill.sourceLabel } : {}),
})

export const fallbackSkillDescription = (request: string): string => {
  const triggerPhrase = /trigger phrase:\s*([^\n.]+)/i.exec(request)?.[1]?.trim()
  if (triggerPhrase) {
    return `Use when the user mentions ${triggerPhrase}.`
  }
  const compact = request.replace(/\s+/g, " ").trim()
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact || "Reusable Socrates skill."
}

export const fallbackSkillBody = (request: string): string =>
  [
    "# When to Use",
    "",
    "- Use this skill when the user's request is substantively about the original request below.",
    "- Use it for recurring project work, document review, tool workflows, or specialized procedures that benefit from a saved checklist.",
    "- If the match is uncertain, search or list nearby skills first and prefer the user's current instructions.",
    "",
    "# Workflow",
    "",
    "- Restate the user's concrete goal in one sentence before acting.",
    "- Gather the smallest useful context from project files, uploaded resources, project docs, repo docs, or relevant tools.",
    "- Follow the procedure implied by the original request, adapting details to the current workspace.",
    "- Produce a concrete result, cite the files or evidence used when applicable, and run a focused verification when the workflow changes files or data.",
    "",
    "# Output Style",
    "",
    "- Be concise and direct.",
    "- Separate confirmed evidence from assumptions.",
    "- Mention follow-up risks only when they affect the user's next action.",
    "",
    "## Original Request",
    "",
    request.trim() || "No request was provided.",
  ].join("\n")

export const fallbackSkillMarkdown = (name: string, descriptionOrBody: string): string => {
  const skillName = slugSkillName(name)
  const description = fallbackSkillDescription(descriptionOrBody)
  return `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${fallbackSkillBody(descriptionOrBody)}\n`
}

export const isValidSkillName = (name: string): boolean => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) && !name.includes("--")

export const readSkillProvenance = (skillDir: string): SkillProvenance | undefined => {
  const filePath = path.join(skillDir, SKILL_PROVENANCE_FILE)
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return undefined
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<SkillProvenance>
    if ((value.source !== "generated" && value.source !== "imported") || typeof value.enabled !== "boolean") return undefined
    return {
      source: value.source,
      enabled: value.enabled,
      ...(typeof value.installedAt === "string" ? { installedAt: value.installedAt } : {}),
      ...(typeof value.sourceLabel === "string" ? { sourceLabel: value.sourceLabel } : {}),
      ...(typeof value.contentHash === "string" && /^[a-f0-9]{64}$/.test(value.contentHash) ? { contentHash: value.contentHash } : {}),
    }
  } catch {
    return undefined
  }
}

export const writeSkillProvenance = (skillDir: string, provenance: SkillProvenance): void => {
  fs.writeFileSync(path.join(skillDir, SKILL_PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 })
}

const optionalBoundedString = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}
