import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const defaultDbPath = path.join(repoRoot, "app-data", "socrates.sqlite")

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
