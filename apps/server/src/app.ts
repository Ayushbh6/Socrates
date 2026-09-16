import Fastify from "fastify"
import cors from "@fastify/cors"
import multipart from "@fastify/multipart"
import path from "node:path"
import { openDatabase, runMigrations, type DatabaseHandle } from "./db/client"
import { registerHttpRoutes } from "./routes/httpRoutes"
import { registerClassicSpeechRoutes } from "./routes/classicSpeechRoutes"
import { SocratesStore } from "./services/store"
import { registerWebSocketRoutes } from "./ws/websocket"
import { ConversationTerminalManager } from "./ws/conversationTerminals"
import { ConversationSubscriptions } from "./ws/conversationSubscriptions"
import { createDefaultSocratesAgent, type SocratesAgent } from "@socrates/core"
import { McpRuntime } from "@socrates/mcp"
import { createDefaultModelProvider, type EmbeddingProvider, type ModelProvider } from "@socrates/providers"
import { ProviderCredentialStore } from "./services/providerCredentials"
import {
  LocalWhisperTranscriber,
  OpenRouterTranscriber,
  SpeechPackManager,
} from "./services/v2/speech"
import { reconcileClassicStableRelease } from "./services/classicStableReconciliation"

export type BuildServerOptions = {
  dbPath: string
  logger?: boolean
  databaseHandle?: DatabaseHandle
  agent?: SocratesAgent
  embeddingProvider?: EmbeddingProvider
  titleProvider?: ModelProvider | false
  memoryProvider?: ModelProvider
  socratesHome?: string
  preserveTerminalsOnClose?: boolean
}

export const buildServer = async (options: BuildServerOptions) => {
  const handle = options.databaseHandle ?? openDatabase(options.dbPath)
  runMigrations(handle)
  reconcileClassicStableRelease(handle)

  const socratesHome = options.socratesHome ?? (options.dbPath === ":memory:" ? undefined : path.dirname(options.dbPath))
  const credentials = new ProviderCredentialStore(socratesHome ? { socratesHome } : {})
  const store = new SocratesStore(handle, options.embeddingProvider, credentials, {
    ...(socratesHome ? { socratesHome } : {}),
    ...(options.memoryProvider ? { memoryProvider: options.memoryProvider } : {}),
    includeV2Flow: false,
  })
  store.cancelStaleActiveTurns()
  store.requeueInterruptedTerminalTasks()
  await store.initializeRetrieval()
  store.startGlobalMemoryScheduler()
  const agent = options.agent ?? createDefaultSocratesAgent(credentials)
  const titleProvider =
    options.titleProvider === false ? undefined : options.titleProvider ?? (options.agent ? undefined : createDefaultModelProvider(credentials))
  const mcpRuntime = new McpRuntime(socratesHome ? { socratesHome } : {})
  const subscriptions = new ConversationSubscriptions()
  const terminals = new ConversationTerminalManager(store, subscriptions, { supervisorScope: socratesHome ?? path.dirname(options.dbPath) })
  await terminals.reconcilePersistedTerminals()
  const app = Fastify({ logger: options.logger ?? false })
  const speechHome = socratesHome ?? path.dirname(options.dbPath)
  const speechPacks = new SpeechPackManager(speechHome)
  const runtimeRoot = process.env.SOCRATES_RUNTIME_DIR ?? path.join(speechHome, "runtime")
  const executableName = (name: string): string => process.platform === "win32" ? `${name}.exe` : name
  const speechBinary = (environmentName: string, defaultName: string): string =>
    process.env[environmentName] ?? path.join(runtimeRoot, "speech", "bin", executableName(defaultName))
  const whisperCliOverride = process.env.SOCRATES_WHISPER_CPP_BINARY
  const openRouterTranscriber = new OpenRouterTranscriber(credentials)
  const localWhisperTranscriber = new LocalWhisperTranscriber({
    binaryPath: speechBinary("SOCRATES_WHISPER_CPP_BINARY", "whisper-cli"),
    modelPath: (model) => speechPacks.status(model === "base.en" ? "whisper-base.en" : "whisper-small.en").path,
    preferCli: Boolean(whisperCliOverride),
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

  const websocketRuntime = await registerWebSocketRoutes(app, store, terminals, subscriptions, agent, mcpRuntime, titleProvider)
  await registerHttpRoutes(app, store, credentials, mcpRuntime, {
    onConversationDelete: (conversationId) => terminals.stopConversation(conversationId, "Conversation deleted."),
    onProjectWorkspaceSwitch: (projectId) => terminals.stopProject(projectId, "Project workspace switched."),
  })
  await registerClassicSpeechRoutes(app, {
    requireConversationScope: ({ projectId, conversationId }) => {
      store.getConversation(projectId, conversationId)
    },
    localWhisper: localWhisperTranscriber,
    openRouter: openRouterTranscriber,
  })

  app.addHook("onClose", async () => {
    terminals.beginShutdown()
    await websocketRuntime.shutdown()
    store.cancelStaleActiveTurns("Socrates shut down before this response completed.")
    store.requeueInterruptedTerminalTasks()
    await terminals.dispose({ preserveRunning: options.preserveTerminalsOnClose ?? true })
    await store.close()
  })

  return app
}
