import { lstatSync, readFileSync } from "node:fs";
import { type FileSection, MAX_INDEXED_FILE_BYTES, SECRET_PATH, type SemanticHit, fileSections, fuse, sectionHash, sectionText } from "@socrates/retrieval";
import { countTokens } from "@socrates/shared";
import { type LedgerStore, significantTerms } from "@socrates/store";
import { type WorkspaceRoot, head } from "@socrates/tools";

/** An anchor at most this large is shown whole. */
export const ANCHOR_WHOLE_MAX_TOKENS = 1_500;
/** At most this many sections of larger anchors. */
export const ANCHOR_MAX_SECTIONS = 3;
/** At most this many sections of other workspace files, on a strong meaning match only. */
export const RELATED_MAX_SECTIONS = 2;
const SECTION_MAX_TOKENS = 800;
const OUTLINE_MAX_HEADINGS = 40;

export interface ProjectContextInput {
  store: LedgerStore;
  goalId: string;
  workspace: WorkspaceRoot | null;
  /** The message with the current task's title and note: what the sections should serve. */
  query: string;
  /** Meaning matches among the anchors' sections (related floor) and other files' sections (strong floor). */
  semantic?: { anchors: SemanticHit[]; related: SemanticHit[] };
  maxTokens: number;
}

interface Candidate {
  path: string;
  section: FileSection;
  hash: string;
  related: boolean;
}

/**
 * `<PROJECT_CONTEXT>` (Goal-router.md, "PROJECT_CONTEXT"): the goal's
 * anchors, small ones whole and larger ones as an outline with their most
 * relevant sections, then at most two sections of other workspace files that
 * match strongly in meaning. Text is always read from disk now; the index
 * only picks sections, and a section whose content changed since it was
 * indexed is never selected by its stale vector. Returns null when empty.
 */
export function projectContext(input: ProjectContextInput): string | null {
  const { store, workspace } = input;
  if (!workspace) return null;
  const anchors = store.listAnchors(input.goalId).filter((a) => a.status !== "superseded");
  const entries: string[] = [];
  const pool: Candidate[] = [];
  let whole = 0;
  for (const anchor of anchors) {
    const label = `anchor ${anchor.path} — ${anchor.role}${anchor.status === "provisional" ? " (provisional)" : ""}`;
    if (SECRET_PATH.test(anchor.path)) {
      entries.push(`${label}: not shown, it may hold credentials; read it only when the work needs it`);
      continue;
    }
    const { text: file, problem } = readText(workspace, anchor.path);
    if (file === undefined) {
      entries.push(`${label}: ${problem === "missing" ? "not found in the workspace" : "too large or not text; read the parts you need"}`);
      continue;
    }
    const tokens = countTokens(file);
    if (tokens <= ANCHOR_WHOLE_MAX_TOKENS && whole + tokens <= (input.maxTokens * 2) / 3) {
      whole += tokens;
      entries.push(`${label} (whole file)\n${file.trimEnd()}`);
      continue;
    }
    const sections = fileSections(anchor.path, file);
    pool.push(...sections.map((section) => ({ path: anchor.path, section, hash: sectionHash(anchor.path, section), related: false })));
    entries.push(outline(label, file, sections));
  }

  const meaning = (hits: SemanticHit[], from: Candidate[]) =>
    hits.map((h) => from.find((c) => c.path === h.path && c.hash === h.hash)).filter((c): c is Candidate => !!c);
  const key = (c: Candidate) => `${c.path}#${c.hash}`;
  const picked = fuse([lexical(input.query, pool), meaning(input.semantic?.anchors ?? [], pool)], key)
    .slice(0, ANCHOR_MAX_SECTIONS)
    .map((f) => f.item)
    .sort((a, b) => a.path.localeCompare(b.path) || a.section.startLine - b.section.startLine);

  const anchorPaths = new Set(anchors.map((a) => a.path));
  const related: Candidate[] = [];
  for (const hit of input.semantic?.related ?? []) {
    if (related.length >= RELATED_MAX_SECTIONS || !hit.path || anchorPaths.has(hit.path) || SECRET_PATH.test(hit.path)) continue;
    const file = readText(workspace, hit.path).text;
    if (file === undefined) continue;
    const found = fileSections(hit.path, file).find((s) => sectionHash(hit.path!, s) === hit.hash);
    if (found) related.push({ path: hit.path, section: found, hash: hit.hash!, related: true });
  }

  const blocks: string[] = [];
  let used = countTokens("<PROJECT_CONTEXT>\n</PROJECT_CONTEXT>");
  for (const text of [...entries, ...[...picked, ...related].map(renderSection)]) {
    const cost = countTokens(text) + 2;
    if (used + cost > input.maxTokens) continue;
    blocks.push(text);
    used += cost;
  }
  return blocks.length ? `<PROJECT_CONTEXT>\n${blocks.join("\n\n")}\n</PROJECT_CONTEXT>` : null;
}

/** A file's text as it is now, or why it cannot be shown. */
function readText(workspace: WorkspaceRoot, rel: string): { text?: string; problem?: "missing" | "unreadable" } {
  try {
    const { abs } = workspace.resolve(rel);
    const st = lstatSync(abs);
    if (!st.isFile()) return { problem: "missing" };
    if (st.size > MAX_INDEXED_FILE_BYTES) return { problem: "unreadable" };
    const bytes = readFileSync(abs);
    return bytes.subarray(0, 8_000).includes(0) ? { problem: "unreadable" } : { text: bytes.toString("utf8") };
  } catch {
    return { problem: "missing" };
  }
}

function outline(label: string, file: string, sections: FileSection[]): string {
  const lines = file.split("\n").length;
  const headings: string[] = [];
  // A long section's later windows repeat its heading; list each heading once, where it starts.
  for (const s of sections) if (s.heading && /^#{1,6}\s/.test(s.text)) headings.push(`- ${s.heading} (line ${s.startLine})`);
  if (!headings.length) return `${label} (${lines} lines; relevant sections below)`;
  const shown = headings.slice(0, OUTLINE_MAX_HEADINGS);
  if (headings.length > shown.length) shown.push(`- … and ${headings.length - shown.length} more headings`);
  return `${label} (${lines} lines; outline, relevant sections below)\n${shown.join("\n")}`;
}

/** Sections ranked by the query's significant words, rarer words weighing more. */
function lexical(query: string, pool: Candidate[]): Candidate[] {
  const terms = significantTerms(query);
  if (!terms.length || !pool.length) return [];
  const words = pool.map((c) => new Set(sectionText(c.path, c.section).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []));
  const idf = new Map(terms.map((t) => [t, Math.log(1 + pool.length / (1 + words.filter((w) => w.has(t)).length))]));
  return pool
    .map((c, i) => ({ c, score: terms.reduce((sum, t) => sum + (words[i]!.has(t) ? idf.get(t)! : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c);
}

function renderSection(c: Candidate): string {
  const label = `--- ${c.path}${c.section.heading ? ` › ${c.section.heading}` : ""} (lines ${c.section.startLine}–${c.section.endLine})${c.related ? " — related file" : ""}`;
  return `${label}\n${head(c.section.text, SECTION_MAX_TOKENS, `read ${c.path} for the rest`).text}`;
}
