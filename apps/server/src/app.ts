import Fastify from "fastify"
import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import { openDatabase, runMigrations, type DatabaseHandle } from "./db/client"
import { registerHttpRoutes } from "./routes/httpRoutes"
import { SocratesStore } from "./services/store"
import { registerWebSocketRoutes } from "./ws/websocket"

export type BuildServerOptions = {
  dbPath: string
  logger?: boolean
  databaseHandle?: DatabaseHandle
}

export const buildServer = async (options: BuildServerOptions) => {
  const handle = options.databaseHandle ?? openDatabase(options.dbPath)
  runMigrations(handle)

  const store = new SocratesStore(handle)
  const app = Fastify({ logger: options.logger ?? false })

  app.addHook("onClose", async () => {
    store.close()
  })

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 25,
    },
  })
  await app.register(cors, {
    origin: [/^http:\/\/127\.0\.0\.1:\d+$/, /^http:\/\/localhost:\d+$/],
  })

  await registerWebSocketRoutes(app, store)
  await registerHttpRoutes(app, store)

  return app
}
