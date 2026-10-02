import path from "node:path";
import { GlobInput, GrepInput } from "@socrates/contracts";
import { cutLine } from "../bounds";
import { type HandlerContext, requireWorkspace } from "../context";
import { ToolError } from "../errors";
import { statOrNull } from "../files";
import { type ToolHandler, json } from "../handler";
import { page } from "../paging";
import { runRipgrep } from "../ripgrep";
import picomatch from "picomatch";

export const GLOB_DEFAULT_LIMIT = 200;
export const GLOB_MAX_LIMIT = 1000;
export const GREP_DEFAULT_LIMIT = 100;
export const GREP_MAX_LIMIT = 500;
export const GREP_MAX_LINE_CHARS = 500;
/** Internal bound on one frozen result set; reaching it is reported, never hidden. */
const MAX_COLLECTED_PATHS = 50_000;
const MAX_COLLECTED_MATCHES = 5_000;

/**
 * Repository metadata is never listed or searched, and .gitignore applies
 * whether or not the workspace is a git repository.
 */
const EXCLUDE_GIT = ["--no-require-git", "--glob", "!.git", "--glob", "!**/.git/**"];

/**
 * A matcher for one gitignore-style glob relative to the searched directory:
 * a pattern without "/" matches file names at any depth.
 *
 * Globs are applied here, to the ignore-respecting file list, instead of
 * being passed to ripgrep, because a ripgrep inclusion glob overrides
 * .gitignore and would bring ignored files back.
 */
function globMatcher(pattern: string): (rel: string) => boolean {
  const clean = pattern.replace(/^\.\//, "").replace(/^\//, "");
  try {
    return picomatch(clean, { dot: true, basename: !clean.includes("/") });
  } catch (error) {
    throw new ToolError("invalid_pattern", `The glob pattern is invalid: ${(error as Error).message}`, 'Use a glob such as "**/*.ts" or "src/**/test_*.py".');
  }
}

/** Files under a directory that ignore rules allow, as paths relative to it, in stable order. */
async function listFiles(dirAbs: string, signal: AbortSignal, accept: (rel: string) => boolean, onFile: (rel: string) => boolean): Promise<void> {
  await runRipgrep(["--no-config", "--files", "--hidden", "--sort", "path", ...EXCLUDE_GIT], dirAbs, signal, (line) => {
    if (!line) return true;
    const rel = line.replace(/^\.\//, "").split(path.sep).join("/");
    return accept(rel) ? onFile(rel) : true;
  });
}

function directory(ctx: HandlerContext, input: string | undefined) {
  const workspace = requireWorkspace(ctx);
  return { workspace, dir: workspace.resolve(input ?? ".") };
}

export const globTool: ToolHandler<GlobInput> = {
  name: "glob",
  description: [
    'Find files by path pattern, such as "**/*.ts", "src/**/index.ts", or "*.md". Patterns use ripgrep (gitignore-style) globs: a pattern without "/" matches file names at any depth.',
    "Returns workspace-relative file paths in stable path order. Hidden files are included; files ignored by .gitignore and the .git directory are not.",
    `path is the directory to search (default: workspace root). limit defaults to ${GLOB_DEFAULT_LIMIT} (max ${GLOB_MAX_LIMIT}). A truncated result carries next_cursor; pass it with the same pattern and path to continue.`,
  ].join(" "),
  schema: GlobInput,
  concurrency: "parallel",
  mutating: false,
  async execute(input, ctx) {
    const { workspace, dir } = directory(ctx, input.path);
    const limit = Math.min(input.limit ?? GLOB_DEFAULT_LIMIT, GLOB_MAX_LIMIT);
    const key = json(["glob", input.pattern, dir.rel]);
    let items: string[];
    let offset = 0;
    let capped = false;
    if (input.cursor) {
      ({ items, offset } = ctx.run.takeCursor<string>(input.cursor, key));
    } else {
      const info = await statOrNull(dir.abs);
      if (!info) throw new ToolError("directory_not_found", `${dir.rel} does not exist.`, "Use an existing directory, or omit path to search the whole workspace.");
      if (!info.isDirectory()) throw new ToolError("not_a_directory", `${dir.rel} is a file, not a directory.`, "Pass its parent directory as path, or read the file directly.");
      items = [];
      const collected = items;
      await listFiles(dir.abs, ctx.signal, globMatcher(input.pattern), (rel) => {
        collected.push(workspace.relative(path.resolve(dir.abs, rel)));
        if (collected.length >= MAX_COLLECTED_PATHS) {
          capped = true;
          return false;
        }
        return true;
      });
    }
    const { out, nextCursor } = page(ctx, key, items, offset, limit, (p) => p);
    const result: Record<string, unknown> = { root: dir.rel, matches: out, returned: out.length, truncated: nextCursor !== null, next_cursor: nextCursor };
    if (capped) result.note = `Stopped collecting at ${MAX_COLLECTED_PATHS} paths; narrow the pattern or path to see everything.`;
    if (items.length === 0) result.note = "No files matched. Files ignored by .gitignore are not listed.";
    return { content: json(result), result };
  },
};

interface GrepMatch {
  path: string;
  line_number: number;
  text: string;
}

export const grepTool: ToolHandler<GrepInput> = {
  name: "grep",
  description: [
    "Search file contents. pattern is a regular expression (Rust regex syntax: no lookaround or backreferences) unless literal is true. Matching is case-sensitive unless case_sensitive is false.",
    'path may be one file or a directory (default: workspace root); glob is one inclusion filter such as "*.ts" or "**/*.test.ts". Hidden files are searched; .gitignore-ignored files and .git are not.',
    `Returns matching lines with path and line_number in stable order, each cut at ${GREP_MAX_LINE_CHARS} characters. limit defaults to ${GREP_DEFAULT_LIMIT} (max ${GREP_MAX_LIMIT}); a truncated result carries next_cursor. Use read for surrounding lines.`,
  ].join(" "),
  schema: GrepInput,
  concurrency: "parallel",
  mutating: false,
  async execute(input, ctx) {
    const workspace = requireWorkspace(ctx);
    const target = workspace.resolve(input.path ?? ".");
    const limit = Math.min(input.limit ?? GREP_DEFAULT_LIMIT, GREP_MAX_LIMIT);
    const key = json(["grep", input.pattern, target.rel, input.glob ?? null, input.case_sensitive ?? true, input.literal ?? false]);
    let items: GrepMatch[];
    let offset = 0;
    let capped = false;
    if (input.cursor) {
      ({ items, offset } = ctx.run.takeCursor<GrepMatch>(input.cursor, key));
    } else {
      const info = await statOrNull(target.abs);
      if (!info) throw new ToolError("path_not_found", `${target.rel} does not exist.`, "Use an existing file or directory, or omit path to search the whole workspace.");
      const cwd = info.isDirectory() ? target.abs : path.dirname(target.abs);
      // With a glob filter, only files the ignore rules allow are eligible (see globMatcher).
      let eligible: Set<string> | null = null;
      if (input.glob) {
        const matches = globMatcher(input.glob);
        eligible = new Set();
        const allowed = eligible;
        if (info.isDirectory()) await listFiles(cwd, ctx.signal, matches, (rel) => (allowed.add(rel), true));
        else if (matches(path.basename(target.abs))) allowed.add(path.basename(target.abs));
      }
      const args = [
        "--no-config",
        "--json",
        "--hidden",
        "--sort",
        "path",
        input.case_sensitive === false ? "--ignore-case" : "--case-sensitive",
        ...(input.literal ? ["--fixed-strings"] : []),
        ...(input.glob ? ["--glob", input.glob] : []),
        ...EXCLUDE_GIT,
        "--regexp",
        input.pattern,
        "--",
        info.isDirectory() ? "." : path.basename(target.abs),
      ];
      items = [];
      const run = await runRipgrep(args, cwd, ctx.signal, (line) => {
        if (!line.startsWith('{"type":"match"')) return true;
        const event = JSON.parse(line) as { data: { path: { text?: string }; line_number: number; lines: { text?: string } } };
        const file = event.data.path.text;
        const text = event.data.lines.text;
        if (file === undefined || text === undefined) return true; // Not valid UTF-8; skipped like binary content.
        if (eligible && !eligible.has(file.replace(/^\.\//, "").split(path.sep).join("/"))) return true;
        items.push({ path: workspace.relative(path.resolve(cwd, file)), line_number: event.data.line_number, text: cutLine(text.replace(/\r?\n$/, ""), GREP_MAX_LINE_CHARS) });
        if (items.length >= MAX_COLLECTED_MATCHES) {
          capped = true;
          return false;
        }
        return true;
      });
      if (run.code === 2 && items.length === 0) {
        if (/regex parse error|error parsing|unclosed|unrecognized|look-around|backreferences/i.test(run.stderr)) {
          throw new ToolError(
            "invalid_pattern",
            `The regular expression is invalid: ${firstLines(run.stderr, 6)}`,
            "Fix the expression (Rust regex syntax, no lookaround or backreferences), or set literal: true to search for exact text.",
          );
        }
        if (run.stderr.trim()) throw new ToolError("search_failed", `The search failed: ${firstLines(run.stderr, 3)}`, "Check the path and glob, then retry.");
      }
    }
    const { out, nextCursor } = page(ctx, key, items, offset, limit, (m) => json(m));
    const result: Record<string, unknown> = { matches: out, returned: out.length, truncated: nextCursor !== null, next_cursor: nextCursor };
    if (capped) result.note = `Stopped collecting at ${MAX_COLLECTED_MATCHES} matches; narrow the pattern, path, or glob to see everything.`;
    return { content: json(result), result };
  },
};

function firstLines(text: string, n: number): string {
  return text.trim().split("\n").slice(0, n).join(" ").slice(0, 600);
}
