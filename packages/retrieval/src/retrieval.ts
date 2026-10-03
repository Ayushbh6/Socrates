import { lstat } from "node:fs/promises";
import path from "node:path";
import type { EmbeddingClient } from "@socrates/contracts";
import { abortable } from "@socrates/shared";
import type { LedgerStore } from "@socrates/store";
import { type DocumentKind, type SourceDocument, capabilityDocument, changedDocuments, contentHash } from "./documents";
import { fileDocuments, readIndexable, workspaceFiles } from "./files";
import { type IndexFilter, VectorIndex } from "./vector-index";

/**
 * Similarity floors for embeddinggemma, measured on Socrates-shaped text.
 * Unrelated pairs mostly scored 0.05–0.17; a terse request such as "let's
 * start today's lesson" scored 0.22 against its goal (the others 0.05–0.10).
 * - related: a meaning match may join a fused ranking, where keywords and the
 *   router still decide;
 * - suggest: a capability may be suggested on meaning alone (correct Skills
 *   and tools scored 0.35–0.51, wrong ones at most 0.29);
 * - strong: another task's exchange may be added to the context (a clear
 *   paraphrase scored 0.61, a loose one 0.40, an unrelated message 0.17).
 * Other models may need their own values.
 */
export const DEFAULT_THRESHOLDS = { related: 0.2, suggest: 0.35, strong: 0.45 } as const;
export type Thresholds = Record<keyof typeof DEFAULT_THRESHOLDS, number>;
/** A query that cannot be embedded within this time falls back to keyword search. */
export const QUERY_TIMEOUT_MS = 3_000;
/** After an embedding failure, meaning search is skipped for this long. */
export const RETRY_AFTER_MS = 30_000;
const QUERY_CACHE_SIZE = 64;
/** Workspace sections embedded per sync pass, so a large first index never delays the ledger's for long. */
export const FILE_EMBEDS_PER_PASS = 256;
/** Files read before their sections are written together. */
const FILE_FLUSH_DOCS = 64;

export interface SemanticHit {
  kind: DocumentKind;
  sourceId: string;
  goalId: string | null;
  taskId: string | null;
  turnId: string | null;
  projectTurn: number | null;
  /** A file section's workspace, path, and content hash. */
  workspaceId?: string | null;
  path?: string | null;
  hash?: string;
  at: string;
  /** Cosine similarity of the best matching chunk. */
  similarity: number;
}

export interface SemanticQuery extends IndexFilter {
  limit: number;
  /** The similarity floor; "related" by default. */
  min?: keyof typeof DEFAULT_THRESHOLDS;
}

/**
 * Meaning-based search over the ledger, as the router, context_retrieve,
 * context assembly, and capability candidates consume it. It never throws:
 * when the embedder is unreachable or slow, the result is empty and callers
 * keep their keyword ranking.
 */
export interface SemanticSearch {
  search(query: string, filter: SemanticQuery, signal?: AbortSignal): Promise<SemanticHit[]>;
}

/** A semantic index Socrates keeps current after every message and closes with itself. */
export interface SemanticIndex extends SemanticSearch {
  scheduleSync(): void;
  close(): Promise<void>;
}

export interface RetrievalOptions {
  store: LedgerStore;
  embedder: EmbeddingClient;
  /** Where LanceDB keeps the index, such as `<database>.lance`, or `memory://`. */
  uri: string;
  /** Installed Skills and MCP tools to index for capability candidates. */
  capabilities?: () => { kind: "skill" | "mcp"; name: string; description: string }[];
  /** Index the files of every workspace bound to a goal, for `<PROJECT_CONTEXT>`. On by default. */
  workspaceFiles?: boolean;
  thresholds?: Partial<Thresholds>;
  queryTimeoutMs?: number;
  now?: () => number;
  /** Internal diagnostics. Never shown to a model. */
  log?: (message: string) => void;
}

/**
 * The embedding index of Socrates' memory (agent-harness.md, "Embeddings").
 * The event log stays the source of truth: vectors are derived data, keyed by
 * a content hash so nothing is embedded twice, refreshed in the background
 * after every message and never on the reply path. A missing or stale vector
 * only means keyword search alone ranks that record until it is indexed.
 */
export class Retrieval implements SemanticIndex {
  readonly thresholds: Thresholds;
  private syncing: Promise<void> | null = null;
  private pending = false;
  private closed = false;
  private readonly lifetime = new AbortController();
  private unavailableUntil = 0;
  private readonly queries = new Map<string, number[]>();
  /** Per workspace: each scanned file's size and modification time, and its section ids. */
  private readonly files = new Map<string, Map<string, { stamp: string; ids: string[] }>>();
  private readonly capped = new Set<string>();

  private constructor(
    private readonly options: RetrievalOptions,
    private readonly index: VectorIndex,
  ) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...options.thresholds };
  }

  /** Open the index and start catching up in the background. */
  static async open(options: RetrievalOptions): Promise<Retrieval> {
    const retrieval = new Retrieval(options, await VectorIndex.open(options.uri, options.embedder.id));
    retrieval.scheduleSync();
    return retrieval;
  }

  get embedderId(): string {
    return this.options.embedder.id;
  }

  /** Bring the index up to date in the background; calls while a sync runs fold into one more pass. */
  scheduleSync(): void {
    if (this.closed) return;
    if (this.syncing) {
      this.pending = true;
      return;
    }
    this.syncing = (async () => {
      do {
        this.pending = false;
        try {
          await this.sync();
        } catch (error) {
          if (!this.lifetime.signal.aborted) this.options.log?.(`embedding index sync failed: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
      } while (this.pending && !this.closed);
    })().finally(() => (this.syncing = null));
  }

  /** Resolves when no background sync is running. */
  async idle(): Promise<void> {
    while (this.syncing) await this.syncing;
  }

  /** One pass: embed every changed document, then advance the watermark. */
  async sync(): Promise<{ embedded: number }> {
    const { store, embedder } = this.options;
    const signal = this.lifetime.signal;
    const target = store.latestEventSeq();
    const watermark = await this.index.watermark();
    const docs = watermark !== null && watermark >= target ? [] : changedDocuments(store, watermark);
    let embedded = await this.write(docs, signal);
    if (watermark === null || target > watermark) await this.index.setWatermark(target);
    // Capabilities come from the catalog, not the event log: compare all of them each pass.
    if (this.options.capabilities) {
      const at = new Date((this.options.now ?? Date.now)()).toISOString();
      const current = this.options.capabilities().map((e) => capabilityDocument(e, at));
      embedded += await this.write(current, signal);
      const keep = new Set(current.map((d) => d.id));
      await this.index.delete((await this.index.ids("capability")).filter((id) => !keep.has(id)));
    }
    if (this.options.workspaceFiles !== false) embedded += await this.syncWorkspaces(signal);
    await this.index.compact();
    return { embedded };
  }

  async search(query: string, filter: SemanticQuery, signal?: AbortSignal): Promise<SemanticHit[]> {
    const now = (this.options.now ?? Date.now)();
    if (this.closed || signal?.aborted || !query.trim() || now < this.unavailableUntil) return [];
    const timeout = AbortSignal.timeout(this.options.queryTimeoutMs ?? QUERY_TIMEOUT_MS);
    const limit = AbortSignal.any([this.lifetime.signal, timeout, ...(signal ? [signal] : [])]);
    let vector = this.queries.get(query);
    if (!vector) {
      try {
        // Raced as well as passed down, so an embedder that ignores the signal cannot hold up the reply.
        [vector] = await abortable(this.options.embedder.embed([query], "query", limit), limit);
      } catch (error) {
        if (!signal?.aborted) {
          this.unavailableUntil = now + RETRY_AFTER_MS;
          this.options.log?.(`embedding a query failed; keyword search only for ${RETRY_AFTER_MS / 1000}s: ${error instanceof Error ? error.message : String(error)}`);
        }
        return [];
      }
      if (!vector) return [];
      this.queries.set(query, vector);
      if (this.queries.size > QUERY_CACHE_SIZE) this.queries.delete(this.queries.keys().next().value!);
    }
    const floor = this.thresholds[filter.min ?? "related"];
    let rows;
    try {
      // Several chunks may belong to one source; over-fetch, then keep each source's best.
      limit.throwIfAborted();
      rows = await abortable(this.index.search(vector, filter, filter.limit * 4), limit);
      limit.throwIfAborted();
    } catch (error) {
      this.options.log?.(`vector search failed: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const best = new Map<string, SemanticHit>();
    for (const r of rows) {
      if (r.similarity < floor) continue;
      // A file's sections are separate results; chunks of one exchange are not.
      const key = r.kind === "file_section" ? r.id : `${r.kind}:${r.source_id}`;
      if (best.has(key) && best.get(key)!.similarity >= r.similarity) continue;
      best.set(key, {
        kind: r.kind, sourceId: r.source_id, goalId: r.goal_id, taskId: r.task_id, turnId: r.turn_id, projectTurn: r.project_turn,
        ...(r.kind === "file_section" ? { workspaceId: r.workspace_id, path: r.path, hash: r.hash } : {}),
        at: r.at, similarity: r.similarity,
      });
    }
    return [...best.values()].sort((a, b) => b.similarity - a.similarity).slice(0, filter.limit);
  }

  /** How many documents are indexed, and the event they reflect. */
  async status(): Promise<{ documents: number; watermark: number | null }> {
    return { documents: await this.index.count(), watermark: await this.index.watermark() };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    await this.syncing?.catch(() => {});
    this.index.close();
  }

  /**
   * Index the files of every workspace bound to a goal. A file whose size and
   * modification time are unchanged since the last scan is skipped; the
   * sections of a changed file are compared by content, so only edited
   * sections are embedded. At most FILE_EMBEDS_PER_PASS sections are embedded
   * per pass; the rest continue in the next pass.
   */
  private async syncWorkspaces(signal: AbortSignal): Promise<number> {
    const { store } = this.options;
    const roots = new Map<string, string>();
    for (const goal of store.listGoals()) {
      const workspace = goal.workspaceId ? store.getWorkspace(goal.workspaceId) : null;
      if (workspace?.rootPath) roots.set(workspace.id, workspace.rootPath);
    }
    let embedded = 0;
    for (const [id, root] of roots) {
      if (embedded >= FILE_EMBEDS_PER_PASS) {
        this.pending = true;
        break;
      }
      try {
        embedded += await this.syncWorkspace(id, root, FILE_EMBEDS_PER_PASS - embedded, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        this.options.log?.(`indexing workspace ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return embedded;
  }

  private async syncWorkspace(workspaceId: string, root: string, budget: number, signal: AbortSignal): Promise<number> {
    const seen = this.files.get(workspaceId) ?? new Map<string, { stamp: string; ids: string[] }>();
    this.files.set(workspaceId, seen);
    const { files, capped } = await workspaceFiles(root, signal);
    if (capped && !this.capped.has(workspaceId)) {
      this.capped.add(workspaceId);
      this.options.log?.(`workspace ${workspaceId} has more indexable files than the limit; only the first are indexed`);
    }
    let embedded = 0;
    let docs: SourceDocument[] = [];
    let read = new Map<string, { stamp: string; ids: string[] }>();
    const flush = async () => {
      embedded += await this.write(docs, signal);
      for (const [rel, entry] of read) seen.set(rel, entry);
      docs = [];
      read = new Map();
    };
    for (const rel of files) {
      signal.throwIfAborted();
      const abs = path.join(root, rel);
      const st = await lstat(abs).catch(() => null);
      const stamp = st?.isFile() ? `${st.size}:${st.mtimeMs}` : "not a regular file";
      if (seen.get(rel)?.stamp === stamp) continue;
      const file = st?.isFile() ? await readIndexable(abs) : null;
      const fileDocs = file ? fileDocuments(workspaceId, rel, file.text, file.mtime.toISOString()) : [];
      docs.push(...fileDocs);
      read.set(rel, { stamp, ids: fileDocs.map((d) => d.id) });
      if (docs.length >= FILE_FLUSH_DOCS) await flush();
      if (embedded >= budget) {
        this.pending = true;
        return embedded;
      }
    }
    await flush();
    // Every file was visited: drop the sections of deleted, ignored, or changed files.
    const listed = new Set(files);
    for (const rel of seen.keys()) if (!listed.has(rel)) seen.delete(rel);
    const keep = new Set([...seen.values()].flatMap((e) => e.ids));
    await this.index.delete((await this.index.ids("file_section", workspaceId)).filter((id) => !keep.has(id)));
    return embedded;
  }

  /** Embed and store the documents whose content changed. */
  private async write(docs: SourceDocument[], signal: AbortSignal): Promise<number> {
    if (!docs.length) return 0;
    const stored = await this.index.hashes(docs.map((d) => d.id));
    const changed = docs.filter((d) => stored.get(d.id)?.hash !== contentHash(d.text));
    for (const d of docs) {
      const previous = stored.get(d.id);
      if (previous?.hash === contentHash(d.text) && previous.at !== d.at) {
        signal.throwIfAborted();
        await this.index.updateTimestamp(d.id, d.at);
      }
    }
    for (let i = 0; i < changed.length; i += 16) {
      signal.throwIfAborted();
      const batch = changed.slice(i, i + 16);
      const vectors = await abortable(this.options.embedder.embed(batch.map((d) => d.text), "document", signal), signal);
      signal.throwIfAborted();
      await this.index.upsert(batch.map((d, j) => ({
        id: d.id, kind: d.kind, source_id: d.sourceId, goal_id: d.goalId, task_id: d.taskId, turn_id: d.turnId, project_turn: d.projectTurn,
        workspace_id: d.workspaceId ?? null, path: d.path ?? null, at: d.at, hash: contentHash(d.text), vector: vectors[j]!,
      })));
    }
    return changed.length;
  }
}
