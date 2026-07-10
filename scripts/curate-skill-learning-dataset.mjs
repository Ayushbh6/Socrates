import fs from "node:fs"
import path from "node:path"

const inputPath = path.resolve(process.argv.find((arg) => arg.startsWith("--input="))?.slice(8) || "evals/skill-learning/private/candidate-corpus.json")
const outputPath = path.resolve(process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) || "evals/skill-learning/private/golden-dataset.json")
const corpus = JSON.parse(fs.readFileSync(inputPath, "utf8"))
const threads = new Map(corpus.threads.map((thread) => [thread.sourceId, thread]))

const selection = (sourceId, indexes) => indexes.map((index) => {
  const thread = threads.get(sourceId)
  const turn = thread?.turns.find((candidate) => candidate.sourceTurnIndex === index)
  if (!thread || !turn) throw new Error(`Missing curated source ${sourceId}:${index}`)
  return {
    sourceAnchor: `${sourceId}:${index}`,
    timestamp: turn.timestamp,
    conversationTitle: thread.title.slice(0, 160),
    projectKey: sourceId === "cross-project-01" ? "Another" : sourceId === "cross-project-02" || sourceId === "cross-project-03" ? "AI_DPA" : "Socrates",
    user: turn.user.slice(0, 8_000),
    assistant: turn.assistant.slice(0, 4_000),
    synthetic: false,
  }
})

const creationEvidence = [
  ...selection("natural-01", [13, 25, 29, 30, 31, 41]),
  ...selection("natural-02", [1, 4, 5, 6]),
  ...selection("natural-03", [1, 2]),
  ...selection("natural-05", [1, 17, 18, 19, 20, 21]),
  ...selection("cross-project-01", [1]),
  ...selection("cross-project-02", [1, 2, 11]),
  ...selection("natural-12", [2]),
]
const negativeEvidence = selection("natural-10", [1, 5, 6, 7, 8])
const updateEvidence = [
  ...selection("natural-02", [18, 20]),
  ...selection("cross-project-02", [21, 22]),
  ...selection("natural-12", [4, 5, 6]),
]

const cases = [
  {
    id: "behavioral-workflow-create",
    kind: "create",
    evidence: creationEvidence,
    expected: {
      proposal: true,
      scope: "global",
      prohibitedTopicSkills: ["deepseek", "memory", "typescript", "repo-docs"],
      pattern: "Clarify and inspect context before edits, ask questions to remove assumptions, form an explicit plan, wait for an implementation gate, implement narrowly, verify, and review.",
      minimumDistinctSourceTurns: 2
    }
  },
  {
    id: "repeated-topic-negative-control",
    kind: "negative",
    evidence: negativeEvidence,
    expected: {
      proposal: false,
      reason: "Repeated discussion of DeepSeek and prompt/runtime mechanics is subject matter, not by itself a reusable behavioral procedure."
    }
  },
  {
    id: "behavioral-workflow-update",
    kind: "update",
    evidence: updateEvidence,
    expected: {
      proposal: true,
      preserve: ["context-first", "clarification", "explicit implementation gate", "verification"],
      add: ["after successful verification, audit durable docs and memory against the current state", "remove stale or conflicting restart information", "leave a clean handoff before a new chat or phase", "the next chat returns to discussion before implementation"]
    }
  },
  {
    id: "heldout-use-v1",
    kind: "heldout_use",
    evidence: [{
      sourceAnchor: "synthetic:heldout-v1",
      timestamp: "2026-07-11T09:00:00.000Z",
      conversationTitle: "Held-out architecture request",
      user: "I want to redesign the authentication architecture. Do not edit anything yet. First inspect the project context, talk through the edge cases with me, and ask the questions needed to remove assumptions. Once we agree, I will ask for a plan and then explicitly authorize implementation.",
      assistant: "",
      synthetic: true
    }],
    expected: {
      skillListed: true,
      skillDescribed: true,
      noImplementationClaim: true,
      responseSignals: ["context", "questions", "no edits", "plan after alignment"]
    }
  },
  {
    id: "heldout-use-v2",
    kind: "heldout_use",
    evidence: [{
      sourceAnchor: "synthetic:heldout-v2",
      timestamp: "2026-07-12T09:00:00.000Z",
      conversationTitle: "Held-out evaluation request",
      user: "The implementation and verification are complete. Before I move to a new chat, audit the durable project docs and memory against the actual current state, remove stale or conflicting restart information, and give me a clean handoff prompt. The next chat must begin with context gathering and discussion, not immediate edits.",
      assistant: "",
      synthetic: true
    }],
    expected: {
      skillListed: true,
      skillDescribed: true,
      responseSignals: ["docs", "memory", "stale", "handoff", "new chat", "no edits"]
    }
  }
]

const output = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  provenance: corpus.provenance,
  splitPolicy: "Creation evidence establishes the core phased workflow. The maturation phase withholds later closure/handoff evidence plus older cross-project corroboration until after v1 exists. Synthetic held-out requests are labeled and excluded from learning input.",
  cases,
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify({ outputPath, cases: cases.length, naturalEvidence: creationEvidence.length + negativeEvidence.length + updateEvidence.length, syntheticEvidence: 2 }))
