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
import { createDefaultSocratesAgent, createV2SocratesAgent, type SocratesAgent } from "@socrates/core"
import { McpRuntime } from "@socrates/mcp"
import { createDefaultModelProvider, type EmbeddingProvider, type ModelProvider } from "@socrates/providers"
import { ProviderCredentialStore } from "./services/providerCredentials"
import { registerV2FlowRoutes } from "./routes/v2FlowRoutes"
import { registerV2SpeechRoutes } from "./routes/v2SpeechRoutes"
import { V2FlowStore } from "./services/v2/flowStore"
import {
  LocalKokoroSynthesizer,
  LocalWhisperTranscriber,
  OpenRouterTranscriber,
  SpeechPackManager,
} from "./services/v2/speech"
import { registerV2WebSocketRoutes } from "./v2/websocket"

export type BuildServerOptions = {
  dbPath: string
  logger?: boolean
  databaseHandle?: DatabaseHandle
  agent?: SocratesAgent
  v2Agent?: SocratesAgent
  embeddingProvider?: EmbeddingProvider
  titleProvider?: ModelProvider | false
  memoryProvider?: ModelProvider
  socratesHome?: string
  preserveTerminalsOnClose?: boolean
  v2FlowEnabled?: boolean
}

export const buildServer = async (options: BuildServerOptions) => {
  const handle = options.databaseHandle ?? openDatabase(options.dbPath)
  runMigrations(handle)

  const socratesHome = options.socratesHome ?? (options.dbPath === ":memory:" ? undefined : path.dirname(options.dbPath))
  const credentials = new ProviderCredentialStore(socratesHome ? { socratesHome } : {})
  const store = new SocratesStore(handle, options.embeddingProvider, credentials, {
    ...(socratesHome ? { socratesHome } : {}),
    ...(options.memoryProvider ? { memoryProvider: options.memoryProvider } : {}),
  })
  store.cancelStaleActiveTurns()
  store.requeueInterruptedTerminalTasks()
  await store.initializeRetrieval()
  store.startGlobalMemoryScheduler()
  const agent = options.agent ?? createDefaultSocratesAgent(credentials)
  const v2Agent = options.v2Agent ?? (options.agent ? options.agent : createV2SocratesAgent(credentials))
  const titleProvider =
    options.titleProvider === false ? undefined : options.titleProvider ?? (options.agent ? undefined : createDefaultModelProvider(credentials))
  const mcpRuntime = new McpRuntime(socratesHome ? { socratesHome } : {})
  const subscriptions = new ConversationSubscriptions()
  const terminals = new ConversationTerminalManager(store, subscriptions, { supervisorScope: socratesHome ?? path.dirname(options.dbPath) })
  await terminals.reconcilePersistedTerminals()
  const app = Fastify({ logger: options.logger ?? false })
  const v2FlowEnabled = options.v2FlowEnabled ?? false
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

  app.get("/api/v2/capabilities", async () => ({
    ok: true,
    data: {
      enabled: v2FlowEnabled,
      product: "socrates_flow",
      contractVersion: 2,
      speech: {
        localStt: ["whisper.cpp/base.en", "whisper.cpp/small.en"],
        hostedStt: [
          "nvidia/parakeet-tdt-0.6b-v3",
          "microsoft/mai-transcribe-1.5",
          "mistralai/voxtral-mini-transcribe",
        ],
        localTts: ["kokoro-82m"],
      },
    },
  }))

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

  let shutdownV2 = async (): Promise<void> => undefined
  if (v2FlowEnabled) {
    const flowStore = new V2FlowStore(handle)
    flowStore.recoverInterruptedTurns()
    await registerV2FlowRoutes(app, flowStore)
    const v2WebSocketRuntime = await registerV2WebSocketRoutes(app, {
      store: flowStore,
      sharedStore: store,
      agent: v2Agent,
      mcpRuntime,
      supervisorScope: socratesHome ?? path.dirname(options.dbPath),
      ...(titleProvider ? { routerProvider: titleProvider } : {}),
    })

    await registerV2SpeechRoutes(app, {
      persistence: flowStore,
      packs: speechPacks,
      openRouter: openRouterTranscriber,
      localWhisper: localWhisperTranscriber,
      kokoro: new LocalKokoroSynthesizer({
        binaryPath: speechBinary("SOCRATES_SHERPA_ONNX_TTS_BINARY", "sherpa-onnx-offline-tts"),
        modelDirectory: path.dirname(speechPacks.status("kokoro-en-v0_19").path),
      }),
    })
    shutdownV2 = async () => {
      await v2WebSocketRuntime.shutdown()
      flowStore.recoverInterruptedTurns("Socrates shut down before this Flow response completed.")
    }
  }

  app.addHook("onClose", async () => {
    terminals.beginShutdown()
    await websocketRuntime.shutdown()
    await shutdownV2()
    store.cancelStaleActiveTurns("Socrates shut down before this response completed.")
    store.requeueInterruptedTerminalTasks()
    await terminals.dispose({ preserveRunning: options.preserveTerminalsOnClose ?? true })
    await store.close()
  })

  return app
}
