import type { Connection, Table } from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from "apache-arrow";
import type { DocumentKind } from "./documents";

/** One stored vector with its pointer back to the ledger. */
export interface IndexRow {
  id: string;
  kind: DocumentKind;
  source_id: string;
  goal_id: string | null;
  task_id: string | null;
  turn_id: string | null;
  project_turn: number | null;
  at: string;
  hash: string;
  vector: number[];
}

export interface IndexFilter {
  kinds: DocumentKind[];
  goalIds?: string[];
  taskIds?: string[];
  excludeTaskIds?: string[];
  throughTurn?: number;
  fromIso?: string;
  beforeIso?: string;
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const list = (values: string[]) => `(${values.map(quote).join(", ")})`;

/** A SQL predicate for LanceDB's prefiltered vector search. */
export function wherePredicate(f: IndexFilter): string {
  const parts = [`kind IN ${list(f.kinds)}`];
  if (f.goalIds) parts.push(f.goalIds.length ? `goal_id IN ${list(f.goalIds)}` : "false");
  if (f.taskIds) parts.push(f.taskIds.length ? `task_id IN ${list(f.taskIds)}` : "false");
  if (f.excludeTaskIds?.length) parts.push(`(task_id IS NULL OR task_id NOT IN ${list(f.excludeTaskIds)})`);
  if (f.throughTurn !== undefined) parts.push(`project_turn <= ${Math.floor(f.throughTurn)}`);
  if (f.fromIso) parts.push(`at >= ${quote(f.fromIso)}`);
  if (f.beforeIso) parts.push(`at < ${quote(f.beforeIso)}`);
  return parts.join(" AND ");
}

/**
 * The LanceDB vector index: one table of documents per embedding model, so
 * vectors from different models never mix, and one small state table holding
 * the event watermark of the last completed sync. Cosine distance.
 */
export class VectorIndex {
  private table: Table | null = null;

  private constructor(
    private readonly db: Connection,
    private readonly name: string,
    private readonly state: Table,
  ) {}

  static async open(uri: string, embedderId: string): Promise<VectorIndex> {
    const lancedb = await import("@lancedb/lancedb");
    const db = await lancedb.connect(uri);
    const slug = embedderId.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase();
    const names = await db.tableNames();
    const stateName = `state_${slug}`;
    const state = names.includes(stateName)
      ? await db.openTable(stateName)
      : await db.createEmptyTable(stateName, new Schema([new Field("key", new Utf8(), false), new Field("value", new Utf8(), false)]));
    const index = new VectorIndex(db, `documents_${slug}`, state);
    if (names.includes(index.name)) index.table = await db.openTable(index.name);
    return index;
  }

  /** The event sequence the index reflects, or null before the first complete sync. */
  async watermark(): Promise<number | null> {
    const rows = await this.state.query().where("key = 'seq'").toArray();
    return rows.length ? Number(rows[0].value) : null;
  }

  async setWatermark(seq: number): Promise<void> {
    await this.state.mergeInsert("key").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute([{ key: "seq", value: String(seq) }]);
  }

  /** Stored content hashes of the given document ids. */
  async hashes(ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.table) return out;
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await this.table.query().where(`id IN ${list(ids.slice(i, i + 200))}`).select(["id", "hash"]).toArray();
      for (const r of rows) out.set(String(r.id), String(r.hash));
    }
    return out;
  }

  /** Ids of every stored document of one kind. */
  async ids(kind: DocumentKind): Promise<string[]> {
    if (!this.table) return [];
    return (await this.table.query().where(`kind = ${quote(kind)}`).select(["id"]).toArray()).map((r) => String(r.id));
  }

  async upsert(rows: IndexRow[]): Promise<void> {
    if (!rows.length) return;
    if (!this.table) {
      const dims = rows[0]!.vector.length;
      const schema = new Schema([
        new Field("id", new Utf8(), false),
        new Field("kind", new Utf8(), false),
        new Field("source_id", new Utf8(), false),
        new Field("goal_id", new Utf8(), true),
        new Field("task_id", new Utf8(), true),
        new Field("turn_id", new Utf8(), true),
        new Field("project_turn", new Int32(), true),
        new Field("at", new Utf8(), false),
        new Field("hash", new Utf8(), false),
        new Field("vector", new FixedSizeList(dims, new Field("item", new Float32(), true)), false),
      ]);
      this.table = await this.db.createEmptyTable(this.name, schema, { existOk: true });
    }
    await this.table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows as unknown as Record<string, unknown>[]);
  }

  async delete(ids: string[]): Promise<void> {
    if (!this.table || !ids.length) return;
    for (let i = 0; i < ids.length; i += 200) await this.table.delete(`id IN ${list(ids.slice(i, i + 200))}`);
  }

  async count(): Promise<number> {
    return this.table ? this.table.countRows() : 0;
  }

  /** The nearest stored documents matching the filter, with cosine similarity. */
  async search(vector: number[], filter: IndexFilter, limit: number): Promise<(Omit<IndexRow, "vector"> & { similarity: number })[]> {
    if (!this.table) return [];
    const rows = await this.table.vectorSearch(vector).distanceType("cosine").where(wherePredicate(filter)).select(["id", "kind", "source_id", "goal_id", "task_id", "turn_id", "project_turn", "at", "hash"]).limit(limit).toArray();
    return rows.map((r) => ({
      id: String(r.id),
      kind: r.kind as DocumentKind,
      source_id: String(r.source_id),
      goal_id: r.goal_id ?? null,
      task_id: r.task_id ?? null,
      turn_id: r.turn_id ?? null,
      project_turn: r.project_turn ?? null,
      at: String(r.at),
      hash: String(r.hash),
      similarity: 1 - Number(r._distance),
    }));
  }

  close(): void {
    this.table?.close();
    this.state.close();
    this.db.close();
  }
}
