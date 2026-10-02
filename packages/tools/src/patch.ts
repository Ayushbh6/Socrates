import { ToolError } from "./errors";
import { normalizePunctuation } from "./match";

/**
 * The apply_patch format (agent-harness.md, "apply_patch"): the grammar
 * coding models are trained on.
 *
 *   *** Begin Patch
 *   *** Add File: path          followed by "+" lines
 *   *** Delete File: path
 *   *** Update File: path
 *   *** Move to: path           optional, directly after Update File
 *   @@ optional context line    starts a chunk
 *    context / -removed / +added lines
 *   *** End of File             optional: the chunk ends at end of file
 *   *** End Patch
 *
 * Parsing is lenient where it is unambiguous: a shell heredoc wrapper and
 * whitespace around markers are tolerated, and a blank line inside a chunk is
 * an empty context line.
 */

export interface PatchChunk {
  context: string | null;
  oldLines: string[];
  newLines: string[];
  endOfFile: boolean;
}

export type PatchHunk =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo: string | null; chunks: PatchChunk[] };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File:";
const DELETE = "*** Delete File:";
const UPDATE = "*** Update File:";
const MOVE = "*** Move to:";
const EOF_MARKER = "*** End of File";

export const PATCH_FORMAT_HINT =
  'Send one patch: "*** Begin Patch", then for each file "*** Add File: path" with "+" lines, "*** Delete File: path", or "*** Update File: path" with chunks that start with "@@" and use " " (context), "-" (remove), "+" (add) line prefixes, then "*** End Patch".';

function invalid(message: string, line?: number): ToolError {
  return new ToolError("invalid_patch", line === undefined ? message : `Line ${line}: ${message}`, PATCH_FORMAT_HINT);
}

export function parsePatch(text: string): PatchHunk[] {
  let lines = text.replace(/\r\n/g, "\n").split("\n");
  // Tolerate a heredoc wrapper such as: apply_patch <<'EOF' ... EOF
  const heredoc = /^(?:\S+\s+)?<<-?\s*['"]?([A-Za-z_]+)['"]?\s*$/.exec(lines[0]?.trim() ?? "");
  if (heredoc) {
    lines = lines.slice(1);
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    if (lines[lines.length - 1]?.trim() === heredoc[1]) lines.pop();
  }
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines[0]?.trim() !== BEGIN) throw invalid(`The patch must start with "${BEGIN}".`, 1);
  if (lines[lines.length - 1]?.trim() !== END) throw invalid(`The patch must end with "${END}".`, lines.length);

  const hunks: PatchHunk[] = [];
  let i = 1;
  const last = lines.length - 1;
  const header = (line: string, marker: string) => (line.trim().startsWith(marker) ? line.trim().slice(marker.length).trim() : null);

  while (i < last) {
    const line = lines[i]!;
    const lineNo = i + 1;
    let path: string | null;
    if ((path = header(line, ADD)) !== null) {
      if (!path) throw invalid("Add File needs a path.", lineNo);
      i++;
      const body: string[] = [];
      while (i < last && !lines[i]!.trim().startsWith("*** ")) {
        const l = lines[i]!;
        if (!l.startsWith("+")) throw invalid(`Every line of an added file starts with "+"; got ${JSON.stringify(l.slice(0, 40))}.`, i + 1);
        body.push(l.slice(1));
        i++;
      }
      hunks.push({ kind: "add", path, lines: body });
    } else if ((path = header(line, DELETE)) !== null) {
      if (!path) throw invalid("Delete File needs a path.", lineNo);
      hunks.push({ kind: "delete", path });
      i++;
    } else if ((path = header(line, UPDATE)) !== null) {
      if (!path) throw invalid("Update File needs a path.", lineNo);
      i++;
      let moveTo: string | null = null;
      const move = i < last ? header(lines[i]!, MOVE) : null;
      if (move !== null) {
        if (!move) throw invalid("Move to needs a path.", i + 1);
        moveTo = move;
        i++;
      }
      const chunks: PatchChunk[] = [];
      let chunk: PatchChunk | null = null;
      while (i < last) {
        const l = lines[i]!;
        const t = l.trim();
        if (t === EOF_MARKER) {
          if (!chunk) throw invalid(`"${EOF_MARKER}" must follow a chunk.`, i + 1);
          chunk.endOfFile = true;
          i++;
          continue;
        }
        if (t.startsWith("*** ")) break;
        if (t === "@@" || t.startsWith("@@ ")) {
          chunk = { context: t === "@@" ? null : t.slice(3), oldLines: [], newLines: [], endOfFile: false };
          chunks.push(chunk);
          i++;
          continue;
        }
        if (!chunk) {
          // The first chunk may omit its "@@" line.
          chunk = { context: null, oldLines: [], newLines: [], endOfFile: false };
          chunks.push(chunk);
        }
        if (chunk.endOfFile) throw invalid(`No lines may follow "${EOF_MARKER}" inside a chunk.`, i + 1);
        if (l === "") (chunk.oldLines.push(""), chunk.newLines.push(""));
        else if (l[0] === " ") (chunk.oldLines.push(l.slice(1)), chunk.newLines.push(l.slice(1)));
        else if (l[0] === "-") chunk.oldLines.push(l.slice(1));
        else if (l[0] === "+") chunk.newLines.push(l.slice(1));
        else throw invalid(`Chunk lines start with " ", "-", or "+"; got ${JSON.stringify(l.slice(0, 40))}.`, i + 1);
        i++;
      }
      if (!chunks.some((c) => c.oldLines.length || c.newLines.length) && !moveTo) throw invalid(`Update File ${path} has no changes.`, lineNo);
      hunks.push({ kind: "update", path, moveTo, chunks: chunks.filter((c) => c.oldLines.length || c.newLines.length) });
    } else {
      throw invalid(`Expected "${ADD} path", "${DELETE} path", or "${UPDATE} path"; got ${JSON.stringify(line.slice(0, 60))}.`, lineNo);
    }
  }
  if (!hunks.length) throw invalid("The patch contains no file operations.");
  return hunks;
}

/**
 * Find `pattern` in `lines` at or after `start`, trying exact equality, then
 * ignoring trailing whitespace, then surrounding whitespace, then typographic
 * punctuation. With `eof`, a match ending at the last line is preferred.
 */
export function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return -1;
  const norms = [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim(), (s: string) => normalizePunctuation(s.trim())];
  const from = eof ? Math.max(start, lines.length - pattern.length) : start;
  for (const norm of norms) {
    for (const begin of eof ? [from, start] : [start]) {
      for (let i = begin; i + pattern.length <= lines.length; i++) {
        let ok = true;
        for (let j = 0; j < pattern.length; j++) {
          if (norm(lines[i + j]!) !== norm(pattern[j]!)) {
            ok = false;
            break;
          }
        }
        if (ok) return i;
      }
    }
  }
  return -1;
}

/** Apply update chunks to normalized text; fails with the first chunk whose context is not found. */
export function applyChunks(path: string, text: string, chunks: PatchChunk[]): string {
  const trailingNewline = text === "" || text.endsWith("\n");
  const lines = text === "" ? [] : (trailingNewline ? text.slice(0, -1) : text).split("\n");
  const replacements: { at: number; remove: number; insert: string[] }[] = [];
  let cursor = 0;
  chunks.forEach((chunk, n) => {
    if (chunk.context !== null) {
      const at = seekSequence(lines, [chunk.context], cursor, false);
      if (at < 0) throw stale(path, n, `the context line ${JSON.stringify(chunk.context)}`);
      cursor = at + 1;
    }
    if (chunk.oldLines.length === 0) {
      replacements.push({ at: lines.length, remove: 0, insert: chunk.newLines });
      return;
    }
    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let at = seekSequence(lines, oldLines, cursor, chunk.endOfFile);
    if (at < 0 && oldLines[oldLines.length - 1] === "") {
      // A trailing empty line in the chunk often stands for the file's final newline.
      oldLines = oldLines.slice(0, -1);
      if (newLines[newLines.length - 1] === "") newLines = newLines.slice(0, -1);
      at = seekSequence(lines, oldLines, cursor, chunk.endOfFile);
    }
    if (at < 0) throw stale(path, n, `the lines starting ${JSON.stringify(chunk.oldLines.find((l) => l.trim()) ?? "")}`);
    replacements.push({ at, remove: oldLines.length, insert: newLines });
    cursor = at + oldLines.length;
  });
  for (const r of [...replacements].sort((a, b) => b.at - a.at)) lines.splice(r.at, r.remove, ...r.insert);
  if (lines.length === 0) return "";
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

function stale(path: string, chunk: number, what: string): ToolError {
  return new ToolError(
    "patch_context_not_found",
    `Chunk ${chunk + 1} for ${path} does not match the file: ${what} could not be found after the previous chunk.`,
    `Read ${path} again and rebuild the chunk from its current lines, with chunks in file order.`,
  );
}
