import { getServerConfig } from "../config"
import { openDatabase, runMigrations } from "./client"

const config = getServerConfig()
const handle = openDatabase(config.dbPath)

try {
  runMigrations(handle)
  console.log(`Migrations applied to ${config.dbPath}`)
} finally {
  handle.close()
}
