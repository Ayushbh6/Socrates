import Fastify from "fastify"
import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import path from "node:path"
import { openDatabase, runMigrations, type DatabaseHandle } from "./db/client"
import { registerHttpRoutes } from "./routes/httpRoutes"
import { SocratesStore } from "./services/store"
import { registerWebSocketRoutes } from "./ws/websocket"
import { createDefaultSocratesAgent, type SocratesAgent } from "@socrates/core"
import { ProviderCredentialStore } from "./services/providerCredentials"

export type BuildServerOptions = {
  dbPath: string
  logger?: boolean
  databaseHandle?: DatabaseHandle
  agent?: SocratesAgent
  socratesHome?: string
}

export const buildServer = async (options: BuildServerOptions) => {
  const handle = options.databaseHandle ?? openDatabase(options.dbPath)
  runMigrations(handle)

  const socratesHome = options.socratesHome ?? (options.dbPath === ":memory:" ? undefined : path.dirname(options.dbPath))
  const credentials = new ProviderCredentialStore(socratesHome ? { socratesHome } : {})
  const store = new SocratesStore(handle, undefined, credentials)
  const agent = options.agent ?? createDefaultSocratesAgent(credentials)
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

  await registerWebSocketRoutes(app, store, agent)
  await registerHttpRoutes(app, store, credentials)

  return app
}
