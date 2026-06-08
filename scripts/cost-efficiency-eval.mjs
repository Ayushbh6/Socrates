import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { createRequire } from "node:module"
import { evaluateTurnEfficiency } from "../packages/providers/dist/index.js"

// Operational eval: scores recent turns in the live Socrates DB for cost
// efficiency (routing, prompt-cache reuse, round-trips) using the same shared
// analyzer that the unit eval (`costEfficiency.test.ts`) guards in CI.

const require = createRequire(import.meta.url)
const Database = loadSqlite()

const dbPath =
  process.env.SOCRATES_DB_PATH ?? path.join(process.env.SOCRATES_HOME ?? path.join(os.homedir(), ".Socrates"), "socrates.sqlite")

if (!fs.existsSync(dbPath)) {
  console.error(`Socrates DB not found at ${dbPath}. Set SOCRATES_DB_PATH to override.`)
  process.exit(1)
}

const limit = Number(process.argv[2] ?? process.env.COST_EVAL_TURNS ?? 15)
const blockedRoutedProviders = (process.env.COST_EVAL_BLOCKED_PROVIDERS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)

const db = new Database(dbPath, { readonly: true })

const turnRows = db
  .prepare(
    `SELECT e.turn_id AS turnId, MAX(c.title) AS title, MIN(e.created_at) AS createdAt
     FROM ai_usage_events e
     LEFT JOIN conversations c ON c.id = e.conversation_id
     GROUP BY e.turn_id
     ORDER BY MIN(e.created_at) DESC
     LIMIT ?`,
  )
  .all(limit)

const callStmt = db.prepare(
  `SELECT source_kind AS sourceKind, model_id AS modelId, routed_provider AS routedProvider,
          COALESCE(uncached_input_tokens, 0) AS uncachedInputTokens,
          COALESCE(cached_input_tokens, 0) AS cachedInputTokens,
          COALESCE(output_tokens, 0) AS outputTokens,
          COALESCE(reasoning_tokens, 0) AS reasoningTokens,
          cost_usd AS costUsd
   FROM ai_usage_events WHERE turn_id = ? ORDER BY created_at`,
)

let failures = 0
console.log(`\nSocrates cost-efficiency eval — ${turnRows.length} most recent turns\nDB: ${dbPath}\n`)

for (const turn of turnRows.reverse()) {
  const calls = callStmt.all(turn.turnId).map((row) => ({
    sourceKind: row.sourceKind,
    modelId: row.modelId,
    routedProvider: row.routedProvider ?? undefined,
    uncachedInputTokens: Number(row.uncachedInputTokens),
    cachedInputTokens: Number(row.cachedInputTokens),
    outputTokens: Number(row.outputTokens),
    reasoningTokens: Number(row.reasoningTokens),
    costUsd: row.costUsd === null ? undefined : Number(row.costUsd),
  }))

  const report = evaluateTurnEfficiency(calls, blockedRoutedProviders.length > 0 ? { blockedRoutedProviders } : {})
  if (!report.passed) {
    failures += 1
  }

  const rate = report.blendedInputRatePerMTokens
  const cost = report.costUsd
  const title = (turn.title ?? "untitled").slice(0, 28).padEnd(28)
  const status = report.passed ? "PASS" : "FAIL"
  console.log(
    `[${status}] ${title} calls=${String(report.modelCallCount).padStart(2)} ` +
      `cache=${(report.cacheReadRatio * 100).toFixed(0).padStart(3)}% ` +
      `rate=${rate === undefined ? "  n/a" : `$${rate.toFixed(2)}/M`} ` +
      `cost=${cost === undefined ? "n/a" : `$${cost.toFixed(4)}`} ` +
      `providers=[${report.routedProviders.join(", ") || "?"}]`,
  )
  if (report.flags.length > 0) {
    console.log(`         flags: ${report.flags.join(", ")}`)
  }
}

console.log(`\n${turnRows.length - failures}/${turnRows.length} turns passed.\n`)
db.close()
process.exit(failures > 0 ? 1 : 0)

function loadSqlite() {
  for (const id of ["better-sqlite3", path.resolve("apps/server/node_modules/better-sqlite3")]) {
    try {
      return require(id)
    } catch {
      // try next candidate
    }
  }
  console.error("Could not load better-sqlite3. Run from the repo root after installing dependencies.")
  process.exit(1)
}
