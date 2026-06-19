import fs from "node:fs"
import path from "node:path"
import { AiSdkProvider } from "../packages/providers/dist/index.js"
import {
  COMPRESSOR_SYSTEM_PROMPT,
  DEFAULT_COMPRESSOR_FALLBACK_MODEL,
  DEFAULT_COMPRESSOR_MODEL,
  DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS,
  buildCompressorUserMessageContent,
} from "../packages/core/dist/index.js"

loadEnvFile(".env")
loadEnvFile("apps/server/.env")

const candidates = [
  DEFAULT_COMPRESSOR_MODEL,
  DEFAULT_COMPRESSOR_FALLBACK_MODEL,
]

const requiredFacts = [
  "TRACE-ALPHA-42",
  "OpenRouter thinking off must send reasoning effort none and exclude true",
  "context-files/REPO_RULES.md is the strict source of truth",
  "Stop during compaction finishes the snapshot then cancels further work",
  "Recent user and assistant messages remain real role-typed messages",
]

const fixture = {
  latestSnapshot: {
    snapshotId: "ctxcmp_previous",
    renderedSummary:
      "The user chose a hidden contextual compression system. It must preserve exact trace_retrieve handles and avoid storing summaries as messages.",
    sourceHandles: [{ messageId: "msg_old_1" }, { turnId: "turn_old_1" }],
  },
  messages: [
    {
      role: "user",
      id: "msg_1",
      turnId: "turn_1",
      content:
        "Important exact anchor TRACE-ALPHA-42. context-files/REPO_RULES.md is the strict source of truth. We need never-ending conversation quality after 7 compactions.",
    },
    {
      role: "assistant",
      id: "msg_2",
      turnId: "turn_1",
      content:
        "Decision: OpenRouter thinking off must send reasoning effort none and exclude true. Recent user and assistant messages remain real role-typed messages.",
    },
    {
      role: "user",
      id: "msg_3",
      turnId: "turn_2",
      content: "Stop during compaction finishes the snapshot then cancels further work. Do not mutate in-flight tool execution state.",
    },
  ],
}

const runCandidate = async (candidate) => {
  const provider = new AiSdkProvider()
  let text = ""
  let usage = undefined
  for await (const event of provider.stream({
    ...candidate,
    system: COMPRESSOR_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildCompressorUserMessageContent({
          latestSnapshot: fixture.latestSnapshot,
          messages: fixture.messages,
          thresholds: DEFAULT_CONTEXT_COMPRESSION_THRESHOLDS,
        }),
      },
    ],
    runtimeConfig: {
      ...candidate,
      thinkingEnabled: false,
      thinkingEffort: "none",
      approvalMode: "read_only_auto",
      sandboxMode: "read_only",
    },
    tools: [],
  })) {
    if (event.type === "model.answer.delta") {
      text += event.text
    }
    if (event.type === "model.usage" || event.type === "model.completed") {
      usage = event.usage ?? usage
    }
    if (event.type === "model.failed") {
      throw event.error
    }
  }

  const compacted = parseJson(text)
  const serialized = JSON.stringify(compacted)
  const preservedFacts = requiredFacts.filter((fact) => serialized.includes(fact))
  return {
    ...candidate,
    preservedFacts,
    missingFacts: requiredFacts.filter((fact) => !serialized.includes(fact)),
    faithfulnessScore: preservedFacts.length,
    outputChars: serialized.length,
    usage,
    compacted,
  }
}

if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is required for the live context compression evaluation gate.")
  process.exit(1)
}

const results = []
for (const candidate of candidates) {
  try {
    results.push(await runCandidate(candidate))
  } catch (error) {
    results.push({
      ...candidate,
      faithfulnessScore: 0,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const winner = [...results].sort((a, b) => b.faithfulnessScore - a.faithfulnessScore || a.outputChars - b.outputChars)[0]
console.log(JSON.stringify({ winner, results }, null, 2))

if (!winner || winner.faithfulnessScore < requiredFacts.length) {
  process.exit(1)
}

function parseJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end < start) {
    throw new Error(`Candidate did not return JSON: ${text.slice(0, 300)}`)
  }
  return JSON.parse(trimmed.slice(start, end + 1))
}

function loadEnvFile(relativePath) {
  const envPath = path.resolve(process.cwd(), relativePath)
  if (!fs.existsSync(envPath)) {
    return
  }

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }
    const index = trimmed.indexOf("=")
    if (index <= 0) {
      continue
    }
    const key = trimmed.slice(0, index).trim()
    const rawValue = trimmed.slice(index + 1).trim()
    if (!key || process.env[key] !== undefined) {
      continue
    }
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "")
  }
}
