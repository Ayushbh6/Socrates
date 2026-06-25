import fs from "node:fs"
import path from "node:path"
import type { SkillScope, SkillSummary } from "@socrates/contracts"

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
  }
}

export const parseSkillMarkdown = (content: string, skillFile: string): { name: string; description: string } | undefined => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (!match?.[1]) {
    return undefined
  }
  const frontmatter = match[1]
  const name = frontmatter.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim()
  const description = frontmatter.match(/^description:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim()
  if (!name || !description || !isValidSkillName(name)) {
    return undefined
  }
  const directoryName = path.basename(path.dirname(skillFile))
  if (directoryName !== name) {
    return undefined
  }
  return { name, description }
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
  id: skill.name,
  name: skill.name,
  description: skill.description,
  scope: skill.scope,
  path: skill.path,
  ...(skill.updatedAt ? { updatedAt: skill.updatedAt } : {}),
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
