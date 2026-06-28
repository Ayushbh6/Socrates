import Fastify from "fastify"
import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import path from "node:path"
import { openDatabase, runMigrations, type DatabaseHandle } from "./db/client"
import { registerHttpRoutes } from "./routes/httpRoutes"
import { SocratesStore } from "./services/store"
import { registerWebSocketRoutes } from "./ws/websocket"
import { ConversationTerminalManager } from "./ws/conversationTerminals"
import { createDefaultSocratesAgent, type SocratesAgent } from "@socrates/core"
import { McpRuntime } from "@socrates/mcp"
import { AiSdkProvider, type ModelProvider } from "@socrates/providers"
import { ProviderCredentialStore } from "./services/providerCredentials"

export type BuildServerOptions = {
  dbPath: string
  logger?: boolean
  databaseHandle?: DatabaseHandle
  agent?: SocratesAgent
  titleProvider?: ModelProvider | false
  memoryProvider?: ModelProvider
  socratesHome?: string
}

export const buildServer = async (options: BuildServerOptions) => {
  const handle = options.databaseHandle ?? openDatabase(options.dbPath)
  runMigrations(handle)

  const socratesHome = options.socratesHome ?? (options.dbPath === ":memory:" ? undefined : path.dirname(options.dbPath))
  const credentials = new ProviderCredentialStore(socratesHome ? { socratesHome } : {})
  const store = new SocratesStore(handle, undefined, credentials, {
    ...(socratesHome ? { socratesHome } : {}),
    ...(options.memoryProvider ? { memoryProvider: options.memoryProvider } : {}),
  })
  store.cancelStaleActiveTurns()
  store.startGlobalMemoryScheduler()
  const agent = options.agent ?? createDefaultSocratesAgent(credentials)
  const titleProvider =
    options.titleProvider === false ? undefined : options.titleProvider ?? (options.agent ? undefined : new AiSdkProvider(credentials))
  const mcpRuntime = new McpRuntime(socratesHome ? { socratesHome } : {})
  const terminals = new ConversationTerminalManager(store)
  await terminals.reconcilePersistedTerminals()
  const app = Fastify({ logger: options.logger ?? false })

  app.addHook("onClose", async () => {
    await terminals.dispose()
    await store.close()
  })

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 25,
    },
  })
  await app.register(cors, {
    origin: [/^http:\/\/127\.0\.0\.1:\d+$/, /^http:\/\/localhost:\d+$/],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  })

  await registerWebSocketRoutes(app, store, terminals, agent, mcpRuntime, titleProvider)
  await registerHttpRoutes(app, store, credentials, mcpRuntime, {
    onConversationDelete: (conversationId) => terminals.stopConversation(conversationId, "Conversation deleted."),
    onProjectWorkspaceSwitch: (projectId) => terminals.stopProject(projectId, "Project workspace switched."),
  })

  return app
}
