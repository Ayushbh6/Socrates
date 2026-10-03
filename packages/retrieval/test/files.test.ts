import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EmbeddingClient } from "@socrates/contracts";
import { HashEmbedder } from "@socrates/providers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoal, exchange, setup } from "../../router/test/helpers";
import { FILE_EMBEDS_PER_PASS, Retrieval, fileDocuments, fileSections, readIndexable, sectionHash, workspaceFiles } from "../src";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function dir(): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), "socrates-files-")));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function write(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
}

/** An embedder that records every document text it is asked to embed. */
function recording(): EmbeddingClient & { documents: string[] } {
  const inner = new HashEmbedder({ concepts: [["checkout", "cart", "basket", "purchase"]] });
  const e = {
    id: inner.id,
    documents: [] as string[],
    async embed(texts: string[], purpose: "query" | "document", signal?: AbortSignal) {
      if (purpose === "document") e.documents.push(...texts);
      return inner.embed(texts, purpose, signal);
    },
  };
  return e;
}

/** A store whose one goal is bound to a workspace folder. */
async function workspaceStore(root: string) {
  const { store } = setup();
  await exchange(store, "Fix the shop.", createGoal("Shop", "Fix checkout"), "On it.");
  const goal = store.listGoals().find((g) => g.title === "Shop")!;
  const workspace = store.createWorkspace("shop", root);
  store.bindGoalWorkspace(goal.id, workspace.id);
  cleanups.push(() => store.close());
  return { store, workspaceId: workspace.id };
}

async function open(store: ReturnType<typeof setup>["store"], embedder: EmbeddingClient) {
  // No floor: a search lists every stored section matching its filter.
  const retrieval = await Retrieval.open({ store, embedder, uri: dir(), thresholds: { related: -1 } });
  cleanups.push(() => retrieval.close());
  await retrieval.idle();
  return retrieval;
}

describe("file sections", () => {
  it("splits Markdown at headings outside code fences, keeping the preamble and exact line ranges", () => {
    const md = ["Intro line", "", "# Plan", "Overview", "```", "# not a heading", "```", "## Day 10", "Dative prepositions", "## Day 11", "Accusative"].join("\r\n");
    expect(fileSections("plan.md", md).map((s) => [s.heading, s.startLine, s.endLine])).toEqual([
      [null, 1, 2], ["Plan", 3, 7], ["Day 10", 8, 9], ["Day 11", 10, 11],
    ]);
    expect(fileSections("plan.md", md)[2]!.text).toBe("## Day 10\nDative prepositions");
  });

  it("splits other files into overlapping line windows, and anything longer than one embedding input again", () => {
    const code = Array.from({ length: 170 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n");
    expect(fileSections("src/a.ts", code).map((s) => [s.startLine, s.endLine])).toEqual([[1, 80], [71, 150], [141, 170]]);
    const long = `# Big\n${Array.from({ length: 200 }, () => "word ".repeat(10)).join("\n")}`;
    const parts = fileSections("big.md", long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.heading === "Big" && p.text.length <= 4_000)).toBe(true);
  });

  it("keys documents by content, so an edit changes only the edited section's id", () => {
    const before = fileDocuments("ws", "plan.md", "# A\none\n# B\ntwo\n", "2026-09-01T00:00:00.000Z");
    const after = fileDocuments("ws", "plan.md", "# A\none\n# B\nthree\n", "2026-09-01T00:00:00.000Z");
    expect(before[0]!.id).toBe(after[0]!.id);
    expect(before[1]!.id).not.toBe(after[1]!.id);
    expect(before[0]).toMatchObject({ kind: "file_section", sourceId: "ws:plan.md", workspaceId: "ws", path: "plan.md", text: "plan.md › A\n# A\none" });
  });
});

describe("which files are indexed", () => {
  const files = {
    "src/cart.ts": "export const LIMIT = 50;",
    "README.md": "# Shop",
    "ignored/x.ts": "ignored",
    ".env": "API_KEY=secret-value",
    ".env.local": "API_KEY=secret-value",
    "keys/id_rsa": "secret-value",
    "certs/server.pem": "secret-value",
    "config/secrets.yaml": "token: secret-value",
    "node_modules/pkg/index.js": "module",
    "dist/out.js": "built",
    "package-lock.json": "{}",
    "public/app.min.js": "minified",
    "debug.log": "log",
  };

  it("in a git repository: tracked and untracked files git does not ignore, minus generated, secret, and noise files", async () => {
    const root = dir();
    write(root, { ...files, ".gitignore": "ignored/\n" });
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "src/cart.ts"], { cwd: root });
    expect((await workspaceFiles(root)).files).toEqual([".gitignore", "README.md", "src/cart.ts"]);
  });

  it("elsewhere: a walk that skips hidden entries and the same generated, secret, and noise files", async () => {
    const root = dir();
    write(root, { ...files, ".hidden/notes.md": "hidden" });
    expect((await workspaceFiles(root)).files).toEqual(["README.md", "ignored/x.ts", "src/cart.ts"]);
  });

  it("a workspace inside a folder its enclosing repository ignores is walked, not listed as empty", async () => {
    const outer = dir();
    write(outer, { ".gitignore": "scratch/\n", "scratch/project/src/cart.ts": "export const LIMIT = 50;" });
    execFileSync("git", ["init", "-q"], { cwd: outer });
    expect((await workspaceFiles(path.join(outer, "scratch/project"))).files).toEqual(["src/cart.ts"]);
  });

  it("never reads symlinks, binary files, or large files", async () => {
    const root = dir();
    const outside = dir();
    write(outside, { "secret.txt": "outside the workspace" });
    write(root, { "bin.dat": Buffer.from([1, 0, 2]), "big.txt": "x".repeat(300 * 1024), "ok.txt": "fine" });
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    expect(await readIndexable(path.join(root, "bin.dat"))).toBeNull();
    expect(await readIndexable(path.join(root, "big.txt"))).toBeNull();
    expect(await readIndexable(path.join(root, "link.txt"))).toBeNull();
    expect((await readIndexable(path.join(root, "ok.txt")))?.text).toBe("fine");
  });
});

describe("indexing workspace files", () => {
  it("embeds each section once, re-embeds only edited sections, drops deleted files, and never embeds secrets", async () => {
    const root = dir();
    write(root, {
      "docs/plan.md": "# Checkout\nThe basket flow.\n# Shipping\nCouriers and rates.\n",
      "src/cart.ts": "export function canCheckout(items: string[]) {\n  return items.length <= 50;\n}\n",
      ".env": "STRIPE_KEY=sk_live_secret",
    });
    const { store, workspaceId } = await workspaceStore(root);
    const embedder = recording();
    const retrieval = await open(store, embedder);
    const files = embedder.documents.filter((t) => t.startsWith("docs/") || t.startsWith("src/"));
    expect(files.sort()).toEqual(["docs/plan.md › Checkout\n# Checkout\nThe basket flow.", "docs/plan.md › Shipping\n# Shipping\nCouriers and rates.", expect.stringMatching(/^src\/cart\.ts\nexport function canCheckout/)]);
    expect(embedder.documents.join("\n")).not.toContain("sk_live_secret");

    const hits = await retrieval.search("purchase", { kinds: ["file_section"], workspaceIds: [workspaceId], paths: ["docs/plan.md"], limit: 5 });
    const checkout = fileSections("docs/plan.md", "# Checkout\nThe basket flow.\n# Shipping\nCouriers and rates.\n")[0]!;
    expect(hits[0]).toMatchObject({ kind: "file_section", workspaceId, path: "docs/plan.md", hash: sectionHash("docs/plan.md", checkout) });

    // Unchanged files are not even read again.
    embedder.documents.length = 0;
    await retrieval.sync();
    expect(embedder.documents).toEqual([]);

    // One edited section is embedded again; its old vector is gone.
    write(root, { "docs/plan.md": "# Checkout\nThe basket flow.\n# Shipping\nOnly one courier now.\n" });
    utimesSync(path.join(root, "docs/plan.md"), new Date(), new Date(Date.now() + 5_000));
    await retrieval.sync();
    expect(embedder.documents).toEqual(["docs/plan.md › Shipping\n# Shipping\nOnly one courier now."]);
    const plan = await retrieval.search("courier", { kinds: ["file_section"], workspaceIds: [workspaceId], paths: ["docs/plan.md"], limit: 5 });
    expect(plan).toHaveLength(2);

    unlinkSync(path.join(root, "src/cart.ts"));
    await retrieval.sync();
    expect(await retrieval.search("checkout", { kinds: ["file_section"], workspaceIds: [workspaceId], paths: ["src/cart.ts"], limit: 5 })).toEqual([]);
    expect(await retrieval.search("checkout", { kinds: ["file_section"], workspaceIds: [workspaceId], excludePaths: ["docs/plan.md"], limit: 5 })).toEqual([]);
  });

  it("embeds a large workspace over several passes, so the ledger is never kept waiting long", async () => {
    const root = dir();
    write(root, Object.fromEntries(Array.from({ length: FILE_EMBEDS_PER_PASS + 40 }, (_, i) => [`notes/n${i}.txt`, `note number ${i}`])));
    const { store } = await workspaceStore(root);
    const embedder = recording();
    const passes = vi.spyOn(Retrieval.prototype, "sync");
    cleanups.push(() => passes.mockRestore());
    await open(store, embedder);
    expect(passes.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(embedder.documents.filter((t) => t.startsWith("notes/"))).size).toBe(FILE_EMBEDS_PER_PASS + 40);
  });
});
