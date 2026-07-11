#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const threadId = process.argv[2] ?? "019f4ca4-da90-7161-9586-f687cb9dfa72"
const sourcePath = findSession(threadId)
if (!sourcePath) throw new Error(`Could not find Codex session ${threadId}`)

const grouped = new Map()
for (const line of fs.readFileSync(sourcePath, "utf8").split(/\r?\n/)) {
  if (!line.trim()) continue
  const row = JSON.parse(line)
  const payload = row.type === "response_item" ? row.payload : undefined
  if (payload?.type !== "message" || !["user", "assistant"].includes(payload.role)) continue
  if (payload.role === "assistant" && payload.phase && payload.phase !== "final_answer") continue
  const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id
  if (!turnId) continue
  const text = sanitize((payload.content ?? []).map((item) => item.text ?? "").join("\n")).trim()
  if (!text || isEnvelope(text)) continue
  const entry = grouped.get(turnId) ?? { turnId, user: [], assistant: [] }
  entry[payload.role].push(text)
  grouped.set(turnId, entry)
}

const natural = [...grouped.values()]
  .filter((entry) => entry.user.length > 0 && entry.assistant.length > 0)
  .slice(0, 28)
  .map((entry, index) => ({
    turnNo: index + 1,
    turnId: `codex_${index + 1}`,
    user: entry.user.join("\n\n").slice(0, 8_000),
    assistant: entry.assistant.join("\n\n").slice(0, 8_000),
    source: "codex_session",
  }))

const canaries = [
  ["Remember the exact recovery phrase ORCHID-NEBULA-731. It must remain exact.", "Recorded the exact recovery phrase ORCHID-NEBULA-731 for traceable evaluation."],
  ["The temporary context hard cap is MEMORY_HARD_CAP=200000. This is provisional.", "Recorded MEMORY_HARD_CAP=200000 as provisional, not durable."],
  ["The failing command is pnpm --filter @socrates/core test -- contextCompression.test.ts and the file is packages/core/src/context/contextCompression.ts.", "Recorded the exact command and file path; this failure remains unresolved."],
  ["I prefer discussing edges, agreeing a plan, setting a goal, implementing, and then reviewing.", "Recorded the user's ordered collaboration workflow as a durable preference."],
  ["The attached source is .socrates/attachments/pasted-text-eval.txt. Read it selectively before relying on it.", "Recorded the attachment path and the requirement to inspect it before answering."],
  ["Correction: MEMORY_HARD_CAP=200000 is stale. The final hard cap is MEMORY_HARD_CAP=180000 and post-compaction target is 120000.", "Superseded the provisional cap. Current decision: MEMORY_HARD_CAP=180000; target=120000."],
  ["The registry is authoritative TypeScript; the generated surface map is only the tiny model-readable projection.", "Recorded the architecture decision and marked the registry implementation complete."],
  ["The unresolved task is to prove exact trace recovery after repeated compaction. Do not mark it completed until the downstream agent retrieves ORCHID-NEBULA-731.", "Kept exact trace recovery open; registry implementation is completed separately."],
]

const turns = [...natural]
for (const [[user, assistant], index] of canaries.map((entry, index) => [entry, index])) {
  const insertionIndex = Math.min(turns.length, 4 + index * 5)
  turns.splice(insertionIndex, 0, { turnNo: 0, turnId: `canary_${index + 1}`, user, assistant, source: "synthetic_canary" })
}
turns.forEach((turn, index) => { turn.turnNo = index + 1 })

const dataset = {
  schemaVersion: 1,
  source: { threadId, sanitized: true, sourceFile: path.basename(sourcePath), naturalTurnCount: natural.length },
  turns,
  checks: [
    { id: "exact_quote", required: ["ORCHID-NEBULA-731"] },
    { id: "current_cap", required: ["180000", "120000"], forbidden: ["final hard cap is MEMORY_HARD_CAP=200000"] },
    { id: "command", required: ["pnpm --filter @socrates/core test -- contextCompression.test.ts"] },
    { id: "file_path", required: ["packages/core/src/context/contextCompression.ts"] },
    { id: "workflow", requiredConcepts: ["discuss", "plan", "goal", "implement", "review"] },
    { id: "attachment", required: [".socrates/attachments/pasted-text-eval.txt"] },
    { id: "registry", requiredConcepts: ["authoritative TypeScript", "surface map"] },
    { id: "open_loop", requiredConcepts: ["trace recovery", "unresolved"] }
  ]
}

const out = path.resolve("evals/memory-harness/private/golden-dataset.json")
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, `${JSON.stringify(dataset, null, 2)}\n`)
console.log(JSON.stringify({ out, threadId, naturalTurns: natural.length, totalTurns: turns.length }, null, 2))

function findSession(id) {
  const root = path.join(process.env.HOME, ".codex", "sessions")
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(target)
      else if (entry.name.endsWith(`${id}.jsonl`)) return target
    }
  }
}

function isEnvelope(text) {
  return text.startsWith("<recommended_plugins>") || text.startsWith("<environment_context>") || text.startsWith("<developer")
}

function sanitize(text) {
  return text
    .replaceAll(/\/Users\/[^/\s]+/g, "<HOME>")
    .replaceAll(/(?:sk|ds)-[A-Za-z0-9_-]{12,}/g, "<REDACTED_KEY>")
    .replaceAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<REDACTED_EMAIL>")
}
