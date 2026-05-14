import { buildServer } from "./app"
import { getServerConfig } from "./config"

const config = getServerConfig()
const app = await buildServer({ dbPath: config.dbPath, logger: true })

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
