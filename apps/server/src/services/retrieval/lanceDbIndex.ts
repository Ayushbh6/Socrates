import fs from "node:fs"
import type { Connection, Table } from "@lancedb/lancedb"
import { Index, connect, rerankers } from "@lancedb/lancedb"
import { normalizeScores, rankDistinctParents, sha256Hex } from "@socrates/core"
import { createId } from "@socrates/shared"
import type { RankedRetrievalParent, RetrievalCandidate } from "@socrates/core"
import type { LanceSearchRow, RetrievalIndexRow, RetrievalSearchFilters, RetrievalSearchMode } from "./types"

const INTERNAL_CANDIDATE_LIMIT = 64

export class LanceDbIndex {
  private connectionPromise: Promise<Connection> | undefined

  constructor(private readonly databasePath: string) {}

  async replaceProject(input: {
    projectId: string
    rows: RetrievalIndexRow[]
    previousTableName?: string
  }): Promise<{ tableName?: string }> {
    const db = await this.connection()
    if (input.rows.length === 0) {
      if (input.previousTableName) await this.dropTableIfExists(input.previousTableName)
      return {}
    }
    const tableName = `project_${sha256Hex(input.projectId).slice(0, 16)}_${createId("retjob").replace(/[^a-zA-Z0-9_]/g, "_")}`
    const table = await db.createTable(tableName, input.rows)
    await table.createIndex("content", { config: Index.fts({ withPosition: true }) })
    if (input.previousTableName && input.previousTableName !== tableName) {
      await this.dropTableIfExists(input.previousTableName)
    }
    return { tableName }
  }

  async upsertParents(tableName: string, parentIds: string[], rows: RetrievalIndexRow[]): Promise<void> {
    const table = await (await this.connection()).openTable(tableName)
    if (parentIds.length > 0) {
      await table.delete(`\`parentId\` IN (${parentIds.map(sqlString).join(", ")})`)
    }
    if (rows.length > 0) {
      await table.add(rows)
    }
    await table.createIndex("content", { config: Index.fts({ withPosition: true }), replace: true })
  }

  async deleteConversation(tableName: string, conversationId: string): Promise<void> {
    const table = await (await this.connection()).openTable(tableName)
    await table.delete(`\`conversationId\` = ${sqlString(conversationId)}`)
    await table.createIndex("content", { config: Index.fts({ withPosition: true }), replace: true })
  }

  async deleteFlow(tableName: string, flowId: string): Promise<void> {
    const table = await (await this.connection()).openTable(tableName)
    await table.delete(`\`runtimeKind\` = 'v2_flow' AND \`flowId\` = ${sqlString(flowId)}`)
    await table.createIndex("content", { config: Index.fts({ withPosition: true }), replace: true })
  }

  async dropTableIfExists(tableName: string): Promise<void> {
    const db = await this.connection()
    if ((await db.tableNames()).includes(tableName)) {
      await db.dropTable(tableName)
    }
  }

  async counts(tableName: string): Promise<{ traceChunks: number; memoryChunks: number }> {
    const table = await (await this.connection()).openTable(tableName)
    const [traceChunks, memoryChunks] = await Promise.all([
      table.countRows("`corpusKind` = 'trace_turn'"),
      table.countRows("`corpusKind` = 'memory_section'"),
    ])
    return { traceChunks, memoryChunks }
  }

  async search(input: {
    tableName: string
    query: string
    queryVector?: number[]
    mode: RetrievalSearchMode
    filters: RetrievalSearchFilters & { conversationIds?: string[] }
    limit?: number
  }): Promise<RankedRetrievalParent<RetrievalIndexRow>[]> {
    const table = await (await this.connection()).openTable(input.tableName)
    const filter = filterSql(input.filters)
    let rows: LanceSearchRow[]
    if (input.mode === "lexical") {
      rows = (await withFilter(table.search(literalFtsQuery(input.query), "fts", "content"), filter).limit(INTERNAL_CANDIDATE_LIMIT).toArray()) as LanceSearchRow[]
    } else if (input.mode === "semantic") {
      if (!input.queryVector) throw new Error("Semantic search requires a query vector.")
      rows = (await withFilter(table.vectorSearch(input.queryVector).distanceType("cosine").bypassVectorIndex(), filter)
        .limit(INTERNAL_CANDIDATE_LIMIT)
        .toArray()) as LanceSearchRow[]
    } else {
      if (!input.queryVector) throw new Error("Combined search requires a query vector.")
      const reranker = await rerankers.RRFReranker.create()
      rows = (await withFilter(
        table
          .query()
          .nearestTo(input.queryVector)
          .distanceType("cosine")
          .bypassVectorIndex()
          .fullTextSearch(input.query, { columns: ["content"] })
          .rerank(reranker),
        filter,
      )
        .limit(INTERNAL_CANDIDATE_LIMIT)
        .toArray()) as LanceSearchRow[]
    }

    const rawScores = rows.map((row) => rawScore(row, input.mode))
    const normalized = normalizeScores(rawScores, input.mode === "semantic" ? "lower" : "higher")
    const candidates: RetrievalCandidate<RetrievalIndexRow>[] = rows.map((row, index) => ({
      chunkId: row.id,
      parentId: row.parentId,
      content: row.content,
      rawScore: rawScores[index] ?? 0,
      normalizedScore: (normalized[index] ?? 0) * (row.priority || 1),
      occurredAt: row.occurredAt,
      metadata: stripScoreColumns(row),
    }))
    return rankDistinctParents(candidates, input.limit === undefined ? {} : { limit: input.limit })
  }

  async cachedVectors(input: {
    configFingerprint: string
    contentHashes: string[]
  }): Promise<Map<string, number[]>> {
    const db = await this.connection()
    const tableName = cacheTableName(input.configFingerprint)
    if (!(await db.tableNames()).includes(tableName) || input.contentHashes.length === 0) return new Map()
    const table = await db.openTable(tableName)
    const rows = (await table
      .query()
      .where(`\`contentHash\` IN (${input.contentHashes.map(sqlString).join(", ")})`)
      .toArray()) as Array<{ contentHash: string; vector: number[] }>
    return new Map(rows.map((row) => [row.contentHash, Array.from(row.vector)]))
  }

  async storeCachedVectors(input: {
    configFingerprint: string
    rows: Array<{ contentHash: string; vector: number[] }>
  }): Promise<void> {
    if (input.rows.length === 0) return
    const db = await this.connection()
    const tableName = cacheTableName(input.configFingerprint)
    if (!(await db.tableNames()).includes(tableName)) {
      await db.createTable(tableName, input.rows)
      return
    }
    const table = await db.openTable(tableName)
    const hashes = input.rows.map((row) => row.contentHash)
    await table.delete(`\`contentHash\` IN (${hashes.map(sqlString).join(", ")})`)
    await table.add(input.rows)
  }

  async close(): Promise<void> {
    const pending = this.connectionPromise
    this.connectionPromise = undefined
    if (!pending) return
    try {
      const connection = await pending
      connection.close()
    } catch {
      // A failed connection has no native resources left to release.
    }
  }

  private connection(): Promise<Connection> {
    if (!this.connectionPromise) {
      fs.mkdirSync(this.databasePath, { recursive: true })
      this.connectionPromise = connect(this.databasePath)
    }
    return this.connectionPromise
  }
}

const cacheTableName = (fingerprint: string): string => `embedding_cache_${sha256Hex(fingerprint).slice(0, 20)}`

const filterSql = (filters: RetrievalSearchFilters & { conversationIds?: string[] }): string => {
  const clauses = [`\`corpusKind\` = ${sqlString(filters.corpusKind)}`]
  if (filters.runtimeKind) clauses.push(`\`runtimeKind\` = ${sqlString(filters.runtimeKind)}`)
  if (filters.flowId) clauses.push(`\`flowId\` = ${sqlString(filters.flowId)}`)
  if (filters.conversationId) clauses.push(`\`conversationId\` = ${sqlString(filters.conversationId)}`)
  if (filters.conversationIds?.length) clauses.push(`\`conversationId\` IN (${filters.conversationIds.map(sqlString).join(", ")})`)
  if (filters.conversationTitle) clauses.push(`\`conversationTitle\` = ${sqlString(filters.conversationTitle)}`)
  if (filters.role && filters.role !== "any") clauses.push(`\`matchedRole\` = ${sqlString(filters.role)}`)
  if (filters.createdAfter) clauses.push(`\`occurredAt\` >= ${sqlString(filters.createdAfter)}`)
  if (filters.createdBefore) clauses.push(`\`occurredAt\` <= ${sqlString(filters.createdBefore)}`)
  if (filters.scope === "global") clauses.push(`scope = 'global'`)
  if (filters.scope === "project" && filters.corpusKind === "memory_section") clauses.push(`scope = 'project'`)
  return clauses.join(" AND ")
}

const withFilter = <T extends { where(predicate: string): T }>(query: T, filter: string): T => (filter ? query.where(filter) : query)

const rawScore = (row: LanceSearchRow, mode: RetrievalSearchMode): number => {
  if (mode === "semantic") return row._distance ?? Number.POSITIVE_INFINITY
  if (mode === "combined") return row._relevance_score ?? row._score ?? 0
  return row._score ?? 0
}

const stripScoreColumns = (row: LanceSearchRow): RetrievalIndexRow => {
  const { _distance: _distance, _score: _score, _relevance_score: _relevanceScore, ...metadata } = row
  return metadata
}

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`

const literalFtsQuery = (value: string): string => `"${value.trim().replaceAll('"', '\\"')}"`
