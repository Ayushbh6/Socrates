import { buildServer } from "./app"
import { getServerConfig, prepareServerDataDirectory } from "./config"

const config = getServerConfig()
const dataDirectoryResult = prepareServerDataDirectory(config)

if (dataDirectoryResult.imported) {
  console.info(
    `Imported legacy development database from ${dataDirectoryResult.sourcePath} to ${dataDirectoryResult.targetPath}`,
  )
}

const app = await buildServer({
  dbPath: config.dbPath,
  logger: true,
  socratesHome: config.socratesHome,
  v2FlowEnabled: config.v2FlowEnabled,
})

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
