import type {
  BashToolOutput,
  EditToolOutput,
  ListProjectResourcesToolOutput,
  ReadToolOutput,
  RuntimeConfig,
  SearchToolOutput,
  TraceRetrieveToolInput,
  TraceRetrieveToolOutput,
} from "@socrates/contracts"
import { SocratesAgent, type ApprovalRequest, type SocratesAgentEvent, type ToolExecutors } from "@socrates/core"
import { AiSdkProvider, type ModelMessage, type ModelUsage } from "@socrates/providers"
import { createId } from "@socrates/shared"
import { openDatabase, runMigrations } from "../db/client"
import { getServerConfig } from "../config"
import { SocratesStore } from "../services/store"

type ProjectRow = {
  id: string
  name: string
}

type SmokePair = {
  user: string
  assistant: string
}

type TraceCall = {
  input: TraceRetrieveToolInput
  output?: TraceRetrieveToolOutput
}

const EXPECTED_PHRASE = "preserve the user's original vivid wording instead of polishing it"
const SOURCE_CONVERSATION_PREFIX = "Live Semantic Trace Source"
const LIVE_CONVERSATION_PREFIX = "Live Semantic Trace Agent"
const MODEL_ID = "deepseek/deepseek-v4-pro"
const EMBEDDING_MODEL_ID = "text-embedding-3-small"

const runtimeConfig: RuntimeConfig = {
  providerId: "openrouter",
  modelId: MODEL_ID,
  thinkingEnabled: true,
  approvalMode: "manual",
  sandboxMode: "read_only",
}

const main = async () => {
  const config = getServerConfig()
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required for this live smoke.")
  }

  const handle = openDatabase(config.dbPath)
  runMigrations(handle)
  const store = new SocratesStore(handle)

  try {
    const project = selectLatestActiveProject(handle.sqlite)
    if (!project) {
      throw new Error("No active project found in the local DB.")
    }
    const workspacePath = store.getPrimaryWorkspacePath(project.id)
    const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
    console.log(`[smoke] project=${project.name} (${project.id})`)
    console.log(`[smoke] workspace=${workspacePath}`)
    cleanupPreviousSmokeRuns(store, handle.sqlite, project.id)

    const embeddingCredential = await resolveOpenAiCredential(store, project.id)
    const sourceConversation = store.createConversation(project.id, { title: `${SOURCE_CONVERSATION_PREFIX} ${stamp}` })
    const sourcePairs = buildSourcePairs(stamp)
    console.log(`[smoke] sourceConversation=${sourceConversation.id}`)
    for (const pair of sourcePairs) {
      const seeded = seedCompletedTurn(store, project.id, sourceConversation.id, pair.user, pair.assistant)
      store.indexTurnTraceDocuments(project.id, sourceConversation.id, seeded.turnId)
    }
    console.log(`[smoke] seededTurns=${sourcePairs.length}`)

    console.log(`[smoke] configuring embeddings provider=openai model=${EMBEDDING_MODEL_ID}`)
    await store.configureProjectEmbeddings(project.id, {
      providerId: "openai",
      modelId: EMBEDDING_MODEL_ID,
      credentialSource: embeddingCredential.credentialSource,
      ...(embeddingCredential.workspaceEnvFile ? { workspaceEnvFile: embeddingCredential.workspaceEnvFile } : {}),
    })
    await waitForEmbeddings(store, project.id)

    const liveConversation = store.createConversation(project.id, { title: `${LIVE_CONVERSATION_PREFIX} ${stamp}` })
    const liveQuestion =
      "In an earlier conversation in this project, I gave a writing-direction rule about handling metaphorical or unusually phrased student material. I do not remember the exact words. What was that rule? Use semantic trace retrieval if needed, then inspect exact evidence before answering."
    const liveTurn = store.createTurnFromUserMessage(project.id, liveConversation.id, {
      clientMessageId: createId("msg"),
      content: liveQuestion,
      runtimeConfig,
    })
    const traceCalls: TraceCall[] = []
    const modelCallIds: string[] = []
    const usageByModelCallId = new Map<string, ModelUsage>()
    let latestModelCallId: string | undefined
    let answerText = ""
    let reasoningText = ""
    let providerFailure: Error | undefined

    console.log(`[smoke] liveConversation=${liveConversation.id}`)
    console.log(`[smoke] model=openrouter/${MODEL_ID} thinking=on`)
    console.log("[smoke] streaming agent events...")

    const agent = new SocratesAgent(new AiSdkProvider())
    for await (const event of agent.streamTurn({
      projectId: project.id,
      conversationId: liveConversation.id,
      sessionId: liveTurn.sessionId,
      turnId: liveTurn.turnId,
      providerId: "openrouter",
      modelId: MODEL_ID,
      runtimeConfig,
      messages: buildVisibleHistory(sourcePairs, liveQuestion),
      promptContext: store.getAgentContext(project.id),
      workspacePath,
      toolExecutors: createSmokeToolExecutors(store, project.id, traceCalls),
      maxToolCallsPerTurn: 8,
      maxParallelToolCalls: 2,
      createModelCall: (modelRequest) => {
        const modelCallId = store.createModelCall({
          conversationId: liveConversation.id,
          sessionId: liveTurn.sessionId,
          turnId: liveTurn.turnId,
          runtimeConfigId: liveTurn.runtimeConfigId,
          providerId: modelRequest.providerId,
          modelId: modelRequest.modelId,
          request: {
            providerId: modelRequest.providerId,
            modelId: modelRequest.modelId,
            runtimeConfig: modelRequest.runtimeConfig,
            messages: modelRequest.messages,
            promptContext: modelRequest.promptContext,
            tools: modelRequest.tools.map((tool) => tool.name),
          },
        })
        modelCallIds.push(modelCallId)
        latestModelCallId = modelCallId
        return modelCallId
      },
      requestApproval: rejectApprovals,
    })) {
      const currentModelCallId = "modelCallId" in event ? event.modelCallId ?? latestModelCallId : latestModelCallId
      persistAndPrintEvent(store, event, liveConversation.id, liveTurn.sessionId, liveTurn.turnId, currentModelCallId)
      if (event.type === "model.reasoning.delta") {
        reasoningText += event.text
      }
      if (event.type === "model.answer.delta") {
        answerText += event.text
      }
      if (event.type === "model.usage" && currentModelCallId) {
        usageByModelCallId.set(currentModelCallId, event.usage)
      }
      if (event.type === "model.failed") {
        providerFailure = event.error
      }
    }

    if (providerFailure) {
      store.failTurn({
        conversationId: liveConversation.id,
        sessionId: liveTurn.sessionId,
        turnId: liveTurn.turnId,
        code: "live_smoke_provider_failed",
        message: providerFailure.message,
      })
      throw providerFailure
    }

    const assistantMessage = store.completeAgentTurn({
      conversationId: liveConversation.id,
      sessionId: liveTurn.sessionId,
      turnId: liveTurn.turnId,
      content: answerText,
      reasoning: reasoningText,
    })
    for (const modelCallId of modelCallIds) {
      const usage = usageByModelCallId.get(modelCallId)
      store.completeModelCall({
        modelCallId,
        response: { messageId: assistantMessage.id, finish: "completed" },
        ...(usage ? { usage } : {}),
      })
    }
    store.indexTurnTraceDocuments(project.id, liveConversation.id, liveTurn.turnId)
    await waitForEmbeddings(store, project.id)

    const result = evaluateSmoke(answerText, traceCalls)
    console.log("\n[smoke] final answer:")
    console.log(answerText.trim())
    console.log("\n[smoke] result:")
    console.log(JSON.stringify(result, null, 2))
    if (!result.pass) {
      throw new Error(`Live semantic trace smoke failed: ${result.reasons.join("; ")}`)
    }
  } finally {
    store.close()
  }
}

const selectLatestActiveProject = (sqlite: ReturnType<typeof openDatabase>["sqlite"]): ProjectRow | undefined =>
  sqlite
    .prepare(
      `SELECT id, name
       FROM projects
       WHERE status = 'active'
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get() as ProjectRow | undefined

const cleanupPreviousSmokeRuns = (store: SocratesStore, sqlite: ReturnType<typeof openDatabase>["sqlite"], projectId: string) => {
  const conversations = sqlite
    .prepare(
      `SELECT id
       FROM conversations
       WHERE project_id = ?
         AND (title LIKE ? OR title LIKE ?)`,
    )
    .all(projectId, `${SOURCE_CONVERSATION_PREFIX}%`, `${LIVE_CONVERSATION_PREFIX}%`) as Array<{ id: string }>
  const conversationIds = conversations.map((conversation) => conversation.id)
  const traceDocumentSql = `SELECT id
    FROM trace_documents
    WHERE project_id = ?
      AND (
        content LIKE '%Smoke marker %'
        OR content LIKE '%Use semantic trace retrieval if needed%'
        ${conversationIds.length > 0 ? `OR conversation_id IN (${conversationIds.map(() => "?").join(", ")})` : ""}
      )`
  const traceDocumentArgs = conversationIds.length > 0 ? [projectId, ...conversationIds] : [projectId]
  const traceDocumentRows = sqlite.prepare(traceDocumentSql).all(...traceDocumentArgs) as Array<{ id: string }>
  const traceDocumentIds = traceDocumentRows.map((row) => row.id)

  if (traceDocumentIds.length > 0) {
    const placeholders = traceDocumentIds.map(() => "?").join(", ")
    sqlite.prepare(`DELETE FROM trace_embeddings WHERE trace_document_id IN (${placeholders})`).run(...traceDocumentIds)
    sqlite.prepare(`DELETE FROM trace_documents_fts WHERE trace_document_id IN (${placeholders})`).run(...traceDocumentIds)
    sqlite.prepare(`DELETE FROM trace_documents WHERE id IN (${placeholders})`).run(...traceDocumentIds)
  }
  if (conversationIds.length > 0) {
    const placeholders = conversationIds.map(() => "?").join(", ")
    sqlite.prepare(`DELETE FROM trace_index_jobs WHERE conversation_id IN (${placeholders})`).run(...conversationIds)
    for (const conversationId of conversationIds) {
      store.deleteConversation(projectId, conversationId)
    }
  }
  if (conversationIds.length > 0 || traceDocumentIds.length > 0) {
    console.log(`[smoke] cleanedPreviousRuns conversations=${conversationIds.length} traceDocuments=${traceDocumentIds.length}`)
  }
}

const resolveOpenAiCredential = async (
  store: SocratesStore,
  projectId: string,
): Promise<{ credentialSource: "server_env" | "workspace_env"; workspaceEnvFile?: string }> => {
  const check = await store.checkProjectEmbeddings(projectId, { providerId: "openai", modelId: EMBEDDING_MODEL_ID })
  if (check.serverEnvAvailable) {
    console.log("[smoke] OpenAI key source=server_env")
    return { credentialSource: "server_env" }
  }
  const workspaceEnvFile = check.workspaceEnvCandidates?.find((candidate) => candidate.hasOpenAiApiKey)?.fileName
  if (workspaceEnvFile) {
    console.log(`[smoke] OpenAI key source=workspace_env file=${workspaceEnvFile}`)
    return { credentialSource: "workspace_env", workspaceEnvFile }
  }
  throw new Error("OPENAI_API_KEY is required in server env or the project workspace .env* files.")
}

const seedCompletedTurn = (
  store: SocratesStore,
  projectId: string,
  conversationId: string,
  user: string,
  assistant: string,
): { turnId: string } => {
  const created = store.createTurnFromUserMessage(projectId, conversationId, {
    clientMessageId: createId("msg"),
    content: user,
    runtimeConfig,
  })
  store.completeAgentTurn({
    conversationId,
    sessionId: created.sessionId,
    turnId: created.turnId,
    content: assistant,
  })
  return { turnId: created.turnId }
}

const buildSourcePairs = (stamp: string): SmokePair[] => {
  const fillerTopics = [
    "opening thesis checks",
    "citation order",
    "counterexample handling",
    "transition phrasing",
    "rubric alignment",
    "evidence grouping",
    "paragraph endings",
    "short-answer scoring",
    "diagram references",
    "unclear definitions",
    "revision sequencing",
    "peer-review notes",
    "scope boundaries",
    "final checklist",
    "tone control",
    "submission cleanup",
  ]
  return fillerTopics.map((topic, index) => {
    if (index === 1) {
      return {
        user:
          `Smoke marker ${stamp}. For critique-question drafting, when a learner gives a vivid metaphor or an odd personal phrase, preserve the user's original vivid wording instead of polishing it. Keep the rest of the question clear, but that distinctive phrase must stay intact.`,
        assistant:
          "Understood. I will keep distinctive learner wording intact when drafting critique questions and only clarify the surrounding structure.",
      }
    }
    return {
      user:
        `Smoke marker ${stamp}. Please help with ${topic}: make the guidance concise, practical, and suitable for a Socratic writing assistant.`,
      assistant:
        `For ${topic}, I would keep the note brief, tie it to the student's stated goal, and ask one concrete follow-up before rewriting anything.`,
    }
  })
}

const buildVisibleHistory = (sourcePairs: SmokePair[], liveQuestion: string): ModelMessage[] => {
  const recentPairs = sourcePairs.slice(-3)
  const messages: ModelMessage[] = []
  for (const pair of recentPairs) {
    messages.push({ role: "user", content: pair.user })
    messages.push({ role: "assistant", content: pair.assistant })
  }
  messages.push({ role: "user", content: liveQuestion })
  return messages
}

const createSmokeToolExecutors = (store: SocratesStore, projectId: string, traceCalls: TraceCall[]): ToolExecutors => ({
  read: async (input): Promise<ReadToolOutput> => ({
    path: input.path,
    kind: "missing",
    truncation: { truncated: false, charLimit: input.charLimit ?? 20_000, returnedLength: 0 },
    warnings: ["Live semantic smoke only exercises trace_retrieve; read was not executed."],
  }),
  search: async (input): Promise<SearchToolOutput> => ({
    mode: input.mode,
    query: input.query,
    matches: [],
    totalMatches: 0,
    truncation: { truncated: false, charLimit: input.charLimit ?? 20_000, returnedLength: 0 },
    warnings: ["Live semantic smoke only exercises trace_retrieve; search was not executed."],
  }),
  edit: async (): Promise<EditToolOutput> => ({
    changedFiles: [],
    diff: "",
    dryRun: true,
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
    warnings: ["Live semantic smoke is read-only; edit was not executed."],
  }),
  bash: async (input, context): Promise<BashToolOutput> => ({
    command: input.command,
    cwd: input.cwd ?? context.workspacePath,
    exitCode: 1,
    stdout: "",
    stderr: "Live semantic smoke is read-only; bash was not executed.",
    durationMs: 0,
    timedOut: false,
    truncation: { truncated: false, charLimit: input.charLimit ?? 20_000, returnedLength: 0 },
  }),
  trace_retrieve: async (input, context): Promise<TraceRetrieveToolOutput> => {
    const callNumber = traceCalls.length + 1
    console.log(`\n[trace_retrieve #${callNumber}] input`)
    console.log(JSON.stringify(input, null, 2))
    const output = await store.retrieveToolTraces(projectId, context.conversationId, input)
    traceCalls.push({ input, output })
    console.log(`[trace_retrieve #${callNumber}] output`)
    console.log(JSON.stringify(summarizeTraceOutput(output), null, 2))
    return output
  },
  list_project_resources: async (): Promise<ListProjectResourcesToolOutput> => ({
    resources: [],
    summary: "Live semantic smoke did not list resources.",
    totalResources: 0,
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
  }),
})

const rejectApprovals = async (request: ApprovalRequest) => {
  console.log(`[approval] rejected ${request.toolName}: ${request.title}`)
  return { decision: "rejected" as const, reason: "Live semantic smoke is read-only." }
}

const persistAndPrintEvent = (
  store: SocratesStore,
  event: SocratesAgentEvent,
  conversationId: string,
  sessionId: string,
  turnId: string,
  modelCallId: string | undefined,
) => {
  if (event.type === "model.started") {
    console.log(`[model] started ${event.modelCallId ?? ""}`)
  }
  if (event.type === "model.reasoning.delta") {
    process.stdout.write(event.text)
    if (modelCallId) {
      store.appendModelStreamChunk({ modelCallId, turnId, channel: "reasoning", text: event.text })
    }
  }
  if (event.type === "model.answer.delta") {
    process.stdout.write(event.text)
    if (modelCallId) {
      store.appendModelStreamChunk({ modelCallId, turnId, channel: "answer", text: event.text })
    }
  }
  if (event.type === "model.tool_call.completed") {
    console.log(`\n[model] tool_call ${event.toolCall.toolName}`)
  }
  if (event.type === "tool.call.started") {
    console.log(`[tool] started ${event.toolName} ${event.toolCallId}`)
    store.createToolCall({
      toolCallId: event.toolCallId,
      conversationId,
      sessionId,
      turnId,
      ...(modelCallId ? { modelCallId } : {}),
      toolName: event.toolName,
      arguments: event.input,
      requiresApproval: event.requiresApproval,
    })
  }
  if (event.type === "tool.call.completed") {
    console.log(`[tool] completed ${event.toolName} ${event.summary}`)
    store.completeToolCall(event.toolCallId, event.output)
  }
  if (event.type === "tool.call.failed") {
    console.log(`[tool] failed ${event.toolName}: ${event.error.message}`)
    store.failToolCall(event.toolCallId)
  }
  if (event.type === "model.completed") {
    console.log(`\n[model] completed finishReason=${event.finishReason ?? "unknown"}`)
  }
  if (event.type === "model.failed") {
    console.log(`\n[model] failed ${event.error.message}`)
  }
}

const waitForEmbeddings = async (store: SocratesStore, projectId: string) => {
  const startedAt = Date.now()
  let lastLog = 0
  while (Date.now() - startedAt < 120_000) {
    const status = store.getProjectEmbeddingStatus(projectId)
    if (Date.now() - lastLog > 2_000) {
      lastLog = Date.now()
      console.log(
        `[embeddings] indexed=${status.indexedDocuments} pending=${status.pendingDocuments} failed=${status.failedDocuments} total=${status.totalDocuments} job=${status.activeJob?.status ?? "none"}`,
      )
    }
    if (status.ready && status.pendingDocuments === 0 && status.indexedDocuments > 0) {
      return status
    }
    await sleep(500)
  }
  throw new Error("Timed out waiting for trace embeddings to finish indexing.")
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const summarizeTraceOutput = (output: TraceRetrieveToolOutput) => ({
  totalMatches: output.totalMatches,
  warnings: output.warnings,
  appliedFilters: output.appliedFilters,
  results: output.results.slice(0, 4).map((result) => ({
    handle: result.handle,
    kind: result.kind,
    title: result.title,
    conversation: result.conversation,
    turnNo: result.turnNo,
    messageRole: result.messageRole,
    score: "score" in result ? result.score : undefined,
    inspectArgs: "inspectArgs" in result ? result.inspectArgs : undefined,
    preview: "content" in result ? result.content.slice(0, 280) : result.snippet ?? result.summary,
  })),
})

const evaluateSmoke = (answerText: string, traceCalls: TraceCall[]) => {
  const normalizedAnswer = answerText.toLowerCase()
  const reasons: string[] = []
  const traceCallCount = traceCalls.length
  const searchCalls = traceCalls.filter(
    (call): call is TraceCall & { input: Extract<TraceRetrieveToolInput, { query: string }> } =>
      call.input.operation !== "inspect",
  )
  const inspectCalls = traceCalls.filter((call) => call.input.operation === "inspect")
  const inspectedEarlierConversation = inspectCalls.some((call) =>
    call.output?.results.some((result) => result.conversation?.isCurrentConversation === false),
  )
  const semanticSearchUsed = searchCalls.some((call) => call.input.mode === "semantic" || call.input.mode === "combined")
  const exactMeaningPresent =
    normalizedAnswer.includes("preserve") &&
    normalizedAnswer.includes("original") &&
    normalizedAnswer.includes("wording") &&
    (normalizedAnswer.includes("polish") || normalizedAnswer.includes("polishing"))

  if (!exactMeaningPresent) {
    reasons.push(`final answer did not contain the expected meaning: ${EXPECTED_PHRASE}`)
  }
  if (!semanticSearchUsed) {
    reasons.push("no semantic or combined trace search was used")
  }
  if (inspectCalls.length === 0) {
    reasons.push("the model did not inspect exact trace evidence")
  }
  if (traceCallCount >= 4) {
    reasons.push(`trace_retrieve call count was ${traceCallCount}, expected less than 4`)
  }
  if (inspectedEarlierConversation && normalizedAnswer.includes("this conversation")) {
    reasons.push(`final answer described earlier project evidence as "this conversation"`)
  }

  return {
    pass: reasons.length === 0,
    reasons,
    traceCallCount,
    searchCallCount: searchCalls.length,
    inspectCallCount: inspectCalls.length,
    firstTraceInput: traceCalls[0]?.input,
  }
}

void main().catch((error: unknown) => {
  console.error("\n[smoke] failed")
  console.error(error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
