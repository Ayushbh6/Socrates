import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { RuntimeConfig } from "@socrates/contracts"
import { AiSdkProvider, type ModelEvent } from "@socrates/providers"
import { createId, nowIso } from "@socrates/shared"
import { resolveSocratesHome } from "../apps/server/src/config"
import { openDatabase, runMigrations } from "../apps/server/src/db/client"
import { ProviderCredentialStore } from "../apps/server/src/services/providerCredentials"
import { SocratesStore } from "../apps/server/src/services/store"

type Args = {
  live: boolean
  fixture: boolean
  model: string
  thinking: "off" | "low" | "medium" | "high" | "xhigh"
  dbPath?: string
}

const args = parseArgs(process.argv.slice(2))

const main = async (): Promise<void> => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-trace-e2e-"))
  const dbPath = args.dbPath ?? path.join(workspacePath, "socrates.sqlite")
  const handle = openDatabase(dbPath)
  runMigrations(handle)
  const store = new SocratesStore(handle)

  try {
    const fixture = createTraceFixture(store, workspacePath)
    const checks = await runToolChecks(store, fixture)
    for (const check of checks) {
      console.log(`ok - ${check}`)
    }

    if (args.live) {
      const answer = await runModelCheck(args, fixture, checks)
      console.log("ok - live model answered without inventing provenance")
      console.log(answer)
    }
  } finally {
    await store.close()
    if (!args.dbPath) {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  }
}

type Fixture = {
  projectId: string
  currentConversationId: string
  visibleFileName: string
  deletedFileName: string
  secondaryFileName: string
  attachmentsDir: string
}

const createTraceFixture = (store: SocratesStore, workspacePath: string): Fixture => {
  const now = nowIso()
  const userId = createId("user")
  const projectId = createId("proj")
  const attachmentsDir = path.join(workspacePath, ".socrates", "attachments")
  fs.mkdirSync(attachmentsDir, { recursive: true })

  const sqlite = (store as unknown as { handle: { sqlite: import("better-sqlite3").Database } }).handle.sqlite
  sqlite
    .prepare(
      `INSERT INTO users (id, display_name, onboarding_completed, created_at, updated_at, onboarded_at)
       VALUES (?, ?, 1, ?, ?, ?)`,
    )
    .run(userId, "Trace E2E", now, now, now)
  sqlite
    .prepare(
      `INSERT INTO projects (id, user_id, name, description, status, created_at, updated_at)
       VALUES (?, ?, 'Trace E2E Project', 'Trace retrieval fixture', 'active', ?, ?)`,
    )
    .run(projectId, userId, now, now)

  const currentConversationId = insertConversation(sqlite, projectId, userId, "Current trace test chat", workspacePath, now)

  const visibleFileName = "Screenshot_visible_origin.png"
  fs.writeFileSync(path.join(attachmentsDir, visibleFileName), "visible image placeholder")
  const visible = insertTurn(sqlite, {
    projectId,
    userId,
    conversationTitle: "Visible image source",
    workspacePath,
    now,
    userContent: `Here is the screenshot named ${visibleFileName}.`,
    assistantContent: "I can see the attached screenshot reference.",
  })
  insertAttachment(sqlite, {
    projectId,
    conversationId: visible.conversationId,
    sessionId: visible.sessionId,
    turnId: visible.turnId,
    messageId: visible.userMessageId,
    fileName: visibleFileName,
    uri: `.socrates/attachments/${visibleFileName}`,
    sizeBytes: fs.statSync(path.join(attachmentsDir, visibleFileName)).size,
    now,
  })
  store.indexTurnTraceDocuments(projectId, visible.conversationId, visible.turnId)

  const secondaryFileName = "Screenshot_secondary_only.png"
  fs.writeFileSync(path.join(attachmentsDir, secondaryFileName), "secondary image placeholder")
  const secondary = insertTurn(sqlite, {
    projectId,
    userId,
    conversationTitle: "Secondary recap only",
    workspacePath,
    now,
    userContent: "What did we say about old screenshots?",
    assistantContent: `A previous conversation mentioned ${secondaryFileName}, but this message is only a recap.`,
  })
  store.indexTurnTraceDocuments(projectId, secondary.conversationId, secondary.turnId)

  const deletedFileName = "Screenshot_deleted_origin.png"
  fs.writeFileSync(path.join(attachmentsDir, deletedFileName), "deleted image placeholder")
  const deleted = insertTurn(sqlite, {
    projectId,
    userId,
    conversationTitle: "Deleted image source",
    workspacePath,
    now,
    userContent: `Attached deleted-origin screenshot ${deletedFileName}.`,
    assistantContent: "Acknowledged.",
  })
  insertAttachment(sqlite, {
    projectId,
    conversationId: deleted.conversationId,
    sessionId: deleted.sessionId,
    turnId: deleted.turnId,
    messageId: deleted.userMessageId,
    fileName: deletedFileName,
    uri: `.socrates/attachments/${deletedFileName}`,
    sizeBytes: fs.statSync(path.join(attachmentsDir, deletedFileName)).size,
    now,
  })
  store.indexTurnTraceDocuments(projectId, deleted.conversationId, deleted.turnId)
  store.deleteConversation(projectId, deleted.conversationId)

  return { projectId, currentConversationId, visibleFileName, deletedFileName, secondaryFileName, attachmentsDir }
}

const runToolChecks = async (store: SocratesStore, fixture: Fixture): Promise<string[]> => {
  const checks: string[] = []
  const visible = await store.retrieveToolTraces(fixture.projectId, fixture.currentConversationId, {
    query: fixture.visibleFileName,
    mode: "exact",
    scope: "project",
  })
  const visibleResult = visible.results[0]
  if (!visibleResult || visibleResult.provenanceQuality !== "attachment_origin" || visibleResult.conversationTitle !== "Visible image source") {
    throw new Error(`Visible attachment provenance failed: ${JSON.stringify(visible.results)}`)
  }
  checks.push("exact filename search returns attachment-origin provenance")

  const secondary = await store.retrieveToolTraces(fixture.projectId, fixture.currentConversationId, {
    query: fixture.secondaryFileName,
    mode: "exact",
    scope: "project",
  })
  if (secondary.results.some((result) => result.provenanceQuality === "attachment_origin")) {
    throw new Error(`Secondary recap was treated as origin: ${JSON.stringify(secondary.results)}`)
  }
  checks.push("secondary recaps are not treated as attachment origin")

  const deleted = await store.retrieveToolTraces(fixture.projectId, fixture.currentConversationId, {
    query: fixture.deletedFileName,
    mode: "exact",
    scope: "project",
  })
  if (deleted.results.length !== 0) {
    throw new Error(`Deleted conversation trace leaked into normal search: ${JSON.stringify(deleted.results)}`)
  }
  if (!fs.existsSync(path.join(fixture.attachmentsDir, fixture.deletedFileName))) {
    throw new Error("Deleted-origin attachment file should remain on disk for filesystem fallback.")
  }
  checks.push("deleted conversation provenance is invisible while attachment file remains")

  const auditRequired = await store
    .retrieveToolTraces(fixture.projectId, fixture.currentConversationId, {
      query: "trace tool audit",
      include: ["tool_calls"],
    })
    .then(
      () => false,
      (error) => error instanceof Error && error.message.includes("mode=\"audit\""),
    )
  if (!auditRequired) {
    throw new Error("Runtime include did not require audit mode.")
  }
  checks.push("runtime evidence requires audit mode")
  return checks
}

const runModelCheck = async (input: Args, fixture: Fixture, checks: string[]): Promise<string> => {
  const provider = new AiSdkProvider(new ProviderCredentialStore({ socratesHome: resolveSocratesHome() }))
  const [providerId, ...modelParts] = input.model.split("/")
  const modelId = modelParts.join("/")
  if (!providerId || !modelId) {
    throw new Error(`Expected --model provider/model, got ${input.model}`)
  }
  let answer = ""
  const runtimeConfig: RuntimeConfig = {
    providerId: providerId as RuntimeConfig["providerId"],
    modelId,
    thinkingEnabled: input.thinking !== "off",
    thinkingEffort: input.thinking === "off" ? "none" : input.thinking,
    approvalMode: "manual",
    sandboxMode: "read_only",
  }
  for await (const event of provider.stream({
    providerId: runtimeConfig.providerId,
    modelId,
    runtimeConfig,
    system:
      "You are validating trace retrieval. Answer from the supplied evidence only. Do not invent conversation titles. If a file exists only on disk without trace provenance, say there is no active conversation provenance.",
    messages: [
      {
        role: "user",
        content: [
          `Checks passed: ${checks.join("; ")}`,
          `Visible filename: ${fixture.visibleFileName} came from conversation title "Visible image source".`,
          `Deleted filename: ${fixture.deletedFileName} has no active trace result, but exists at .socrates/attachments/${fixture.deletedFileName}.`,
          `Secondary filename: ${fixture.secondaryFileName} was only mentioned in a recap and is not origin provenance.`,
          "Return one paragraph with these facts and no extra conversation titles.",
        ].join("\n"),
      },
    ],
  })) {
    if ((event as ModelEvent).type === "model.answer.delta") {
      answer += (event as Extract<ModelEvent, { type: "model.answer.delta" }>).text
    }
    if ((event as ModelEvent).type === "model.failed") {
      throw (event as Extract<ModelEvent, { type: "model.failed" }>).error
    }
  }
  if (answer.includes("Deleted image source") || answer.includes("Secondary recap only")) {
    throw new Error(`Model invented or promoted invalid provenance: ${answer}`)
  }
  return answer.trim()
}

const insertConversation = (
  sqlite: import("better-sqlite3").Database,
  projectId: string,
  userId: string,
  title: string,
  workspacePath: string,
  now: string,
): string => {
  const conversationId = createId("conv")
  const sessionId = createId("sess")
  sqlite
    .prepare(
      `INSERT INTO conversations (id, project_id, user_id, title, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(conversationId, projectId, userId, title, now, now)
  sqlite
    .prepare(
      `INSERT INTO sessions (id, conversation_id, project_id, workspace_path, workspace_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'trace-e2e', 'active', ?, ?)`,
    )
    .run(sessionId, conversationId, projectId, workspacePath, now, now)
  return conversationId
}

const insertTurn = (
  sqlite: import("better-sqlite3").Database,
  input: {
    projectId: string
    userId: string
    conversationTitle: string
    workspacePath: string
    now: string
    userContent: string
    assistantContent: string
  },
) => {
  const conversationId = insertConversation(sqlite, input.projectId, input.userId, input.conversationTitle, input.workspacePath, input.now)
  const session = sqlite.prepare("SELECT id FROM sessions WHERE conversation_id = ? LIMIT 1").get(conversationId) as { id: string }
  const turnId = createId("turn")
  const userMessageId = createId("msg")
  const assistantMessageId = createId("msg")
  sqlite
    .prepare(
      `INSERT INTO turns (id, session_id, conversation_id, user_message_id, assistant_message_id, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`,
    )
    .run(turnId, session.id, conversationId, userMessageId, assistantMessageId, input.now, input.now)
  sqlite
    .prepare(
      `INSERT INTO messages (id, conversation_id, session_id, turn_id, role, content, content_format, status, created_at, completed_at)
       VALUES (?, ?, ?, ?, 'user', ?, 'text', 'completed', ?, ?)`,
    )
    .run(userMessageId, conversationId, session.id, turnId, input.userContent, input.now, input.now)
  sqlite
    .prepare(
      `INSERT INTO messages (id, conversation_id, session_id, turn_id, role, content, content_format, status, created_at, completed_at)
       VALUES (?, ?, ?, ?, 'assistant', ?, 'text', 'completed', ?, ?)`,
    )
    .run(assistantMessageId, conversationId, session.id, turnId, input.assistantContent, input.now, input.now)
  return { conversationId, sessionId: session.id, turnId, userMessageId, assistantMessageId }
}

const insertAttachment = (
  sqlite: import("better-sqlite3").Database,
  input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId: string
    messageId: string
    fileName: string
    uri: string
    sizeBytes: number
    now: string
  },
): void => {
  sqlite
    .prepare(
      `INSERT INTO message_attachments (
         id, project_id, conversation_id, session_id, turn_id, message_id,
         artifact_id, kind, file_name, mime_type, size_bytes, uri, status, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 'image', ?, 'image/png', ?, ?, 'attached', ?, ?)`,
    )
    .run(
      createId("att"),
      input.projectId,
      input.conversationId,
      input.sessionId,
      input.turnId,
      input.messageId,
      createId("art"),
      input.fileName,
      input.sizeBytes,
      input.uri,
      input.now,
      input.now,
    )
}

function parseArgs(argv: string[]): Args {
  const out: Args = { live: false, fixture: false, model: "openrouter/xiaomi/mimo-v2.5-pro", thinking: "off" }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--live") out.live = true
    else if (arg === "--fixture") out.fixture = true
    else if (arg === "--model") out.model = argv[++index] ?? out.model
    else if (arg === "--thinking") out.thinking = (argv[++index] as Args["thinking"]) ?? out.thinking
    else if (arg === "--db") out.dbPath = argv[++index]
    else if (arg === "--help") {
      console.log("Usage: pnpm trace:e2e --live --fixture --model openrouter/xiaomi/mimo-v2.5-pro --thinking off")
      process.exit(0)
    }
  }
  return out
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
