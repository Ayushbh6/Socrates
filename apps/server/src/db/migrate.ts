import { getServerConfig, prepareServerDataDirectory } from "../config"
import { openDatabase, runMigrations } from "./client"

const config = getServerConfig()
const dataDirectoryResult = prepareServerDataDirectory(config)
const handle = openDatabase(config.dbPath)

try {
  runMigrations(handle)
  if (dataDirectoryResult.imported) {
    console.log(
      `Imported legacy development database from ${dataDirectoryResult.sourcePath} to ${dataDirectoryResult.targetPath}`,
    )
  }
  console.log(`Migrations applied to ${config.dbPath}`)
} finally {
  handle.close()
}
