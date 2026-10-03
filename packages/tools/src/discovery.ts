import type { LedgerStore } from "@socrates/store";
import type { CapabilityCatalog, CatalogEntry } from "./catalog";
import { mcpPublicName } from "./catalog";
import type { RunState } from "./context";

/**
 * Deterministic capability discovery (agent-harness.md, "Conditional
 * capabilities"): the ranking shared by capability_search and the automatic
 * candidates, the frozen Skill shelf, and the per-turn candidates. Lexical
 * only until the embeddings segment; no model call.
 */

export const SHELF_MAX_SKILLS = 5;
export const SHELF_DESCRIPTION_MAX_CHARS = 200;
export const CANDIDATE_DESCRIPTION_MAX_CHARS = 120;
/** Per-kind thresholds: an MCP match needs more than its server's name. */
export const SKILL_CANDIDATE_THRESHOLD = 40;
export const MCP_CANDIDATE_THRESHOLD = 60;
/** Long messages are searched as overlapping chunks of this many words. */
export const CANDIDATE_CHUNK_WORDS = 48;
const CANDIDATE_CHUNK_STRIDE = 24;

const STOPWORDS = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its me my no not of on or our so than that the their them then there these they this to up us was we were what when where which who why will with would you your".split(" "),
);

export function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Exact names, then aliases, name words, tags, and description words. */
export function matchCapability(entry: CatalogEntry, query: string): { score: number; matched: string[] } {
  const q = query.trim().toLowerCase();
  const name = entry.name.toLowerCase();
  if (name === q || (entry.kind === "mcp" && entry.tool.toLowerCase() === q)) return { score: 1000, matched: [entry.name] };
  if (entry.aliases.some((a) => a.toLowerCase() === q)) return { score: 800, matched: [q] };
  let score = name.includes(q) ? 300 : 0;
  const nameTerms = terms(entry.name.replace(/[._-]/g, " "));
  const aliasTerms = entry.aliases.flatMap((a) => terms(a));
  const tagTerms = entry.tags.flatMap((t) => terms(t));
  const descTerms = terms(entry.description);
  const matched: string[] = [];
  for (const w of terms(q)) {
    const before = score;
    if (nameTerms.includes(w)) score += 40;
    if (aliasTerms.includes(w)) score += 30;
    if (tagTerms.includes(w)) score += 15;
    if (descTerms.includes(w)) score += 5;
    if (score > before) matched.push(w);
  }
  return { score, matched };
}

export function scoreCapability(entry: CatalogEntry, query: string): number {
  return matchCapability(entry, query).score;
}

/** One line of description, bounded. */
function bounded(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface ShelfOptions {
  /** Skills the user pinned, first. */
  pins?: string[];
  /** The deployment's default Skills, after the pins. */
  defaults?: string[];
}

/**
 * `<AVAILABLE_SKILLS>`: at most five Skill names and descriptions — pins,
 * then defaults, then the most often activated, then by name. Resolved once
 * per goal and frozen as an event so ordinary turns stay cache-stable; a
 * Skill that is no longer available drops out of the rendering. An empty
 * shelf is not frozen, so Skills installed later still reach the goal.
 */
export function skillShelf(store: LedgerStore, catalog: CapabilityCatalog, goalId: string, options: ShelfOptions = {}): string | null {
  const available = catalog.entries().filter((e) => e.kind === "skill" && e.availability === "available");
  let shelf = store.skillShelf(goalId);
  if (!shelf) {
    const counts = store.skillActivationCounts();
    const priority = [...(options.pins ?? []), ...(options.defaults ?? [])];
    const rank = (name: string) => (priority.includes(name) ? priority.indexOf(name) : priority.length);
    shelf = [...available]
      .sort((a, b) => rank(a.name) - rank(b.name) || (counts.get(b.name) ?? 0) - (counts.get(a.name) ?? 0) || a.name.localeCompare(b.name))
      .slice(0, SHELF_MAX_SKILLS)
      .map((e) => ({ name: e.name, description: bounded(e.description, SHELF_DESCRIPTION_MAX_CHARS) }));
    if (shelf.length) store.freezeSkillShelf(goalId, shelf);
  }
  const names = new Set(available.map((e) => e.name));
  const shown = shelf.filter((s) => names.has(s.name));
  return shown.length ? `<AVAILABLE_SKILLS>\n${shown.map((s) => `- ${s.name}: ${s.description}`).join("\n")}\n</AVAILABLE_SKILLS>` : null;
}

/** Whether the message names the capability exactly: a Skill or catalog name, a public name, or a distinctive tool name. */
function named(entry: CatalogEntry, message: string): boolean {
  const names = [entry.name, ...(entry.kind === "mcp" ? [mcpPublicName(entry.server, entry.tool), ...(/[_-]/.test(entry.tool) ? [entry.tool] : [])] : [])];
  return names.some((n) => new RegExp(`(?<![\\p{L}\\p{N}_-])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_-])`, "iu").test(message));
}

/** Overlapping word windows, so one sentence in a long message can match without the whole message diluting or inflating it. */
function chunks(message: string): string[] {
  const words = message.split(/\s+/).filter(Boolean);
  if (words.length <= CANDIDATE_CHUNK_WORDS) return [words.join(" ")];
  const out: string[] = [];
  for (let i = 0; i < words.length; i += CANDIDATE_CHUNK_STRIDE) {
    out.push(words.slice(i, i + CANDIDATE_CHUNK_WORDS).join(" "));
    if (i + CANDIDATE_CHUNK_WORDS >= words.length) break;
  }
  return out;
}

/**
 * `<CAPABILITY_CANDIDATES>`: at most one inactive, available Skill and one
 * inactive, available MCP tool that match the current message, each with a
 * run-scoped ref for capability_control. Each kind has its own threshold, so
 * neither can crowd out the other; a capability named exactly always
 * qualifies. Candidates are hints: nothing is activated. Null when none clears.
 */
export function capabilityCandidates(input: { store: LedgerStore; catalog: CapabilityCatalog; goalId: string; message: string; run: RunState }): string | null {
  const active = new Set(input.store.listActiveCapabilities(input.goalId).map((c) => c.name));
  const windows = chunks(input.message);
  const lines: string[] = [];
  for (const [kind, threshold] of [["skill", SKILL_CANDIDATE_THRESHOLD], ["mcp", MCP_CANDIDATE_THRESHOLD]] as const) {
    let best: { entry: CatalogEntry; score: number; reason: string } | null = null;
    for (const entry of input.catalog.entries()) {
      if (entry.kind !== kind || entry.availability !== "available" || active.has(entry.name)) continue;
      let candidate: { score: number; reason: string };
      if (named(entry, input.message)) candidate = { score: Number.POSITIVE_INFINITY, reason: "named in the message" };
      else {
        const top = windows.map((w) => matchCapability(entry, w)).reduce((a, b) => (b.score > a.score ? b : a));
        candidate = { score: top.score, reason: `matched: ${top.matched.slice(0, 4).join(", ")}` };
      }
      if (candidate.score < threshold) continue;
      if (!best || candidate.score > best.score || (candidate.score === best.score && entry.name.localeCompare(best.entry.name) < 0)) best = { entry, ...candidate };
    }
    if (!best) continue;
    const ref = input.run.issueRef("c", { kind: "capability", entryKind: kind, name: best.entry.name, goalId: input.goalId });
    lines.push(`- ${kind} ${ref}: ${best.entry.name} — ${bounded(best.entry.description, CANDIDATE_DESCRIPTION_MAX_CHARS)} (${best.reason})`);
  }
  return lines.length ? `<CAPABILITY_CANDIDATES>\n${lines.join("\n")}\n</CAPABILITY_CANDIDATES>` : null;
}
