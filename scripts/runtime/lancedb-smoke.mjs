import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const serverRoot = path.resolve(process.argv[2] ?? path.join(process.cwd(), "apps", "server"));
const requireFromServer = createRequire(path.join(serverRoot, "package.json"));
const lancedb = requireFromServer("@lancedb/lancedb");
const databasePath = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-lancedb-smoke-"));
let db;
let table;

try {
  db = await lancedb.connect(databasePath);
  table = await db.createTable("retrieval_smoke", [
    { id: "slow", content: "Slow mode pauses implementation until the user gives explicit approval.", vector: [1, 0, 0] },
    { id: "cache", content: "Stable prompt prefixes improve provider cache reuse.", vector: [0, 1, 0] },
    { id: "training", content: "The user enjoys MMA and submission grappling training.", vector: [0, 0, 1] },
  ]);

  await table.createIndex("content", { config: lancedb.Index.fts({ withPosition: true }) });

  const lexical = await table.search("slow mode", "fts", "content").limit(2).toArray();
  const semantic = await table.vectorSearch([1, 0, 0]).bypassVectorIndex().limit(2).toArray();
  const reranker = await lancedb.rerankers.RRFReranker.create();
  const hybrid = await table
    .query()
    .nearestTo([1, 0, 0])
    .fullTextSearch("slow mode", { columns: ["content"] })
    .rerank(reranker)
    .limit(2)
    .toArray();

  for (const [name, rows] of Object.entries({ lexical, semantic, hybrid })) {
    if (rows[0]?.id !== "slow") {
      throw new Error(`LanceDB ${name} smoke search did not return the expected row first.`);
    }
  }

  console.log(`LanceDB runtime smoke passed from ${serverRoot}.`);
} finally {
  table?.close();
  db?.close();
  fs.rmSync(databasePath, { recursive: true, force: true });
}
