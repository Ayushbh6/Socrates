import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const requireFromServer = createRequire(path.resolve("apps/server/package.json"));
const { Index, connect, rerankers } = requireFromServer("@lancedb/lancedb");

const CHUNK_COUNT = 10_000;
const DIMENSIONS = 32;
const RUNS = 12;
const marker = "emergency leave calendar policy";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "socrates-retrieval-benchmark-"));

try {
  const db = await connect(path.join(root, "lance"));
  const rows = Array.from({ length: CHUNK_COUNT }, (_, index) => ({
    id: `chunk_${index}`,
    parentId: `turn_${Math.floor(index / 2)}`,
    content: index === 9_731 ? `The ${marker} grants five paid days.` : `Ordinary project conversation chunk ${index} about implementation details.`,
    projectId: "benchmark",
    corpusKind: "trace_turn",
    vector: vectorFor(index === 9_731 ? 1 : index + 2),
  }));
  const table = await db.createTable("benchmark", rows);
  await table.createIndex("content", { config: Index.fts({ withPosition: true }) });
  const reranker = await rerankers.RRFReranker.create();
  const queryVector = vectorFor(1);

  await table.search(`"${marker}"`, "fts", "content").limit(8).toArray();
  await table.vectorSearch(queryVector).distanceType("cosine").bypassVectorIndex().limit(8).toArray();
  await table.query().nearestTo(queryVector).distanceType("cosine").bypassVectorIndex().fullTextSearch(marker, { columns: ["content"] }).rerank(reranker).limit(8).toArray();

  const lexicalMs = await measure(() => table.search(`"${marker}"`, "fts", "content").limit(8).toArray());
  const vectorMs = await measure(() => table.vectorSearch(queryVector).distanceType("cosine").bypassVectorIndex().limit(8).toArray());
  const hybridMs = await measure(() => table.query().nearestTo(queryVector).distanceType("cosine").bypassVectorIndex().fullTextSearch(marker, { columns: ["content"] }).rerank(reranker).limit(8).toArray());

  process.stdout.write(`${JSON.stringify({
    chunks: CHUNK_COUNT,
    dimensions: DIMENSIONS,
    runs: RUNS,
    localRetrievalMs: {
      lexical: stats(lexicalMs),
      exhaustiveVector: stats(vectorMs),
      hybridRrf: stats(hybridMs),
    },
    embeddingNetworkMs: null,
    note: "Embedding network latency is intentionally separate and is measured only against the configured provider.",
  }, null, 2)}\n`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

async function measure(run) {
  const samples = [];
  for (let index = 0; index < RUNS; index += 1) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  return samples;
}

function stats(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    median: round(sorted[Math.floor(sorted.length / 2)]),
    p95: round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
  };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function vectorFor(seed) {
  const values = Array.from({ length: DIMENSIONS }, (_, index) => Math.sin(seed * (index + 1)) + Math.cos((seed + 3) * (index + 2)));
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}
