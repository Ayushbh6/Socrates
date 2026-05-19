import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { config as loadEnvFile } from "dotenv"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const defaultDbPath = path.join(repoRoot, "app-data", "socrates.sqlite")
const envFiles = [path.join(repoRoot, ".env"), path.join(repoRoot, "apps/server/.env")]

for (const envFile of envFiles) {
  if (fs.existsSync(envFile)) {
    loadEnvFile({ path: envFile, quiet: true })
  }
}

export type ServerConfig = {
  dbPath: string
  port: number
  host: string
}

export const getServerConfig = (): ServerConfig => ({
  dbPath: process.env.SOCRATES_DB_PATH ?? defaultDbPath,
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "127.0.0.1",
})
