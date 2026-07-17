import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { config as loadEnvFile } from "dotenv"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const legacyDevDbPath = path.join(repoRoot, "app-data", "socrates.sqlite")
const envFiles = [path.join(repoRoot, ".env"), path.join(repoRoot, "apps/server/.env")]

for (const envFile of envFiles) {
  if (fs.existsSync(envFile)) {
    loadEnvFile({ path: envFile, quiet: true })
  }
}

export type ServerConfig = {
  socratesHome: string
  dbPath: string
  port: number
  host: string
  v2FlowEnabled: boolean
  legacyDevDbPath: string
}

export type LegacyDatabaseImportResult = {
  imported: boolean
  sourcePath?: string
  targetPath?: string
}

const expandHome = (value: string): string => {
  if (value === "~") {
    return os.homedir()
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

export const resolveSocratesHome = (env: NodeJS.ProcessEnv = process.env): string =>
  path.resolve(expandHome(env.SOCRATES_HOME ?? path.join(os.homedir(), ".Socrates")))

export const resolveSocratesDbPath = (env: NodeJS.ProcessEnv = process.env): string => {
  if (env.SOCRATES_DB_PATH) {
    return path.resolve(expandHome(env.SOCRATES_DB_PATH))
  }
  return path.join(resolveSocratesHome(env), "socrates.sqlite")
}

export const resolveV2FlowEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.SOCRATES_V2_FLOW_ENABLED?.trim().toLowerCase() === "true"

export const getServerConfig = (): ServerConfig => ({
  socratesHome: resolveSocratesHome(),
  dbPath: resolveSocratesDbPath(),
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "127.0.0.1",
  v2FlowEnabled: resolveV2FlowEnabled(),
  legacyDevDbPath,
})

export const prepareServerDataDirectory = (
  config: Pick<ServerConfig, "dbPath" | "legacyDevDbPath">,
  env: NodeJS.ProcessEnv = process.env,
): LegacyDatabaseImportResult => {
  if (config.dbPath === ":memory:" || env.SOCRATES_DB_PATH || env.SOCRATES_SKIP_LEGACY_DB_IMPORT === "true") {
    return { imported: false }
  }

  const sourcePath = path.resolve(config.legacyDevDbPath)
  const targetPath = path.resolve(config.dbPath)
  if (sourcePath === targetPath || !fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
    return { imported: false }
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${sourcePath}${suffix}`
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, `${targetPath}${suffix}`)
    }
  }

  return { imported: true, sourcePath, targetPath }
}
