import path from "node:path"

export type ServerConfig = {
  dbPath: string
  port: number
  host: string
}

export const getServerConfig = (): ServerConfig => ({
  dbPath: process.env.SOCRATES_DB_PATH ?? path.join("app-data", "socrates.sqlite"),
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? "127.0.0.1",
})
