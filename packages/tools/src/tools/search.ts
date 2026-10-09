import path from "node:path";
import { GlobInput, GrepInput } from "@socrates/contracts";
import { protectedSearchGlobs } from "../access";
import { cutLine } from "../bounds";
import { type HandlerContext, requireWorkspace } from "../context";
import { ToolError } from "../errors";
import { statOrNull } from "../files";
import { type ToolHandler, json } from "../handler";
import { page } from "../paging";
import { runRipgrep } from "../ripgrep";

export const GLOB_DEFAULT_LIMIT = 200;
export const GLOB_MAX_LIMIT = 1000;
export const GREP_DEFAULT_LIMIT = 100;
export const GREP_MAX_LIMIT = 500;
/** Files per page in grep's files and count outputs. */
export const GREP_MAX_FILES_LIMIT = 1000;
export const GREP_MAX_LINE_CHARS = 500;
/** A multiline match is shown up to this many characters. */
const GREP_MAX_MULTILINE_CHARS = 2000;
/** One search may take this long; past it the agent is told to narrow it. */
export const SEARCH_TIMEOUT_MS = 60_000;
/** Internal bound on one frozen result set; reaching it is reported, never hidden. */
const MAX_COLLECTED_PATHS = 50_000;
const MAX_COLLECTED_MATCHES = 5_000;

/**
 * Repository metadata is never listed or searched, and .gitignore applies
 * whether or not the workspace is a git repository.
 */
const EXCLUDE_GIT = ["--no-require-git", "--glob", "!.git", "--glob", "!**/.git/**"];

type Sort = "path" | "modified";

/** ripgrep's order: stable paths, or most recently modified first. */
const sortArgs = (sort: Sort) => (sort === "modified" ? ["--sortr", "modified"] : ["--sort", "path"]);

/**
 * Listing and searching flags shared by glob and grep. ripgrep lets the last
 * matching glob win, so the caller's own globs come before the exclusions:
 * a pattern such as "**\/*" must never bring .git or a protected folder back.
 */
function walkArgs(sort: Sort, includeIgnored: boolean, excludes: string[], globs: string[] = []): string[] {
  return ["--no-config", "--hidden", ...sortArgs(sort), ...(includeIgnored ? ["--no-ignore"] : []), ...globs.flatMap((g) => ["--glob", g]), ...EXCLUDE_GIT, ...excludes];
}

const posix = (rel: string) => rel.replace(/^\.\//, "").split(path.sep).join("/");

/**
 * Run a search under SEARCH_TIMEOUT_MS. The agent's own cancellation stays a
 * cancellation; running out of time is a corrective error.
 */
export async function timed<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>, ms = SEARCH_TIMEOUT_MS): Promise<T> {
  const timeout = AbortSignal.timeout(ms);
  try {
    return await work(AbortSignal.any([signal, timeout]));
  } catch (error) {
    if (timeout.aborted && !signal.aborted) {
      throw new ToolError("search_timeout", `The search took longer than ${Math.round(ms / 1000)} seconds and was stopped.`, "Narrow it: search a subdirectory with path, or filter with type or glob.");
    }
    throw error;
  }
}

/**
 * List files under `dirAbs` that match `pattern`. ripgrep lets an inclusion
 * glob bring back ignored files, so unless ignored files are wanted, the glob's
 * matches are intersected with the ignore-respecting listing.
 */
async function listFiles(dirAbs: string, signal: AbortSignal, pattern: string | undefined, onFile: (rel: string) => boolean, options: { excludes: string[]; sort: Sort; includeIgnored: boolean }): Promise<void> {
  const walk = (globs: string[]) => walkArgs(options.sort, options.includeIgnored, options.excludes, globs);
  let matching: Set<string> | null = null;
  if (pattern !== undefined && !options.includeIgnored) {
    matching = new Set();
    const candidates = matching;
    const filtered = await runRipgrep(["--files", ...walk([pattern])], dirAbs, signal, (line) => (candidates.add(posix(line)), true));
    if (filtered.code === 2) throw invalidGlob(filtered.stderr);
  }
  const listed = await runRipgrep(["--files", ...walk(pattern !== undefined && options.includeIgnored ? [pattern] : [])], dirAbs, signal, (line) => {
    if (!line) return true;
    const rel = posix(line);
    return !matching || matching.has(rel) ? onFile(rel) : true;
  });
  if (listed.code === 2 && !listed.stopped) {
    if (pattern !== undefined && /glob/i.test(listed.stderr)) throw invalidGlob(listed.stderr);
    throw new ToolError("search_failed", `The file listing failed: ${firstLines(listed.stderr, 3)}`, "Check directory permissions and retry.");
  }
}

/**
 * Whether the ignore-respecting listing from `base` includes `rel` (matching
 * `glob` too, when given). Ignored folders are skipped while listing, and the
 * listing stops at the file.
 */
async function fileListed(base: string, rel: string, signal: AbortSignal, glob?: string): Promise<boolean> {
  let found = false;
  await listFiles(base, signal, glob, (listed) => {
    if (listed === rel) found = true;
    return !found;
  }, { excludes: [], sort: "path", includeIgnored: false });
  return found;
}

const invalidGlob = (stderr: string) => new ToolError("invalid_pattern", `The glob was rejected: ${firstLines(stderr, 3)}`, 'Use a glob such as "**/*.ts", "*.{ts,tsx}" or "src/**/test_*.py".');

async function directory(ctx: HandlerContext, input: string | undefined) {
  const workspace = requireWorkspace(ctx);
  return { workspace, dir: await ctx.path(input ?? ".") };
}

export const globTool: ToolHandler<GlobInput> = {
  name: "glob",
  description: [
    'Find files by a ripgrep (gitignore-style) glob, such as "**/*.ts", "src/**/index.ts" or "*.{ts,tsx}"; a pattern without "/" matches names at any depth.',
    `Hidden files are included, .gitignore'd ones only with include_ignored, .git never. limit default ${GLOB_DEFAULT_LIMIT}, max ${GLOB_MAX_LIMIT}; a truncated result has next_cursor: repeat the call with it.`,
  ].join(" "),
  schema: GlobInput,
  concurrency: "parallel",
  mutating: false,
  async execute(input, ctx) {
    const { workspace, dir } = await directory(ctx, input.path);
    const limit = Math.min(input.limit ?? GLOB_DEFAULT_LIMIT, GLOB_MAX_LIMIT);
    const sort = input.sort ?? "modified";
    const includeIgnored = input.include_ignored ?? false;
    const key = json(["glob", input.pattern, dir.rel, sort, includeIgnored]);
    let items: string[];
    let offset = 0;
    let capped = false;
    if (input.cursor) {
      ({ items, offset, capped } = ctx.run.takeCursor<string>(input.cursor, key));
    } else {
      const info = await statOrNull(dir.abs);
      if (!info) throw new ToolError("directory_not_found", `${dir.rel} does not exist.`, "Use an existing directory, or omit path to search the whole workspace.");
      if (!info.isDirectory()) throw new ToolError("not_a_directory", `${dir.rel} is a file, not a directory.`, "Pass its parent directory as path, or read the file directly.");
      items = [];
      const collected = items;
      await timed(ctx.signal, (signal) => listFiles(dir.abs, signal, input.pattern, (rel) => {
        const abs = path.resolve(dir.abs, rel);
        if (!ctx.visible(abs)) return true;
        collected.push(workspace.relative(abs));
        if (collected.length >= MAX_COLLECTED_PATHS) {
          capped = true;
          return false;
        }
        return true;
      }, { excludes: protectedSearchGlobs(ctx.access, dir.abs), sort, includeIgnored }));
    }
    const { out, nextCursor } = page(ctx, key, items, offset, limit, (p) => json(p), { capped });
    const result: Record<string, unknown> = { root: dir.rel, matches: out, returned: out.length, truncated: nextCursor !== null, next_cursor: nextCursor };
    result.collection_capped = capped;
    if (capped) result.note = `Stopped collecting at ${MAX_COLLECTED_PATHS} paths; narrow the pattern or path to see everything.`;
    if (items.length === 0) result.note = includeIgnored ? "No files matched." : "No files matched. Files ignored by .gitignore are not listed; set include_ignored to include them.";
    return { content: json(result), result };
  },
};

/** One match, with the lines around it when context was asked for. */
interface GrepMatch {
  path: string;
  line_number: number;
  /** The last line of a match that spans lines (multiline). */
  end_line?: number;
  text: string;
  before?: string[];
  after?: string[];
  /** The file is not UTF-8; its text is shown with replacement characters. */
  encoding?: "not_utf8";
}

interface FileCount {
  path: string;
  count: number;
}

/** A ripgrep JSON field: text when it is UTF-8, otherwise base64 bytes. */
type RgData = { text?: string; bytes?: string };

function decode(data: RgData): { text: string; utf8: boolean } {
  if (data.text !== undefined) return { text: data.text, utf8: true };
  return { text: Buffer.from(data.bytes ?? "", "base64").toString("utf8"), utf8: false };
}

/**
 * A line to show: whole when short, otherwise a window that contains the
 * match (a minified file's match may sit thousands of characters in).
 */
export function showLine(line: string, matchAt: number, max = GREP_MAX_LINE_CHARS): string {
  if (line.length <= max) return line;
  let start = Math.max(0, Math.min(matchAt - Math.floor(max / 5), line.length - max));
  if (/[\uDC00-\uDFFF]/.test(line[start] ?? "")) start++;
  let end = Math.min(line.length, start + max);
  if (/[\uD800-\uDBFF]/.test(line[end - 1] ?? "")) end--;
  return `${start > 0 ? `[line truncated: ${start} characters before] …` : ""}${line.slice(start, end)}${end < line.length ? `… [line truncated: ${line.length - end} more characters]` : ""}`;
}

const stripEol = (text: string) => text.replace(/\r?\n$/, "");

export const grepTool: ToolHandler<GrepInput> = {
  name: "grep",
  description: [
    "Search file contents with a Rust regex (no lookaround or backreferences), or exact text with literal. Narrow with type and/or glob.",
    `Hidden files are searched, .gitignore'd ones only with include_ignored, .git never. Long lines show ${GREP_MAX_LINE_CHARS} characters around the match. limit default ${GREP_DEFAULT_LIMIT}, max ${GREP_MAX_LIMIT} matches or ${GREP_MAX_FILES_LIMIT} files; a truncated result has next_cursor: repeat the call with it.`,
  ].join(" "),
  schema: GrepInput,
  concurrency: "parallel",
  mutating: false,
  async execute(input, ctx) {
    const workspace = requireWorkspace(ctx);
    const target = await ctx.path(input.path ?? ".");
    const output = input.output ?? "content";
    const sort = input.sort ?? (output === "content" ? "path" : "modified");
    const includeIgnored = input.include_ignored ?? false;
    const before = output === "content" ? (input.context_before ?? input.context ?? 0) : 0;
    const after = output === "content" ? (input.context_after ?? input.context ?? 0) : 0;
    const limit = Math.min(input.limit ?? GREP_DEFAULT_LIMIT, output === "content" ? GREP_MAX_LIMIT : GREP_MAX_FILES_LIMIT);
    const key = json(["grep", input.pattern, target.rel, input.glob ?? null, input.type ?? null, output, before, after, input.multiline ?? false, input.case_sensitive ?? true, input.literal ?? false, sort, includeIgnored]);
    let items: unknown[];
    let offset = 0;
    let capped = false;
    if (input.cursor) {
      ({ items, offset, capped } = ctx.run.takeCursor<unknown>(input.cursor, key));
    } else {
      const info = await statOrNull(target.abs);
      if (!info) throw new ToolError("path_not_found", `${target.rel} does not exist.`, "Use an existing file or directory, or omit path to search the whole workspace.");
      const cwd = info.isDirectory() ? target.abs : path.dirname(target.abs);
      const excludes = protectedSearchGlobs(ctx.access, cwd);
      ({ items, capped } = await timed(ctx.signal, async (signal) => {
        // An inclusion glob or an explicit file would let ripgrep search
        // ignored files, so the ignore-respecting listing decides eligibility.
        let eligible: Set<string> | null = null;
        if (!includeIgnored && info.isDirectory() && input.glob) {
          eligible = new Set();
          const allowed = eligible;
          await listFiles(cwd, signal, input.glob, (rel) => (allowed.add(rel), true), { excludes, sort: "path", includeIgnored });
        } else if (!includeIgnored && !info.isDirectory()) {
          // A file is listed from the workspace root, where an ignore rule for
          // one of its parent folders (such as "dist/") applies.
          const inside = path.relative(workspace.root, target.abs);
          const base = inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? workspace.root : cwd;
          const own = posix(path.relative(base, target.abs));
          const listed = await fileListed(base, own, signal);
          eligible = new Set(listed && (!input.glob || (await fileListed(cwd, path.basename(target.abs), signal, input.glob))) ? [path.basename(target.abs)] : []);
        }
        const args = [
          ...walkArgs(sort, includeIgnored, excludes, input.glob ? [input.glob] : []),
          input.case_sensitive === false ? "--ignore-case" : "--case-sensitive",
          ...(input.literal ? ["--fixed-strings"] : []),
          ...(input.multiline ? ["--multiline", "--multiline-dotall"] : []),
          ...(input.type ? ["--type", input.type] : []),
          ...(output === "files" ? ["--files-with-matches"] : output === "count" ? ["--count", "--with-filename"] : ["--json", ...(before ? ["--before-context", String(before)] : []), ...(after ? ["--after-context", String(after)] : [])]),
          "--regexp",
          input.pattern,
          "--",
          info.isDirectory() ? "." : path.basename(target.abs),
        ];
        const allowed = (file: string) => (!eligible || eligible.has(posix(file))) && ctx.visible(path.resolve(cwd, file));
        const relative = (file: string) => workspace.relative(path.resolve(cwd, file));
        const found: unknown[] = [];
        let full = false;
        const keep = (item: unknown, max: number) => {
          found.push(item);
          full = found.length >= max;
          return !full;
        };
        const lines = output === "content" ? contentCollector(before, after, allowed, relative, (m) => keep(m, MAX_COLLECTED_MATCHES))
          : (line: string) => {
            if (!line) return true;
            if (output === "files") return allowed(line) ? keep(relative(line), MAX_COLLECTED_PATHS) : true;
            const at = line.lastIndexOf(":");
            const file = line.slice(0, at);
            return allowed(file) ? keep({ path: relative(file), count: Number(line.slice(at + 1)) } satisfies FileCount, MAX_COLLECTED_PATHS) : true;
          };
        const run = await runRipgrep(args, cwd, signal, lines);
        if (run.code === 2 && found.length === 0 && run.stderr.trim()) throw searchError(run.stderr, input);
        return { items: found, capped: full };
      }));
    }
    const { out, nextCursor } = page(ctx, key, items, offset, limit, (m) => json(m), { capped });
    const field = output === "content" ? "matches" : output === "files" ? "files" : "counts";
    const result: Record<string, unknown> = { output, [field]: out, returned: out.length, truncated: nextCursor !== null, next_cursor: nextCursor };
    result.collection_capped = capped;
    if (capped) result.note = `Stopped collecting at ${output === "content" ? MAX_COLLECTED_MATCHES : MAX_COLLECTED_PATHS} ${output === "content" ? "matches" : "files"}; narrow the pattern, path, type or glob to see everything.`;
    else if (items.length === 0 && !includeIgnored) result.note = "No matches. Files ignored by .gitignore are not searched; set include_ignored to search them.";
    return { content: json(result), result };
  },
};

/**
 * Turn ripgrep's JSON events into matches with their context. ripgrep sends
 * each file's lines in order, matched and context alike, so the lines before
 * a match are the last ones seen and the lines after it are those that follow;
 * a line between two close matches is context for both.
 */
function contentCollector(before: number, after: number, allowed: (file: string) => boolean, relative: (file: string) => string, keep: (m: GrepMatch) => boolean): (line: string) => boolean {
  let file: string | null = null;
  let recent: { n: number; text: string }[] = [];
  let open: GrepMatch[] = [];
  return (line) => {
    if (!line.startsWith("{")) return true;
    const event = JSON.parse(line) as { type: string; data: { path?: RgData; lines?: RgData; line_number?: number; submatches?: { start: number }[] } };
    if (event.type === "begin") {
      const name = decode(event.data.path ?? {}).text;
      file = allowed(name) ? name : null;
      recent = [];
      open = [];
      return true;
    }
    if ((event.type !== "match" && event.type !== "context") || file === null) return true;
    const { text: raw, utf8 } = decode(event.data.lines ?? {});
    const n = event.data.line_number ?? 0;
    const shown = raw.replace(/\r?\n$/, "").split(/\r?\n/);
    // Lines that follow an earlier match become its after-context.
    open = open.filter((m) => {
      shown.forEach((text, i) => {
        if ((m.after?.length ?? 0) < after && n + i === (m.end_line ?? m.line_number) + (m.after?.length ?? 0) + 1) (m.after ??= []).push(cutLine(text, GREP_MAX_LINE_CHARS));
      });
      return (m.after?.length ?? 0) < after;
    });
    if (event.type === "match") {
      const firstAt = event.data.submatches?.[0]?.start ?? 0;
      const charAt = Buffer.from(raw, "utf8").subarray(0, firstAt).toString("utf8").length;
      const multi = shown.length > 1;
      const match: GrepMatch = {
        path: relative(file),
        line_number: n,
        ...(multi ? { end_line: n + shown.length - 1 } : {}),
        text: multi ? cutLine(stripEol(raw), GREP_MAX_MULTILINE_CHARS) : showLine(shown[0] ?? "", charAt),
        ...(before ? { before: recent.filter((r) => r.n >= n - before && r.n < n).map((r) => r.text) } : {}),
        ...(after ? { after: [] } : {}),
        ...(utf8 ? {} : { encoding: "not_utf8" as const }),
      };
      if (!keep(match)) return false;
      if (after) open.push(match);
    }
    // The last few lines seen are the next match's before-context.
    if (before) recent = [...recent, ...shown.map((text, i) => ({ n: n + i, text: cutLine(text, GREP_MAX_LINE_CHARS) }))].slice(-before);
    return true;
  };
}

function searchError(stderr: string, input: GrepInput): ToolError {
  if (/unrecognized file type/i.test(stderr)) {
    return new ToolError("invalid_type", `"${input.type}" is not a ripgrep file type.`, 'Use a type such as ts, js, py, rust, go, java, c, cpp, md, json, yaml or html, or filter with glob instead.');
  }
  if (/regex parse error|error parsing|unclosed|unrecognized|look-around|backreferences|literal .*\\n.* not allowed|not allowed/i.test(stderr)) {
    const newline = /\\n|newline/i.test(stderr) && !input.multiline;
    return new ToolError(
      "invalid_pattern",
      `The regular expression is invalid: ${firstLines(stderr, 6)}`,
      newline ? "To match across lines, set multiline: true." : "Fix the expression (Rust regex syntax, no lookaround or backreferences), or set literal: true to search for exact text.",
    );
  }
  if (/glob/i.test(stderr)) return invalidGlob(stderr);
  return new ToolError("search_failed", `The search failed: ${firstLines(stderr, 3)}`, "Check the path, type and glob, then retry.");
}

function firstLines(text: string, n: number): string {
  return text.trim().split("\n").slice(0, n).join(" ").slice(0, 600);
}
