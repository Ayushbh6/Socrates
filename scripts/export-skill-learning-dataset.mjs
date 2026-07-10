import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=")
  return [key, rest.join("=") || true]
}))
const codexHome = String(args.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"))
const configPath = path.resolve(String(args.config || "evals/skill-learning/private/source-threads.json"))
const outputPath = path.resolve(String(args.output || "evals/skill-learning/private/candidate-corpus.json"))
const statePath = path.join(codexHome, "state_5.sqlite")

if (!fs.existsSync(configPath)) throw new Error(`Missing private source config: ${configPath}`)
if (!fs.existsSync(statePath)) throw new Error(`Missing Codex task index: ${statePath}`)

const config = JSON.parse(fs.readFileSync(configPath, "utf8"))
const ids = config.sources.map((source) => source.threadId)
const quotedIds = ids.map((id) => `'${String(id).replaceAll("'", "''")}'`).join(",")
const rows = JSON.parse(execFileSync("sqlite3", ["-json", statePath, `select id,title,cwd,rollout_path,created_at,updated_at from threads where id in (${quotedIds})`], { encoding: "utf8" }) || "[]")
const rowById = new Map(rows.map((row) => [row.id, row]))

const threads = config.sources.map((source) => {
  const row = rowById.get(source.threadId)
  if (!row) throw new Error(`Codex task not found: ${source.threadId}`)
  if (!fs.existsSync(row.rollout_path)) throw new Error(`Codex rollout not found: ${row.rollout_path}`)
  const turns = extractTurns(row.rollout_path)
  return {
    sourceId: source.sourceId,
    threadId: row.id,
    title: sanitize(row.title),
    phase: source.phase,
    labels: source.labels,
    createdAt: new Date(row.created_at * 1000).toISOString(),
    turns,
  }
})

const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  provenance: {
    source: "local_codex_rollout_jsonl",
    stateDatabase: "${CODEX_HOME}/state_5.sqlite",
    policy: "Visible user messages and final assistant answers only; system, developer, reasoning, tool arguments, tool outputs, and credentials excluded.",
  },
  threads,
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ outputPath, threadCount: threads.length, turnCount: threads.reduce((sum, thread) => sum + thread.turns.length, 0) }))

function extractTurns(rolloutPath) {
  const turns = []
  let current
  for (const line of fs.readFileSync(rolloutPath, "utf8").split("\n")) {
    if (!line.trim()) continue
    let item
    try { item = JSON.parse(line) } catch { continue }
    if (item.type === "event_msg" && item.payload?.type === "user_message" && typeof item.payload.message === "string") {
      const user = sanitize(item.payload.message)
      if (!user || isInjectedContext(user)) continue
      current = { sourceTurnIndex: turns.length + 1, timestamp: item.timestamp, user, assistant: "" }
      turns.push(current)
      continue
    }
    if (current && item.type === "response_item" && item.payload?.type === "message" && item.payload.role === "assistant" && item.payload.phase === "final") {
      const text = Array.isArray(item.payload.content)
        ? item.payload.content.filter((entry) => entry?.type === "output_text" && typeof entry.text === "string").map((entry) => entry.text).join("\n")
        : ""
      if (text) current.assistant = sanitize(text).slice(0, 4_000)
    }
  }
  return turns
}

function isInjectedContext(text) {
  return /^<(?:environment_context|permissions instructions|recommended_plugins|app-context|skills_instructions|developer)/.test(text.trim())
}

function sanitize(value) {
  return String(value)
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:sk|ds|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\b[A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*\S+/gi, "[REDACTED_CREDENTIAL]")
    .replaceAll(os.homedir(), "~")
    .replace(/\u0000/g, "")
    .trim()
}
