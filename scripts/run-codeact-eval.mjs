#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

const defaultProjectId = "proj_638aa7f40bd644e3b7db957a2fb923db"
const defaultPromptFile = "evals/test-workspace-codeact-prompts.md"

const args = parseArgs(process.argv.slice(2))
const apiBase = args.apiBase ?? "http://127.0.0.1:4000"
const projectId = args.projectId ?? defaultProjectId
const promptFile = args.promptFile ?? defaultPromptFile
const modelId = args.modelId ?? "gpt-5.5"
const thinkingEffort = args.thinkingEffort ?? "medium"
const concurrency = Number.parseInt(args.concurrency ?? "1", 10)
const limit = args.limit ? Number.parseInt(args.limit, 10) : undefined
const timeoutMs = Number.parseInt(args.timeoutMs ?? "600000", 10)
const approval = args.approval ?? "reject"
const selectedIndexes = parseIndexes(args.indexes)
const outputPath = args.out

if (!Number.isFinite(concurrency) || concurrency < 1) {
  throw new Error("--concurrency must be a positive integer.")
}
if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
  throw new Error("--limit must be a positive integer.")
}
if (!["approve", "reject", "wait"].includes(approval)) {
  throw new Error('--approval must be "approve", "reject", or "wait".')
}

const prompts = await readPrompts(promptFile)
const selectedPrompts = prompts
  .filter((item) => selectedIndexes.size === 0 || selectedIndexes.has(item.index))
  .slice(0, limit ?? prompts.length)

if (selectedPrompts.length === 0) {
  throw new Error("No prompts selected.")
}

console.log(`Running ${selectedPrompts.length} CodeAct eval prompt(s) against ${apiBase}`)
console.log(`Project: ${projectId}`)
console.log(`Model: openai/chatgpt_subscription/${modelId}, thinking=${thinkingEffort}`)
console.log(`Concurrency: ${concurrency}; approval=${approval}`)

const results = await runPool(selectedPrompts, concurrency, (prompt) => runPrompt(prompt))
const passed = results.filter((result) => result.status === "completed").length
const failed = results.length - passed

console.log(`\nCompleted ${passed}/${results.length}; failed or timed out ${failed}.`)
for (const result of results) {
  const toolList = result.toolCalls.length > 0 ? result.toolCalls.join(", ") : "none"
  console.log(`\n#${result.index} ${result.status} (${Math.round(result.durationMs / 1000)}s)`)
  console.log(`conversation: ${result.conversationId ?? "none"}`)
  console.log(`tools: ${toolList}`)
  if (result.approvals.length > 0) {
    console.log(`approvals: ${result.approvals.map((item) => `${item.title}:${item.decision}`).join(", ")}`)
  }
  if (result.error) {
    console.log(`error: ${result.error}`)
  }
  if (result.answerPreview) {
    console.log(`answer: ${result.answerPreview}`)
  }
}

if (outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, `${JSON.stringify({ apiBase, projectId, modelId, thinkingEffort, approval, results }, null, 2)}\n`)
  console.log(`\nWrote ${outputPath}`)
}

async function runPrompt(prompt) {
  const startedAt = Date.now()
  const result = {
    index: prompt.index,
    prompt: prompt.text,
    status: "failed",
    durationMs: 0,
    conversationId: undefined,
    turnId: undefined,
    toolCalls: [],
    approvals: [],
    answerPreview: "",
    error: undefined,
  }

  try {
    const conversation = await createConversation(projectId, `CodeAct Eval ${prompt.index}`)
    result.conversationId = conversation.id
    const events = await sendPrompt(projectId, conversation.id, prompt.text)
    const completed = events.find((event) => event.type === "turn.completed")
    const failed = events.find((event) => event.type === "turn.failed")
    const message = [...events].reverse().find((event) => event.type === "message.completed")
    result.turnId = completed?.payload?.turnId ?? failed?.payload?.turnId
    result.toolCalls = [
      ...new Set(
        events
          .filter((event) => event.type === "tool.call.started")
          .map((event) => event.payload?.toolName)
          .filter(Boolean),
      ),
    ]
    result.approvals = events
      .filter((event) => event.type === "approval.requested")
      .map((event) => ({
        title: event.payload?.title ?? "approval",
        actionKind: event.payload?.actionKind,
        decision: approval === "approve" ? "approved" : approval === "reject" ? "rejected" : "pending",
      }))
    result.answerPreview = truncate(message?.payload?.message?.content ?? "", 600)
    result.status = failed ? "failed" : completed ? "completed" : "unknown"
    result.error = failed?.payload?.error?.message
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    return result
  } finally {
    result.durationMs = Date.now() - startedAt
  }
}

async function createConversation(projectId, title) {
  const data = await api(`/api/projects/${encodeURIComponent(projectId)}/conversations`, {
    method: "POST",
    body: JSON.stringify({ title }),
  })
  return data.conversation
}

async function api(route, init = {}) {
  const response = await fetch(`${apiBase}${route}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  })
  const json = await response.json()
  if (!json.ok) {
    throw new Error(json.error?.message ?? `Request failed: ${response.status}`)
  }
  return json.data
}

async function sendPrompt(projectId, conversationId, content) {
  const wsUrl = new URL(apiBase)
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:"
  wsUrl.pathname = "/ws"
  const socket = new WebSocket(wsUrl.toString())
  const events = []

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error(`Timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    socket.addEventListener("error", (error) => {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error("WebSocket connection failed."))
    })

    socket.addEventListener("message", (raw) => {
      const event = JSON.parse(String(raw.data))
      events.push(event)
      if (event.type === "connection.ready") {
        socket.send(
          JSON.stringify({
            id: id("cmd"),
            type: "chat.message.send",
            schemaVersion: 1,
            timestamp: new Date().toISOString(),
            projectId,
            conversationId,
            actor: { type: "user" },
            payload: {
              clientMessageId: id("msg"),
              content,
              runtimeConfig: {
                providerId: "openai",
                authMode: "chatgpt_subscription",
                modelId,
                thinkingEnabled: true,
                thinkingEffort,
                approvalMode: approval === "approve" ? "approve_all" : "manual",
                sandboxMode: "workspace_write",
              },
            },
          }),
        )
        return
      }

      if (event.type === "approval.requested" && approval !== "wait") {
        socket.send(
          JSON.stringify({
            id: id("cmd"),
            type: "approval.decide",
            schemaVersion: 1,
            timestamp: new Date().toISOString(),
            projectId,
            conversationId,
            actor: { type: "user" },
            payload: {
              approvalId: event.payload.approvalId,
              decision: approval === "approve" ? "approved" : "rejected",
              reason: approval === "approve" ? "CodeAct eval auto-approval." : "CodeAct eval conservative rejection.",
            },
          }),
        )
        return
      }

      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled") {
        clearTimeout(timer)
        socket.close()
        resolve(events)
      }
    })
  })
}

async function readPrompts(file) {
  const text = await fs.readFile(file, "utf8")
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/^(\d+)\.\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({ index: Number.parseInt(match[1], 10), text: match[2].trim() }))
}

async function runPool(items, size, worker) {
  const results = []
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      results.push(await worker(item))
    }
  })
  await Promise.all(workers)
  return results.sort((a, b) => a.index - b.index)
}

function parseArgs(raw) {
  const parsed = {}
  for (let index = 0; index < raw.length; index += 1) {
    const arg = raw[index]
    if (!arg.startsWith("--")) continue
    const key = arg.slice(2)
    const next = raw[index + 1]
    if (!next || next.startsWith("--")) {
      parsed[key] = "true"
    } else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

function parseIndexes(value) {
  if (!value) return new Set()
  return new Set(
    value
      .split(",")
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((item) => Number.isFinite(item)),
  )
}

function id(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`
}

function truncate(value, limit) {
  return value.length > limit ? `${value.slice(0, limit)}...` : value
}
