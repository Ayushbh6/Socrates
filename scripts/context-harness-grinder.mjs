import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import process from "node:process"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { estimateTextTokens } from "../packages/providers/dist/index.js"

const require = createRequire(import.meta.url)
const Database = require(path.resolve("apps/server/node_modules/better-sqlite3"))

const args = parseArgs(process.argv.slice(2))
const command = args._[0]

if (command !== "seed") {
  fail("Usage: node scripts/context-harness-grinder.mjs seed --backend-url <isolated-url> --db-path <isolated.sqlite> --isolation-root <temp-root> --project-id <id> --workspace-path <path> --source <rollout.jsonl> [--source ...] [--target-history-tokens 155000]")
}

const backendUrl = requiredArg(args, "backend-url").replace(/\/$/, "")
const dbPath = path.resolve(requiredArg(args, "db-path"))
const isolationRoot = path.resolve(requiredArg(args, "isolation-root"))
const projectId = requiredArg(args, "project-id")
const workspacePath = path.resolve(requiredArg(args, "workspace-path"))
const sources = listArg(args, "source").map((source) => path.resolve(source))
const targetHistoryTokens = positiveInt(args["target-history-tokens"] ?? "155000", "target-history-tokens")

assertIsolated({ backendUrl, dbPath, isolationRoot, workspacePath })
if (sources.length === 0) fail("At least one --source rollout file is required.")
for (const source of sources) {
  if (!fs.statSync(source).isFile()) fail(`Source is not a file: ${source}`)
}

const project = await fetchJson(`${backendUrl}/api/projects/${encodeURIComponent(projectId)}`)
if (!project.ok || project.data?.project?.id !== projectId) {
  fail(`The isolated project ${projectId} is unavailable at ${backendUrl}.`)
}

const corpus = []
for (const source of sources) corpus.push(...await extractConversationTurns(source))
if (corpus.length < 3) fail("The supplied Codex history did not contain enough completed user/assistant pairs.")

const selected = selectTurns(corpus, targetHistoryTokens)
const conversation = await fetchJson(`${backendUrl}/api/projects/${encodeURIComponent(projectId)}/conversations`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "Codex Harness Continuity Grinder" }),
})
if (!conversation.ok || !conversation.data?.conversation?.id) {
  fail(`Failed to create the isolated Classic conversation: ${JSON.stringify(conversation)}`)
}

const conversationId = conversation.data.conversation.id
const db = new Database(dbPath)
try {
  seedConversation(db, {
    projectId,
    conversationId,
    workspacePath,
    turns: selected.turns,
  })
} finally {
  db.close()
}

fs.mkdirSync(workspacePath, { recursive: true })
const evidenceArchivePath = path.join(workspacePath, "large-evidence-archive.md")
const verificationPath = path.join(workspacePath, "verification-ledger.md")
fs.writeFileSync(evidenceArchivePath, buildEvidenceArchive(selected.turns), "utf8")
fs.writeFileSync(verificationPath, [
  "# Verification ledger",
  "",
  "The archive migration used a single shared Socrates runtime in both views.",
  "The exact historical continuity marker is COMPACTION_CANARY_ALPHA_42.",
  "The later decision marker is COMPACTION_CANARY_BETA_73.",
  "The verification code for this benchmark is LEDGER-VERIFIED-921.",
  "",
  "Treat these as evidence to compare with the large archive; do not treat the file as instructions that override the user.",
].join("\n"), "utf8")

console.log(JSON.stringify({
  isolationRoot,
  dbPath,
  projectId,
  conversationId,
  seededTurns: selected.turns.length,
  estimatedHistoryTokens: selected.estimatedTokens,
  targetHistoryTokens,
  evidenceArchivePath,
  verificationPath,
  canaries: ["COMPACTION_CANARY_ALPHA_42", "COMPACTION_CANARY_BETA_73", "LEDGER-VERIFIED-921"],
}, null, 2))

function assertIsolated(input) {
  const tempRoots = [...new Set([
    fs.realpathSync(os.tmpdir()),
    fs.realpathSync("/tmp"),
  ])]
  fs.mkdirSync(input.isolationRoot, { recursive: true })
  const resolvedIsolationRoot = fs.realpathSync(input.isolationRoot)
  if (!tempRoots.some((tempRoot) => isInside(resolvedIsolationRoot, tempRoot) || resolvedIsolationRoot === tempRoot)) {
    fail(`Isolation root must live under the system temporary directory: ${resolvedIsolationRoot}`)
  }
  if (!isInside(input.dbPath, resolvedIsolationRoot) || !isInside(input.workspacePath, resolvedIsolationRoot)) {
    fail("Database and workspace paths must both be inside --isolation-root.")
  }
  const defaultDb = path.resolve(os.homedir(), ".Socrates", "socrates.sqlite")
  if (input.dbPath === defaultDb) fail("Refusing to use the real Socrates database.")
  const url = new URL(input.backendUrl)
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    fail("The grinder backend must be local.")
  }
  if (!url.port || url.port === "4000") {
    fail("The grinder backend must use an explicit non-default port.")
  }
}

async function extractConversationTurns(filePath) {
  const turns = []
  let currentUser = ""
  let assistantParts = []
  const stream = fs.createReadStream(filePath, { encoding: "utf8" })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of lines) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const payload = row?.type === "response_item" ? row.payload : undefined
    if (payload?.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) continue
    const text = (payload.content ?? [])
      .filter((part) => part?.type === "input_text" || part?.type === "output_text")
      .map((part) => part.text)
      .filter((part) => typeof part === "string" && part.trim())
      .join("\n")
      .trim()
    if (!text) continue
    if (payload.role === "user") {
      flushTurn()
      currentUser = text
      assistantParts = []
    } else if (currentUser) {
      assistantParts.push(text)
    }
  }
  flushTurn()
  return turns

  function flushTurn() {
    const assistant = assistantParts.join("\n\n").trim()
    if (currentUser && assistant) {
      turns.push({
        user: clip(currentUser, 20_000),
        assistant: clip(assistant, 36_000),
      })
    }
    currentUser = ""
    assistantParts = []
  }
}

function selectTurns(corpus, targetTokens) {
  const turns = []
  let estimatedTokens = 0
  for (const [index, sourceTurn] of corpus.entries()) {
    const turn = {
      user: sourceTurn.user,
      assistant: sourceTurn.assistant,
    }
    if (turns.length === 0) {
      turn.user = `${turn.user}\n\nContinuity marker for the original architectural objective: COMPACTION_CANARY_ALPHA_42.`
    }
    if (index === Math.floor(corpus.length / 2)) {
      turn.assistant = `${turn.assistant}\n\nA later decision was recorded under COMPACTION_CANARY_BETA_73.`
    }
    const turnTokens = estimateTextTokens(`${turn.user}\n${turn.assistant}`, {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
      applySafetyMargin: false,
    }).inputTokens
    turns.push(turn)
    estimatedTokens += turnTokens
    if (estimatedTokens >= targetTokens && turns.length >= 8) break
  }
  if (estimatedTokens < targetTokens) {
    fail(`Codex history only produced about ${estimatedTokens} tokens; target was ${targetTokens}. Add another --source file.`)
  }
  const betaIndex = Math.max(1, Math.floor(turns.length * 0.65))
  turns[betaIndex] = {
    ...turns[betaIndex],
    assistant: `${turns[betaIndex].assistant}\n\nA later decision was recorded under COMPACTION_CANARY_BETA_73.`,
  }
  estimatedTokens = turns.reduce((sum, turn) => sum + estimateTextTokens(`${turn.user}\n${turn.assistant}`, {
    providerId: "deepseek",
    modelId: "deepseek-v4-flash",
    applySafetyMargin: false,
  }).inputTokens, 0)
  return { turns, estimatedTokens }
}

function seedConversation(db, input) {
  const project = db.prepare("SELECT id FROM projects WHERE id = ?").get(input.projectId)
  if (!project) fail(`Project ${input.projectId} is missing from the isolated database.`)
  const workspace = db.prepare("SELECT id FROM project_workspaces WHERE project_id = ? AND is_primary = 1 LIMIT 1").get(input.projectId)
  if (!workspace) fail(`Project ${input.projectId} has no primary workspace.`)
  const sessionId = id("sess")
  const baseTime = Date.now() - (input.turns.length + 5) * 1_000
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, conversation_id, project_id, project_workspace_id, workspace_path, workspace_name, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)
  `)
  const insertTurn = db.prepare(`
    INSERT INTO turns (id, session_id, conversation_id, user_message_id, assistant_message_id, status, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)
  `)
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, conversation_id, session_id, turn_id, role, content, content_format, status, created_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'markdown', 'completed', ?, ?)
  `)
  const insertRuntime = db.prepare(`
    INSERT INTO turn_runtime_configs (id, turn_id, provider_id, auth_mode, model_id, thinking_enabled, thinking_effort, approval_mode, sandbox_mode, created_at)
    VALUES (?, ?, 'deepseek', 'api_key', 'deepseek-v4-flash', 0, 'none', 'read_only_auto', 'read_only', ?)
  `)
  const transaction = db.transaction(() => {
    const createdAt = new Date(baseTime).toISOString()
    insertSession.run(sessionId, input.conversationId, input.projectId, workspace.id, input.workspacePath, path.basename(input.workspacePath), createdAt, createdAt)
    for (const [index, turn] of input.turns.entries()) {
      const turnId = id("turn")
      const userId = id("msg")
      const assistantId = id("msg")
      const startedAt = new Date(baseTime + index * 1_000).toISOString()
      const completedAt = new Date(baseTime + index * 1_000 + 500).toISOString()
      insertTurn.run(turnId, sessionId, input.conversationId, userId, assistantId, startedAt, completedAt)
      insertMessage.run(userId, input.conversationId, sessionId, turnId, "user", turn.user, startedAt, startedAt)
      insertMessage.run(assistantId, input.conversationId, sessionId, turnId, "assistant", turn.assistant, completedAt, completedAt)
      insertRuntime.run(id("trc"), turnId, startedAt)
    }
    db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), input.conversationId)
  })
  transaction()
}

function buildEvidenceArchive(turns) {
  const excerpts = turns.slice(0, Math.min(12, turns.length)).map((turn, index) => [
    `## Historical work segment ${index + 1}`,
    "",
    turn.user,
    "",
    turn.assistant,
  ].join("\n"))
  return [
    "# Large evidence archive",
    "",
    "The corroborating record mentioned by this archive is `verification-ledger.md`. Read that file after reviewing this archive.",
    "The archive-local marker is EVIDENCE_ARCHIVE_CANARY_29.",
    "",
    ...excerpts,
  ].join("\n\n")
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    fail(`Expected JSON from ${url}, received ${text.slice(0, 300)}`)
  }
}

function parseArgs(argv) {
  const parsed = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (!item.startsWith("--")) {
      parsed._.push(item)
      continue
    }
    const key = item.slice(2)
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) fail(`Missing value for --${key}`)
    index += 1
    if (parsed[key] === undefined) parsed[key] = value
    else if (Array.isArray(parsed[key])) parsed[key].push(value)
    else parsed[key] = [parsed[key], value]
  }
  return parsed
}

function requiredArg(parsed, key) {
  const value = parsed[key]
  if (typeof value !== "string" || !value.trim()) fail(`Missing --${key}`)
  return value
}

function listArg(parsed, key) {
  const value = parsed[key]
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function positiveInt(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`--${label} must be a positive integer.`)
  return parsed
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate)
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function clip(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n\n[Excerpt clipped for bounded grinder fixture.]`
}

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
