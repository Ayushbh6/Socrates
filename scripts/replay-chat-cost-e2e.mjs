import os from "node:os"
import path from "node:path"
import process from "node:process"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const Database = require(path.resolve("apps/server/node_modules/better-sqlite3"))
const WebSocket = require(path.resolve("apps/server/node_modules/ws"))

const args = parseArgs(process.argv.slice(2))
const backendUrl = args["backend-url"] ?? "http://127.0.0.1:4000"
const wsUrl = backendUrl.replace(/^http/, "ws") + "/ws"
const dbPath = args["db-path"] ?? process.env.SOCRATES_DB_PATH ?? path.join(process.env.SOCRATES_HOME ?? path.join(os.homedir(), ".Socrates"), "socrates.sqlite")
const timeoutMs = Number(args["timeout-ms"] ?? 240_000)

const db = new Database(dbPath, { readonly: true })

try {
  const source = loadSourceTurn(db, args["source-conversation-id"])
  console.log(`Source conversation: ${source.conversationId} (${source.title ?? "untitled"})`)
  console.log(`Source project: ${source.projectId}`)
  console.log(`Source query chars: ${source.query.length}`)
  console.log(`Runtime: ${source.runtime.providerId} ${source.runtime.modelId} thinking=${source.runtime.thinkingEnabled ? "on" : "off"} approval=${source.runtime.approvalMode} sandbox=${source.runtime.sandboxMode}`)

  const createdConversation = await createConversation(backendUrl, source.projectId, {
    title: `[diag] ${source.title ?? "Replay"} ${new Date().toISOString().slice(11, 19)}`,
  })
  console.log(`Replay conversation: ${createdConversation.id}`)

  const events = []
  const socket = new WebSocket(wsUrl)
  socket.on("message", (raw) => {
    try {
      events.push(JSON.parse(String(raw)))
    } catch {
      // ignore malformed payloads in diagnostics
    }
  })

  await onceOpen(socket)
  await waitForEvent(events, "connection.ready", timeoutMs)

  send(socket, envelope("chat.conversation.subscribe", source.projectId, createdConversation.id, { replayActiveTurn: true }))
  send(
    socket,
    envelope("chat.message.send", source.projectId, createdConversation.id, {
      clientMessageId: createId("msg"),
      content: source.query,
      runtimeConfig: source.runtime,
    }),
  )

  let outcome = "completed"
  try {
    const event = await waitForAnyEvent(events, ["turn.completed", "turn.failed", "error.created"], timeoutMs)
    if (event.type === "turn.failed") {
      outcome = "failed"
    } else if (event.type === "error.created") {
      outcome = `error:${event.payload?.error?.code ?? "unknown"}`
    }
  } catch (error) {
    outcome = `timeout:${error instanceof Error ? error.message : String(error)}`
  } finally {
    socket.close()
  }

  const replay = loadLatestTurnSummary(db, createdConversation.id)
  const sourceSummary = loadLatestTurnSummary(db, source.conversationId)
  const assistant = loadLatestAssistantMessage(db, createdConversation.id)

  console.log("")
  console.log(`Replay outcome: ${outcome}`)
  console.log(`Replay turn status: ${replay.turnStatus}`)
  console.log(`Replay cost: $${formatNumber(replay.totalCostUsd)}`)
  console.log(`Replay tokens: total=${replay.totalTokens} input=${replay.inputTokens} cached=${replay.cachedInputTokens} uncached=${replay.uncachedInputTokens} output=${replay.outputTokens} reasoning=${replay.reasoningTokens}`)
  console.log(`Replay providers: ${replay.providers.join(", ") || "?"}`)
  console.log(`Replay model calls: ${replay.modelCallCount}`)
  console.log(`Replay tools: ${replay.toolSummary}`)
  console.log(`Replay assistant chars: ${assistant?.content.length ?? 0}`)
  console.log(`Replay assistant preview: ${JSON.stringify((assistant?.content ?? "").slice(0, 240))}`)
  console.log("")
  console.log(`Source cost: $${formatNumber(sourceSummary.totalCostUsd)}`)
  console.log(`Source tokens: total=${sourceSummary.totalTokens} input=${sourceSummary.inputTokens} cached=${sourceSummary.cachedInputTokens} uncached=${sourceSummary.uncachedInputTokens} output=${sourceSummary.outputTokens} reasoning=${sourceSummary.reasoningTokens}`)
  console.log(`Source providers: ${sourceSummary.providers.join(", ") || "?"}`)
  console.log(`Source model calls: ${sourceSummary.modelCallCount}`)
  console.log(`Source tools: ${sourceSummary.toolSummary}`)
  console.log("")
  if (replay.totalCostUsd !== undefined && sourceSummary.totalCostUsd !== undefined && sourceSummary.totalCostUsd > 0) {
    const ratio = replay.totalCostUsd / sourceSummary.totalCostUsd
    console.log(`Replay/source cost ratio: ${ratio.toFixed(3)}x`)
  }
} finally {
  db.close()
}

function parseArgs(argv) {
  const result = {}
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith("--")) {
      continue
    }
    const key = item.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith("--")) {
      result[key] = "true"
      continue
    }
    result[key] = next
    i += 1
  }
  return result
}

function createId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`
}

function envelope(type, projectId, conversationId, payload) {
  return {
    id: createId("evt"),
    type,
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    projectId,
    conversationId,
    actor: { type: "user" },
    payload,
  }
}

function send(socket, payload) {
  socket.send(JSON.stringify(payload))
}

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
}

function waitForEvent(events, type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const index = events.findIndex((event) => event?.type === type)
      if (index >= 0) {
        const [event] = events.splice(index, 1)
        clearInterval(timer)
        resolve(event)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${type}`))
      }
    }, 25)
  })
}

function waitForAnyEvent(events, types, timeoutMs) {
  return new Promise((resolve, reject) => {
    const wanted = new Set(types)
    const started = Date.now()
    const timer = setInterval(() => {
      const index = events.findIndex((event) => wanted.has(event?.type))
      if (index >= 0) {
        const [event] = events.splice(index, 1)
        clearInterval(timer)
        resolve(event)
        return
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${types.join(" | ")}`))
      }
    }, 25)
  })
}

async function createConversation(backendUrl, projectId, body) {
  const response = await fetch(`${backendUrl}/api/projects/${projectId}/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = await response.json()
  if (!response.ok || !json?.ok) {
    throw new Error(`Failed to create conversation: ${JSON.stringify(json)}`)
  }
  return json.data.conversation
}

function loadSourceTurn(db, sourceConversationId) {
  const conversationId =
    sourceConversationId ??
    db
      .prepare(`SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 1`)
      .get()?.id
  if (!conversationId) {
    throw new Error("Could not find a source conversation.")
  }

  const row = db
    .prepare(
      `SELECT
         c.id AS conversation_id,
         c.title AS title,
         c.project_id AS project_id,
         m.content AS query,
         trc.provider_id AS provider_id,
         trc.model_id AS model_id,
         trc.thinking_enabled AS thinking_enabled,
         trc.thinking_effort AS thinking_effort,
         trc.approval_mode AS approval_mode,
         trc.sandbox_mode AS sandbox_mode
       FROM conversations c
       JOIN messages m ON m.conversation_id = c.id
       JOIN turns t ON t.conversation_id = c.id
       JOIN turn_runtime_configs trc ON trc.turn_id = t.id
       WHERE c.id = ?
         AND m.role = 'user'
       ORDER BY m.created_at ASC, t.started_at DESC
       LIMIT 1`,
    )
    .get(conversationId)

  if (!row) {
    throw new Error(`Could not load source query/runtime for conversation ${conversationId}.`)
  }

  return {
    conversationId: row.conversation_id,
    title: row.title,
    projectId: row.project_id,
    query: row.query,
    runtime: {
      providerId: row.provider_id,
      modelId: row.model_id,
      thinkingEnabled: Boolean(row.thinking_enabled),
      ...(row.thinking_effort ? { thinkingEffort: row.thinking_effort } : {}),
      approvalMode: row.approval_mode,
      sandboxMode: row.sandbox_mode,
    },
  }
}

function loadLatestTurnSummary(db, conversationId) {
  const turn = db
    .prepare(
      `SELECT id, status
       FROM turns
       WHERE conversation_id = ?
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(conversationId)

  if (!turn) {
    throw new Error(`No turns found for conversation ${conversationId}.`)
  }

  const usage = db
    .prepare(
      `SELECT
         total_cost_usd,
         total_tokens,
         input_tokens,
         cached_input_tokens,
         uncached_input_tokens,
         output_tokens,
         reasoning_tokens
       FROM turn_usage_reports
       WHERE turn_id = ?`,
    )
    .get(turn.id)

  const events = db
    .prepare(
      `SELECT routed_provider, COUNT(*) AS calls
       FROM ai_usage_events
       WHERE turn_id = ?
         AND source_kind = 'main_model_call'
       GROUP BY routed_provider
       ORDER BY calls DESC`,
    )
    .all(turn.id)

  const toolRows = db
    .prepare(
      `SELECT tool_name, COUNT(*) AS count
       FROM tool_calls
       WHERE turn_id = ?
       GROUP BY tool_name
       ORDER BY count DESC, tool_name ASC`,
    )
    .all(turn.id)

  return {
    turnId: turn.id,
    turnStatus: turn.status,
    totalCostUsd: usage?.total_cost_usd,
    totalTokens: usage?.total_tokens ?? 0,
    inputTokens: usage?.input_tokens ?? 0,
    cachedInputTokens: usage?.cached_input_tokens ?? 0,
    uncachedInputTokens: usage?.uncached_input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    reasoningTokens: usage?.reasoning_tokens ?? 0,
    providers: events.map((row) => row.routed_provider ?? "?"),
    modelCallCount: events.reduce((sum, row) => sum + Number(row.calls), 0),
    toolSummary: toolRows.map((row) => `${row.tool_name}:${row.count}`).join(", "),
  }
}

function loadLatestAssistantMessage(db, conversationId) {
  return (
    db
      .prepare(
        `SELECT content
         FROM messages
         WHERE conversation_id = ?
           AND role = 'assistant'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(conversationId) ?? null
  )
}

function formatNumber(value) {
  return value === undefined || value === null ? "n/a" : Number(value).toFixed(6)
}
