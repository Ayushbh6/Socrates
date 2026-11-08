/**
 * What a tool call returned, laid out to read (architecture/web.md, "Work and
 * answer"): a file as numbered code, a search as files with their matching
 * lines, a listing as files, command output as a terminal shows it, JSON
 * indented. Pure functions over the preview text the server sends.
 */

export type Layout =
  | { kind: "code"; path: string | null; range: string | null; language: string | null; lines: { n: number; text: string }[] }
  | { kind: "matches"; files: { path: string; hits: { n: number | null; text: string }[] }[] }
  | { kind: "files"; paths: string[] }
  | { kind: "terminal"; text: string; language: string | null; wrap: boolean }
  | { kind: "json"; text: string }
  | { kind: "text"; text: string };

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][0-9A-Za-z]|\u001b[=>]/g;

/** A terminal's colour and cursor codes taken out; carriage-return redraws kept to their last state. */
export function plainTerminal(text: string): string {
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((line) => {
      const parts = line.replace(/\r+$/, "").split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n");
}

/** Indented JSON, when the whole text is a JSON object or array; else null. */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!/^[[{]/.test(t) || !/[\]}]$/.test(t)) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

/** Whether most lines are JSON values on their own (a .jsonl file, a log). */
function jsonLines(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return false;
  let ok = 0;
  for (const l of lines) {
    const t = l.trim();
    if (/^[[{]/.test(t)) {
      try { JSON.parse(t); ok++; } catch { /* a cut-off line */ }
    }
  }
  return ok >= Math.ceil(lines.length * 0.6);
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", jsonl: "json",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  css: "css", scss: "scss", html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml",
  md: "markdown", mdx: "markdown", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
  sql: "sql", diff: "diff", patch: "diff", dockerfile: "dockerfile",
};

/** The highlighting language for a file, by its extension or name. */
export function languageOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const name = path.split("/").pop()!.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return LANGUAGES[ext] ?? null;
}

const READ_HEAD = /^(.+?) — lines? (\d+(?:–\d+)? of \d+)$/;
const NUMBERED = /^(\d+): ?(.*)$/;

/** A read's preview: "path — lines 1–40 of 615" then "1: …" per line. */
export function readLayout(preview: string, target: string | null): Layout | null {
  const rows = preview.split("\n");
  const head = READ_HEAD.exec(rows[0] ?? "");
  const body = head ? rows.slice(1) : rows;
  if (body.at(-1) === "…" || body.at(-1) === "") body.pop();
  const lines: { n: number; text: string }[] = [];
  for (const row of body) {
    const m = NUMBERED.exec(row);
    if (m) lines.push({ n: Number(m[1]), text: m[2]! });
    // The preview can end inside a line number; that piece is dropped.
    else if (row === body[body.length - 1] && /^\d*$/.test(row)) break;
    else return null;
  }
  if (!lines.length) return null;
  const path = head?.[1] ?? target;
  return { kind: "code", path: path ?? null, range: head ? `lines ${head[2]}` : null, language: languageOf(target ?? path), lines };
}

const MATCH = /^(.+?):(\d+): ?(.*)$/;
const COUNT = /^(.+?): (\d+)$/;

/** grep's preview: "path:12: text" per match, "path: 3" per count, or a path per line. */
export function matchLayout(preview: string): Layout {
  const rows = preview.split("\n").filter((r) => r.length && r !== "…");
  if (!rows.length) return { kind: "text", text: "" };
  if (rows.every((r) => MATCH.test(r))) {
    const files: { path: string; hits: { n: number | null; text: string }[] }[] = [];
    for (const r of rows) {
      const [, path, n, text] = MATCH.exec(r)!;
      const last = files[files.length - 1];
      const hit = { n: Number(n), text: text! };
      if (last && last.path === path) last.hits.push(hit);
      else files.push({ path: path!, hits: [hit] });
    }
    return { kind: "matches", files };
  }
  if (rows.every((r) => COUNT.test(r))) {
    return { kind: "matches", files: rows.map((r) => { const [, path, n] = COUNT.exec(r)!; return { path: path!, hits: [{ n: null, text: `${n} ${n === "1" ? "match" : "matches"}` }] }; }) };
  }
  return { kind: "files", paths: rows };
}

/** Lines this long read better wrapped than scrolled sideways (a minified file, one JSON record). */
export const WRAP_AT = 240;
const wraps = (text: string) => text.split("\n").some((l) => l.length > WRAP_AT);

/** How to show a call's preview, from the tool that made it. */
export function layoutOf(tool: string | undefined, kind: string, preview: string, target: string | null, failed: boolean): Layout {
  if (failed) return { kind: "text", text: preview };
  if (tool === "read" || (!tool && kind === "read")) return readLayout(preview, target) ?? { kind: "text", text: preview };
  if (tool === "glob") return { kind: "files", paths: preview.split("\n").filter((r) => r && r !== "…") };
  if (tool === "grep") return matchLayout(preview);
  if (kind === "terminal") {
    const text = plainTerminal(preview);
    const json = prettyJson(text);
    if (json) return { kind: "terminal", text: json, language: "json", wrap: false };
    // A .jsonl file or a JSON log: each whole record indented, a cut-off one as it came.
    if (jsonLines(text)) return { kind: "terminal", text: text.split("\n").map((l) => prettyJson(l) ?? l).join("\n"), language: "json", wrap: wraps(text) };
    // Output that starts like JSON but was cut off still reads better coloured.
    return { kind: "terminal", text, language: /^\s*[[{]"/.test(text) ? "json" : null, wrap: wraps(text) };
  }
  const json = prettyJson(preview);
  return json ? { kind: "json", text: json } : { kind: "text", text: preview };
}

/**
 * A call's whole recorded result laid out like its card, for "Open the full
 * output": a file as numbered code, matches under files, a listing, a
 * command's output as a terminal shows it with what it came to above.
 * Null for anything else (shown as tidy JSON or text, lib/evidence.ts).
 */
export function evidenceLayout(tool: string, content: string | null, target: string | null): { layout: Layout; facts: string[] } | null {
  if (content === null) return null;
  if (tool === "read") {
    const layout = readLayout(content, target);
    return layout ? { layout, facts: [] } : null;
  }
  let r: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    r = parsed as Record<string, unknown>;
  } catch {
    // A command's output kept as text (its saved log removed, say) still reads as a terminal.
    return tool === "terminal" || tool === "terminal_control" ? { layout: layoutOf("terminal", "terminal", content, null, false), facts: [] } : null;
  }
  if (tool === "glob" && Array.isArray(r.matches)) return { layout: { kind: "files", paths: r.matches.map(String) }, facts: r.truncated ? ["more files than listed"] : [] };
  if (tool === "grep") {
    if (Array.isArray(r.matches)) {
      const rows = (r.matches as { path?: string; line_number?: number; text?: string }[]).map((m) => `${m.path}:${m.line_number}: ${m.text ?? ""}`);
      return { layout: rows.length ? matchLayout(rows.join("\n")) : { kind: "text", text: "No matches." }, facts: [] };
    }
    if (Array.isArray(r.files)) return { layout: { kind: "files", paths: r.files.map(String) }, facts: [] };
    if (Array.isArray(r.counts)) return { layout: matchLayout((r.counts as { path: string; count: number }[]).map((c) => `${c.path}: ${c.count}`).join("\n")), facts: [] };
    return null;
  }
  if (tool === "terminal" || tool === "terminal_control") {
    const screen = typeof r.screen === "object" && r.screen !== null && typeof (r.screen as { text?: unknown }).text === "string" ? (r.screen as { text: string }).text : "";
    const output = screen || (typeof r.output === "string" ? r.output : null);
    if (output === null) return null;
    const facts = [
      typeof r.status === "string" ? r.status.replace(/_/g, " ") : null,
      typeof r.exit_code === "number" ? `exit ${r.exit_code}` : null,
      typeof r.signal === "string" && r.signal ? `stopped by ${r.signal}` : null,
      typeof r.output_lines === "number" ? `${r.output_lines} ${r.output_lines === 1 ? "line" : "lines"}` : null,
      screen ? "its screen" : null,
    ].filter((f): f is string => !!f);
    const layout = layoutOf("terminal", "terminal", output, null, false);
    return { layout: layout.kind === "terminal" && !layout.text.trim() ? { kind: "text", text: "No output." } : layout, facts };
  }
  return null;
}
