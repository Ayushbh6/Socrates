import { defineConfig } from "drizzle-kit"
import path from "node:path"

const defaultDbPath = path.resolve("../..", "app-data", "socrates.sqlite")

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.SOCRATES_DB_PATH ?? defaultDbPath,
  },
})
