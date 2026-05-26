import { defineConfig } from "drizzle-kit"
import { resolveSocratesDbPath } from "./src/config"

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: resolveSocratesDbPath(),
  },
})
