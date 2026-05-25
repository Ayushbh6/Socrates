import fs from "node:fs"
import path from "node:path"
import { SocratesError } from "@socrates/shared"

const ENV_FILE_NAMES = [".env.local", ".env", ".env.development.local", ".env.development"]

export type WorkspaceEnvKeyCandidate = {
  fileName: string
  hasKey: boolean
}

export const listWorkspaceEnvKeyCandidates = (workspacePath: string, keyName: string): WorkspaceEnvKeyCandidate[] =>
  ENV_FILE_NAMES.flatMap((fileName) => {
    const filePath = path.join(workspacePath, fileName)
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return []
    }
    const values = parseEnv(fs.readFileSync(filePath, "utf8"))
    return [{ fileName, hasKey: typeof values[keyName] === "string" && values[keyName].trim().length > 0 }]
  })

export const readWorkspaceEnvValue = (workspacePath: string, fileName: string, keyName: string): string | undefined => {
  if (!ENV_FILE_NAMES.includes(fileName)) {
    throw new SocratesError("workspace_env_file_not_allowed", "Only project root .env files can be used for embedding credentials", {
      details: { fileName },
      recoverable: true,
    })
  }
  const filePath = path.join(workspacePath, fileName)
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return undefined
  }
  const values = parseEnv(fs.readFileSync(filePath, "utf8"))
  const value = values[keyName]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

const parseEnv = (text: string): Record<string, string> => {
  const values: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) {
      continue
    }
    const key = match[1]
    const rawValue = match[2] ?? ""
    if (!key) {
      continue
    }
    values[key] = stripEnvQuotes(rawValue)
  }
  return values
}

const stripEnvQuotes = (value: string): string => {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  const commentStart = trimmed.indexOf(" #")
  return commentStart >= 0 ? trimmed.slice(0, commentStart).trim() : trimmed
}
