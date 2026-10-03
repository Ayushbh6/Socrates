import { spawn } from "node:child_process";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { CHUNK_CHARS, type SourceDocument, contentHash } from "./documents";

/**
 * Workspace files as `<PROJECT_CONTEXT>` sources (agent-harness.md,
 * "Project files"). Files are split into sections, each embedded on its own;
 * the agent always reads the current file, the index only picks sections.
 */

/** Dependency, build, cache, repository-metadata and temporary paths; log, lock, temporary and source-map files. Never anchors, never indexed. */
export const GENERATED_PATH = /(^|\/)(node_modules|dist|build|out|coverage|tmp|temp|\.git|\.socrates|\.cache|\.next|target|__pycache__)(\/|$)|\.(log|tmp|lock|map)$/i;
/** Files that may hold credentials: never embedded and never shown to a model unasked. */
export const SECRET_PATH = /(^|\/)(\.env(\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|\.htpasswd|\.git-credentials|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?)$|\.(pem|key|p12|pfx|jks|keystore|gpg|asc|kdbx)$/i;
/** Lockfiles and minified bundles: large and never useful as context. */
const NOISE_PATH = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|go\.sum)$|\.min\.(js|css)$/i;
export const MAX_INDEXED_FILE_BYTES = 256 * 1024;
export const MAX_INDEXED_FILES = 5_000;
/** Non-Markdown files are split into windows of at most this many lines, overlapping by a few. */
export const WINDOW_LINES = 80;
const WINDOW_OVERLAP_LINES = 10;
const MARKDOWN = /\.(md|mdx|markdown)$/i;

export function indexablePath(rel: string): boolean {
  return !GENERATED_PATH.test(rel) && !SECRET_PATH.test(rel) && !NOISE_PATH.test(rel);
}

/**
 * The workspace's indexable files, relative and sorted: git's view (tracked
 * and untracked, ignored files excluded) in a repository, otherwise (also in
 * a folder its enclosing repository ignores) a walk that skips hidden
 * entries. At most MAX_INDEXED_FILES.
 */
export async function workspaceFiles(root: string, signal?: AbortSignal): Promise<{ files: string[]; capped: boolean }> {
  const listed = (await gitFiles(root, signal)) ?? (await walk(root, signal));
  const files = listed.filter(indexablePath).sort();
  return { files: files.slice(0, MAX_INDEXED_FILES), capped: files.length > MAX_INDEXED_FILES };
}

/** Git's file list, or null outside a repository or in a folder the enclosing repository ignores. */
async function gitFiles(root: string, signal?: AbortSignal): Promise<string[] | null> {
  // check-ignore exits 0 for an ignored folder, 1 for a tracked one, and 128 outside a repository.
  if ((await git(root, ["check-ignore", "-q", "."], signal)).code !== 1) return null;
  const listed = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], signal);
  return listed.code === 0 ? [...new Set(listed.stdout.split("\0").filter(Boolean))] : null;
}

function git(root: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"], ...(signal ? { signal } : {}) });
    const out: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.on("error", () => resolve({ code: null, stdout: "" }));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).toString("utf8") }));
  });
}

async function walk(root: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string) => {
    signal?.throwIfAborted();
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".") || out.length > MAX_INDEXED_FILES) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !GENERATED_PATH.test(`${rel}/`)) await visit(rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await visit("");
  return out;
}

/** A regular file's text, or null when it is a symlink, too large, or binary. */
export async function readIndexable(abs: string): Promise<{ text: string; mtime: Date; size: number } | null> {
  const st = await lstat(abs).catch(() => null);
  if (!st?.isFile() || st.size > MAX_INDEXED_FILE_BYTES) return null;
  const handle = await open(abs, "r");
  try {
    const bytes = await handle.readFile();
    if (bytes.subarray(0, 8_000).includes(0)) return null;
    return { text: bytes.toString("utf8"), mtime: st.mtime, size: st.size };
  } finally {
    await handle.close();
  }
}

export interface FileSection {
  /** The Markdown heading the section starts with, or null. */
  heading: string | null;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * A file's sections: Markdown splits at its headings (outside code fences),
 * other files into overlapping line windows; anything longer than one
 * embedding input is split again.
 */
export function fileSections(rel: string, content: string): FileSection[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (!MARKDOWN.test(rel)) return windows(lines, 0, lines.length, null, WINDOW_LINES);
  const out: FileSection[] = [];
  let start = 0;
  let heading: string | null = null;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i]!)) {
      fence = !fence;
      continue;
    }
    const m = fence ? null : /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]!);
    if (!m) continue;
    out.push(...windows(lines, start, i, heading, Infinity));
    start = i;
    heading = m[1]!;
  }
  out.push(...windows(lines, start, lines.length, heading, Infinity));
  return out;
}

function windows(lines: string[], start: number, end: number, heading: string | null, maxLines: number): FileSection[] {
  const out: FileSection[] = [];
  let s = start;
  while (s < end) {
    let e = s;
    let chars = 0;
    while (e < end && e - s < maxLines && (e === s || chars + lines[e]!.length + 1 <= CHUNK_CHARS)) chars += lines[e++]!.length + 1;
    const text = lines.slice(s, e).join("\n");
    if (text.trim()) out.push({ heading, startLine: s + 1, endLine: e, text: text.slice(0, CHUNK_CHARS) });
    if (e >= end) break;
    s = Math.max(s + 1, e - WINDOW_OVERLAP_LINES);
  }
  return out;
}

/** What is embedded for a section: its path and heading give the text its subject. */
export function sectionText(rel: string, section: FileSection): string {
  return `${rel}${section.heading ? ` › ${section.heading}` : ""}\n${section.text}`;
}

/** Identifies a section's exact content, so a stale vector never selects changed text. */
export function sectionHash(rel: string, section: FileSection): string {
  return contentHash(sectionText(rel, section));
}

/** One document per section, keyed by content so an edit re-embeds only the sections it changed. */
export function fileDocuments(workspaceId: string, rel: string, content: string, at: string): SourceDocument[] {
  const seen = new Map<string, number>();
  return fileSections(rel, content).map((section) => {
    const text = sectionText(rel, section);
    const key = contentHash(text).slice(0, 16);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return {
      id: `file:${workspaceId}:${rel}:${key}${n ? `:${n}` : ""}`,
      kind: "file_section" as const,
      sourceId: `${workspaceId}:${rel}`,
      goalId: null, taskId: null, turnId: null, projectTurn: null,
      workspaceId, path: rel, at, text,
    };
  });
}
