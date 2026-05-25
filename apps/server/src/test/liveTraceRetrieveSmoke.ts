import WebSocket from "ws"
import { createId, nowIso } from "@socrates/shared"
import { buildServer } from "../app"
import { getServerConfig } from "../config"
import { openDatabase, runMigrations } from "../db/client"
import { SocratesStore } from "../services/store"

const SOURCE_TITLE = `Trace retrieval source ${new Date().toISOString()}`
const LIVE_TITLE = `Trace retrieval live ${new Date().toISOString()}`
const EXPECTED_KEY = "BLUE-LANTERN-42"
const EXPECTED_MEANING = "ship the retrieval layer before compaction"
const MODEL = {
  providerId: "openrouter" as const,
  modelId: "deepseek/deepseek-v4-pro",
  thinkingEnabled: false,
  approvalMode: "read_only_auto" as const,
  sandboxMode: "read_only" as const,
}

type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: unknown } }
type EventEnvelope = {
  type: string
  payload: Record<string, unknown>
}

const main = async () => {
  const config = getServerConfig()
  const seeded = seedTraceConversation(config.dbPath)
  console.log(`project: ${seeded.projectId} (${seeded.projectName})`)
  console.log(`source conversation: ${seeded.sourceConversationId} (${SOURCE_TITLE})`)
  console.log(`live conversation: ${seeded.liveConversationId} (${LIVE_TITLE})`)

  console.log("\nDirect backend retrieval check:")
  console.log(`search results: ${seeded.directSearch.totalMatches}`)
  console.log(`first handle: ${seeded.firstHandle ?? "none"}`)
  console.log(`inspect contains expected key: ${seeded.directInspectText.includes(EXPECTED_KEY)}`)

  const app = await buildServer({ dbPath: config.dbPath, logger: false })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  const wsUrl = address.replace(/^http/, "ws") + "/ws"

  try {
    const live = await runLiveTurn(wsUrl, seeded.projectId, seeded.liveConversationId)
    console.log("\nLive backend WebSocket run:")
    console.log(`model: ${MODEL.providerId}/${MODEL.modelId}, thinking off`)
    console.log(`turn: ${live.turnId}`)
    console.log(`tool calls: ${live.toolCalls.length}`)
    for (const call of live.toolCalls) {
      console.log(`- ${call.toolName}: ${call.summary}`)
      if (call.argsPreview) {
        console.log(`  args: ${call.argsPreview}`)
      }
      if (call.resultPreview) {
        console.log(`  result: ${call.resultPreview.slice(0, 500).replace(/\s+/g, " ")}`)
      }
    }
    console.log(`answer: ${live.answer}`)
    console.log(`answer contains expected key: ${live.answer.includes(EXPECTED_KEY)}`)
    console.log(`answer contains expected meaning: ${live.answer.toLowerCase().includes(EXPECTED_MEANING)}`)

    const persisted = readPersistedLiveToolCalls(config.dbPath, live.turnId)
    console.log("\nPersisted live tool calls:")
    for (const row of persisted) {
      console.log(`- ${row.toolName} ${row.status}`)
      console.log(`  arguments: ${row.argumentsJson}`)
      console.log(`  result preview: ${row.resultJson.slice(0, 600).replace(/\s+/g, " ")}`)
    }

    if (!live.answer.includes(EXPECTED_KEY)) {
      throw new Error(`Live answer did not include ${EXPECTED_KEY}`)
    }
  } finally {
    await app.close()
  }
}

const seedTraceConversation = (dbPath: string) => {
  const handle = openDatabase(dbPath)
  runMigrations(handle)
  const store = new SocratesStore(handle)
  try {
    const project = handle.sqlite
      .prepare("SELECT id, name, user_id AS userId FROM projects WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1")
      .get() as { id: string; name: string; userId: string } | undefined
    if (!project) {
      throw new Error("No active project found in the local Socrates DB.")
    }

    const source = store.createConversation(project.id, { title: SOURCE_TITLE })
    const live = store.createConversation(project.id, { title: LIVE_TITLE })
    const sourceSessionId = createSession(handle.sqlite, project.id, source.id)
    const liveSessionId = createSession(handle.sqlite, project.id, live.id)

    const pairs = makePairs()
    for (const [index, pair] of pairs.entries()) {
      const turnId = createId("turn")
      const userMessageId = createId("msg")
      const assistantMessageId = createId("msg")
      const timestamp = new Date(Date.now() - (pairs.length - index) * 60_000).toISOString()
      insertCompletedTurn(handle.sqlite, {
        conversationId: source.id,
        sessionId: sourceSessionId,
        turnId,
        userMessageId,
        assistantMessageId,
        userContent: pair.user,
        assistantContent: pair.assistant,
        timestamp,
      })
      store.indexTurnTraceDocuments(project.id, source.id, turnId)
    }

    for (const pair of pairs.slice(-3)) {
      const turnId = createId("turn")
      const userMessageId = createId("msg")
      const assistantMessageId = createId("msg")
      const timestamp = nowIso()
      insertCompletedTurn(handle.sqlite, {
        conversationId: live.id,
        sessionId: liveSessionId,
        turnId,
        userMessageId,
        assistantMessageId,
        userContent: pair.user,
        assistantContent: pair.assistant,
        timestamp,
      })
      store.indexTurnTraceDocuments(project.id, live.id, turnId)
    }

    const directSearch = store.retrieveToolTraces(project.id, live.id, {
      query: `${EXPECTED_KEY} second user message exact memory line`,
      scope: "project",
      conversationHint: SOURCE_TITLE,
      mode: "exact",
      include: ["messages"],
      limit: 5,
    })
    const firstHandle = directSearch.results[0]?.handle
    const directInspect = firstHandle
      ? store.retrieveToolTraces(project.id, live.id, { operation: "inspect", handle: firstHandle, charLimit: 20_000 })
      : undefined
    const directInspectText = JSON.stringify(directInspect?.results ?? [])

    return {
      projectId: project.id,
      projectName: project.name,
      sourceConversationId: source.id,
      liveConversationId: live.id,
      directSearch,
      firstHandle,
      directInspectText,
    }
  } finally {
    store.close()
  }
}

const createSession = (sqlite: import("better-sqlite3").Database, projectId: string, conversationId: string): string => {
  const workspace = sqlite
    .prepare("SELECT id, path FROM project_workspaces WHERE project_id = ? AND is_primary = 1 LIMIT 1")
    .get(projectId) as { id: string; path: string | null } | undefined
  const id = createId("sess")
  const now = nowIso()
  sqlite
    .prepare(
      `INSERT INTO sessions (
        id, conversation_id, project_id, project_workspace_id, workspace_path, workspace_name, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
    )
    .run(id, conversationId, projectId, workspace?.id ?? null, workspace?.path ?? null, workspace?.path?.split("/").filter(Boolean).at(-1) ?? null, now, now)
  return id
}

const insertCompletedTurn = (
  sqlite: import("better-sqlite3").Database,
  input: {
    conversationId: string
    sessionId: string
    turnId: string
    userMessageId: string
    assistantMessageId: string
    userContent: string
    assistantContent: string
    timestamp: string
  },
) => {
  sqlite
    .prepare(
      `INSERT INTO turns (
        id, session_id, conversation_id, user_message_id, assistant_message_id, status, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`,
    )
    .run(input.turnId, input.sessionId, input.conversationId, input.userMessageId, input.assistantMessageId, input.timestamp, input.timestamp)
  sqlite
    .prepare(
      `INSERT INTO messages (
        id, conversation_id, session_id, turn_id, role, content, content_format, status, created_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'markdown', 'completed', ?, ?)`,
    )
    .run(input.userMessageId, input.conversationId, input.sessionId, input.turnId, "user", input.userContent, input.timestamp, input.timestamp)
  sqlite
    .prepare(
      `INSERT INTO messages (
        id, conversation_id, session_id, turn_id, role, content, content_format, status, created_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'markdown', 'completed', ?, ?)`,
    )
    .run(
      input.assistantMessageId,
      input.conversationId,
      input.sessionId,
      input.turnId,
      "assistant",
      input.assistantContent,
      input.timestamp,
      input.timestamp,
    )
  sqlite.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(input.timestamp, input.conversationId)
}

const makePairs = () =>
  Array.from({ length: 20 }, (_, index) => {
    const number = index + 1
    if (number === 2) {
      return {
        user: `Second user message: remember ${EXPECTED_KEY}; it means "${EXPECTED_MEANING}".\nLater in the same message I repeat it: ${EXPECTED_KEY} is the recall key for this smoke test.`,
        assistant: `I will remember that ${EXPECTED_KEY} means ${EXPECTED_MEANING}.`,
      }
    }
    const topic = [
      "project naming",
      "resource uploads",
      "sidebar behavior",
      "provider settings",
      "token accounting",
      "approval flow",
      "workspace files",
      "chat rendering",
      "cancel behavior",
      "tests",
      "model catalog",
      "tool summaries",
      "shell output",
      "conversation titles",
      "resource deletion",
      "prompt context",
      "trace indexing",
      "final polish",
      "release notes",
    ][index % 19]
    return {
      user: `Routine source conversation user turn ${number}: discuss ${topic}. This message has no special recall key.`,
      assistant: `Routine Socrates answer ${number}: acknowledged the ${topic} discussion and moved on.`,
    }
  })

const runLiveTurn = async (wsUrl: string, projectId: string, conversationId: string) => {
  const ws = new WebSocket(wsUrl)
  const events: EventEnvelope[] = []
  const waiters: Array<(event: EventEnvelope) => void> = []
  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString()) as EventEnvelope
    events.push(event)
    logLiveEvent(event)
    for (const waiter of waiters.splice(0)) {
      waiter(event)
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve())
    ws.once("error", reject)
  })
  await waitForEvent(events, waiters, "connection.ready", 30_000)

  ws.send(
    JSON.stringify({
      id: createId("evt"),
      type: "chat.message.send",
      schemaVersion: 1,
      timestamp: nowIso(),
      projectId,
      conversationId,
      actor: { type: "user" },
      payload: {
        clientMessageId: createId("msg"),
        content:
          `Use trace_retrieve before answering. In the earlier generated conversation named "${SOURCE_TITLE}", what exact key and meaning did I put in the second user message? Inspect exact source before final answer.`,
        runtimeConfig: MODEL,
      },
    }),
  )
  console.log("\nLive event stream:")
  console.log(`-> chat.message.send using ${MODEL.providerId}/${MODEL.modelId}, thinking off`)

  const started = await waitForEvent(events, waiters, "turn.started", 30_000)
  const toolNames = new Map<string, { toolName: string; argsPreview?: string }>()
  const toolCalls: Array<{ toolName: string; argsPreview?: string; summary: string; resultPreview?: string }> = []
  let answer = ""
  let done = false
  let processedIndex = events.length
  const deadline = Date.now() + 240_000
  while (!done && Date.now() < deadline) {
    let event: EventEnvelope | undefined =
      processedIndex < events.length ? (events[processedIndex++] as EventEnvelope) : undefined
    if (!event) {
      try {
        event = await waitForAnyEvent(events, waiters, Math.min(30_000, deadline - Date.now()))
      } catch (error) {
        console.log(`... waiting for live model/tool event (${Math.ceil((deadline - Date.now()) / 1000)}s left)`)
        continue
      }
    }
    const eventIndex = events.indexOf(event)
    if (eventIndex >= processedIndex) {
      processedIndex = eventIndex + 1
    }
    if (event.type === "agent.answer.delta" && typeof event.payload.text === "string") {
      answer += event.payload.text
    }
    if (event.type === "tool.call.started") {
      const tool = {
        toolName: String(event.payload.toolName),
        ...(typeof event.payload.argsPreview === "string" ? { argsPreview: event.payload.argsPreview } : {}),
      }
      toolNames.set(String(event.payload.toolCallId), tool)
    }
    if (event.type === "tool.call.completed") {
      const tool = toolNames.get(String(event.payload.toolCallId))
      toolCalls.push({
        toolName: tool?.toolName ?? "unknown",
        summary: String(event.payload.summary),
        ...(tool?.argsPreview ? { argsPreview: tool.argsPreview } : {}),
        ...(typeof event.payload.resultPreview === "string" ? { resultPreview: event.payload.resultPreview } : {}),
      })
    }
    if (event.type === "message.completed") {
      const message = event.payload.message as { content?: string } | undefined
      answer = message?.content ?? answer
    }
    if (event.type === "turn.completed") {
      done = true
    }
    if (event.type === "turn.failed" || event.type === "error.created") {
      throw new Error(`Live turn failed: ${JSON.stringify(event)}`)
    }
  }
  ws.close()
  if (!done) {
    throw new Error("Timed out waiting for live turn completion.")
  }
  return {
    turnId: String(started.payload.turnId),
    toolCalls,
    answer,
  }
}

const waitForEvent = async (
  events: EventEnvelope[],
  waiters: Array<(event: EventEnvelope) => void>,
  type: string,
  timeoutMs: number,
): Promise<EventEnvelope> => {
  const existing = events.find((event) => event.type === type)
  if (existing) {
    return existing
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const event = await waitForAnyEvent(events, waiters, deadline - Date.now())
    if (event.type === type) {
      return event
    }
  }
  throw new Error(`Timed out waiting for ${type}.`)
}

const waitForAnyEvent = (
  events: EventEnvelope[],
  waiters: Array<(event: EventEnvelope) => void>,
  timeoutMs: number,
): Promise<EventEnvelope> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket event.")), timeoutMs)
    waiters.push((event) => {
      clearTimeout(timeout)
      resolve(event)
    })
  })

const readPersistedLiveToolCalls = (dbPath: string, turnId: string) => {
  const handle = openDatabase(dbPath)
  try {
    return handle.sqlite
      .prepare(
        `SELECT tool_name AS toolName, status, arguments_json AS argumentsJson, COALESCE(result_json, '') AS resultJson
         FROM tool_calls
         WHERE turn_id = ?
         ORDER BY started_at`,
      )
      .all(turnId) as Array<{ toolName: string; status: string; argumentsJson: string; resultJson: string }>
  } finally {
    handle.close()
  }
}

const logLiveEvent = (event: EventEnvelope): void => {
  if (event.type === "connection.ready") {
    console.log("<- connection.ready")
  }
  if (event.type === "turn.started") {
    console.log(`<- turn.started ${String(event.payload.turnId)}`)
  }
  if (event.type === "agent.thinking.delta") {
    const text = typeof event.payload.text === "string" ? event.payload.text : ""
    if (text.trim()) {
      process.stdout.write(`[thinking] ${text}`)
    }
  }
  if (event.type === "agent.answer.delta") {
    const text = typeof event.payload.text === "string" ? event.payload.text : ""
    if (text) {
      process.stdout.write(`[answer] ${text}`)
    }
  }
  if (event.type === "tool.call.started") {
    console.log(`\n<- tool.call.started ${String(event.payload.toolName)} ${String(event.payload.toolCallId)}`)
    if (typeof event.payload.argsPreview === "string") {
      console.log(`   args ${event.payload.argsPreview}`)
    }
  }
  if (event.type === "tool.call.output") {
    const text = typeof event.payload.text === "string" ? event.payload.text : ""
    const data = event.payload.data === undefined ? "" : JSON.stringify(event.payload.data)
    console.log(`\n<- tool.call.output ${String(event.payload.stream)} ${(text || data).slice(0, 800).replace(/\s+/g, " ")}`)
  }
  if (event.type === "tool.call.completed") {
    console.log(`\n<- tool.call.completed ${String(event.payload.toolCallId)} ${String(event.payload.summary)}`)
    if (typeof event.payload.resultPreview === "string") {
      console.log(`   result ${event.payload.resultPreview.slice(0, 1_200).replace(/\s+/g, " ")}`)
    }
  }
  if (event.type === "tool.call.failed") {
    console.log(`\n<- tool.call.failed ${String(event.payload.toolCallId)} ${JSON.stringify(event.payload.error)}`)
  }
  if (event.type === "message.completed") {
    const message = event.payload.message as { content?: string } | undefined
    console.log(`\n<- message.completed ${message?.content?.slice(0, 1_200).replace(/\s+/g, " ") ?? ""}`)
  }
  if (event.type === "turn.completed") {
    console.log(`<- turn.completed ${String(event.payload.turnId)}`)
  }
  if (event.type === "turn.failed" || event.type === "error.created") {
    console.log(`\n<- ${event.type} ${JSON.stringify(event.payload)}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
