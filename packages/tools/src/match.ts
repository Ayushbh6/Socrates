/**
 * Locating `old_text` in a file. Exact matching comes first; if it finds
 * nothing, whole-line matching tolerates whitespace and typographic
 * differences that models commonly introduce, in increasing leniency:
 * trailing whitespace, indentation, then Unicode punctuation. There is no
 * similarity scoring: every tier still compares every line, so a match can
 * never land on a block that merely resembles the request.
 */

export type MatchTier = "exact" | "trailing_whitespace" | "indentation" | "unicode_punctuation";

export interface Match {
  start: number;
  end: number;
  /**
   * For an indentation-tolerant match: the shift from the given lines to this
   * occurrence, applied to the replacement. Each occurrence has its own.
   * Null when the given lines already have this occurrence's indentation.
   */
  reindent: ((text: string) => string) | null;
}

export interface MatchResult {
  tier: MatchTier;
  matches: Match[];
  /** Line numbers of indentation-tolerant matches whose indentation differs non-uniformly from old_text. */
  unshiftable: number[];
}

const LINE_TIERS: { tier: Exclude<MatchTier, "exact">; norm: (line: string) => string }[] = [
  { tier: "trailing_whitespace", norm: (l) => l.trimEnd() },
  { tier: "indentation", norm: (l) => l.trim() },
  { tier: "unicode_punctuation", norm: (l) => normalizePunctuation(l.trim()) },
];

export function findMatches(content: string, find: string): MatchResult | null {
  const exact: Match[] = [];
  for (let i = content.indexOf(find); i >= 0; i = content.indexOf(find, i + find.length)) exact.push({ start: i, end: i + find.length, reindent: null });
  if (exact.length) return { tier: "exact", matches: exact, unshiftable: [] };

  const lines = lineSpans(content);
  const endsWithNewline = find.endsWith("\n");
  const findLines = (endsWithNewline ? find.slice(0, -1) : find).split("\n");
  if (findLines.every((l) => l.trim() === "")) return null;

  for (const { tier, norm } of LINE_TIERS) {
    const target = findLines.map(norm);
    const matches: Match[] = [];
    const unshiftable: number[] = [];
    for (let i = 0; i + findLines.length <= lines.length; ) {
      let ok = true;
      for (let j = 0; j < findLines.length; j++) {
        if (norm(lines[i + j]!.text) !== target[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        i++;
        continue;
      }
      const last = lines[i + findLines.length - 1]!;
      let reindent: Match["reindent"] = null;
      if (tier === "indentation" || tier === "unicode_punctuation") {
        const shift = indentShift(lines.slice(i, i + findLines.length).map((l) => l.text), findLines);
        if (shift === undefined) unshiftable.push(i + 1);
        else reindent = shift;
      }
      matches.push({ start: lines[i]!.start, end: endsWithNewline ? Math.min(content.length, last.end + 1) : last.end, reindent });
      i += findLines.length;
    }
    if (matches.length) return { tier, matches, unshiftable };
  }
  return null;
}

/** Line numbers (1-based) where the first non-blank line of `find` appears, for a helpful not-found error. */
export function nearMisses(content: string, find: string, max = 3): number[] {
  const first = find.split("\n").find((l) => l.trim() !== "")?.trim();
  if (!first) return [];
  const out: number[] = [];
  lineSpans(content).forEach((l, i) => {
    if (out.length < max && l.text.trim() === first) out.push(i + 1);
  });
  return out;
}

export function lineNumberAt(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) n++;
  return n;
}

function lineSpans(content: string): { text: string; start: number; end: number }[] {
  const spans: { text: string; start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content.charCodeAt(i) === 10) {
      if (i === content.length && start === i && spans.length) break;
      spans.push({ text: content.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  return spans;
}

/**
 * When the model's lines differ from the file only by one constant leading
 * prefix, return a function that applies the same shift to the replacement;
 * null when there is no shift; undefined when the difference is not one
 * constant shift, so no replacement indentation can be derived safely.
 */
function indentShift(actual: string[], given: string[]): ((text: string) => string) | null | undefined {
  const lead = (l: string) => /^[ \t]*/.exec(l)![0];
  let shift: { add: string } | { remove: string } | null = null;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i]!.trim() === "") continue;
    const a = lead(actual[i]!);
    const g = lead(given[i]!);
    const candidate = a.endsWith(g) ? { add: a.slice(0, a.length - g.length) } : g.endsWith(a) ? { remove: g.slice(0, g.length - a.length) } : null;
    if (!candidate) return undefined;
    if (shift === null) shift = candidate;
    else if (JSON.stringify(shift) !== JSON.stringify(candidate)) return undefined;
  }
  if (!shift || ("add" in shift ? shift.add : shift.remove) === "") return null;
  const s = shift;
  return (text) =>
    text
      .split("\n")
      .map((l) => (l.trim() === "" ? l : "add" in s ? s.add + l : l.startsWith(s.remove) ? l.slice(s.remove.length) : l))
      .join("\n");
}

const PUNCTUATION: [RegExp, string][] = [
  [/[‐-―−]/g, "-"],
  [/[‘’‚‛]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[  -   　]/g, " "],
  [/…/g, "..."],
];

export function normalizePunctuation(text: string): string {
  return PUNCTUATION.reduce((t, [re, to]) => t.replace(re, to), text);
}
