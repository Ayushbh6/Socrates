import { createHash, randomBytes } from "node:crypto";
import { chmod, link, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { diffArrays } from "diff";
import { ToolError } from "./errors";
import type { ResolvedPath } from "./workspace";

/** Files larger than this are not loaded as text; grep and paged reads cover them. */
export const MAX_TEXT_FILE_BYTES = 20 * 1024 * 1024;

/** A decoded text file with the properties needed to write it back faithfully. */
export interface TextFile {
  /** Content with line endings normalized to "\n" and any byte-order mark removed. */
  text: string;
  /** Content hash of the exact bytes on disk. */
  hash: string;
  /** The most common line ending, used for new lines that replace none. */
  eol: "\n" | "\r\n";
  bom: boolean;
  mode: number;
  /** UTF-8, or UTF-16 recognised by its byte-order mark. */
  encoding: "utf8" | "utf16le" | "utf16be";
  /** The decoded content as it is, line endings included, when it mixes "\r\n" and "\n"; each line keeps its own. */
  mixed?: string;
}

/** How a file the tools create is written. */
export const NEW_FILE: Pick<TextFile, "eol" | "bom" | "encoding"> = { eol: "\n", bom: false, encoding: "utf8" };

export function hashBytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/**
 * Read one UTF-8 text file. Directories, missing files, binary content and
 * invalid UTF-8 fail with corrective errors instead of returning damaged text.
 */
export async function readTextFile(file: ResolvedPath): Promise<TextFile> {
  const info = await statOrNull(file.abs);
  if (!info) throw await notFound(file);
  if (info.isDirectory()) throw new ToolError("is_directory", `${file.rel} is a directory.`, `Use glob with path "${file.rel}" to list its files.`);
  if (!info.isFile()) throw new ToolError("not_a_file", `${file.rel} is not a regular file.`, "Read a regular text file.", false);
  if (info.size > MAX_TEXT_FILE_BYTES) {
    throw new ToolError("file_too_large", `${file.rel} is ${info.size} bytes, above the ${MAX_TEXT_FILE_BYTES}-byte text limit.`, "Use grep to find the relevant lines, or terminal tools such as head or sed for a slice.", false);
  }
  const bytes = await readFile(file.abs);
  // UTF-16 is recognised by its byte-order mark; without one, its zero bytes make it look binary.
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf16be" : "utf8";
  if (encoding === "utf8" && bytes.subarray(0, 8192).includes(0)) {
    throw new ToolError("binary_file", `${file.rel} is a binary file (${info.size} bytes).`, "Binary files cannot be read as text. Inspect it with a suitable terminal command if needed.", false);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder(encoding === "utf8" ? "utf-8" : encoding === "utf16le" ? "utf-16le" : "utf-16be", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ToolError(encoding === "utf8" ? "invalid_utf8" : "invalid_utf16", `${file.rel} is not valid ${encoding === "utf8" ? "UTF-8" : "UTF-16"} text.`, "Inspect it with a terminal command such as file or iconv.", false);
  }
  const bom = decoded.startsWith("\uFEFF");
  const raw = bom ? decoded.slice(1) : decoded;
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const lf = (raw.match(/\n/g) ?? []).length - crlf;
  return { text: raw.replace(/\r\n/g, "\n"), hash: hashBytes(bytes), eol: crlf > lf ? "\r\n" : "\n", bom, mode: info.mode & 0o7777, encoding, ...(crlf && lf ? { mixed: raw } : {}) };
}

/**
 * Encode normalized text the way the file was: its encoding, byte-order mark
 * and line endings. A file that mixes "\r\n" and "\n" keeps each unchanged
 * line's own ending; a changed line takes the ending of the line it replaces.
 */
export function encodeText(text: string, file: Pick<TextFile, "eol" | "bom" | "encoding" | "text" | "mixed"> | Pick<TextFile, "eol" | "bom" | "encoding">): Buffer {
  const mixed = "mixed" in file && file.mixed !== undefined ? file.mixed : null;
  const body = mixed !== null ? restoreEndings(mixed, text, file.eol) : file.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
  const full = file.bom ? `\uFEFF${body}` : body;
  if (file.encoding === "utf8") return Buffer.from(full, "utf8");
  const le = Buffer.from(full, "utf16le");
  return file.encoding === "utf16le" ? le : le.swap16();
}

/**
 * Give normalized text the line endings of `raw`, the content it was derived
 * from by an edit: unchanged lines keep their ending, replacing lines take
 * those of the lines they replace in order, and other new lines take the
 * ending of the line before them (or `fallback`).
 */
export function restoreEndings(raw: string, text: string, fallback: "\n" | "\r\n"): string {
  const before = raw.split(/(?<=\n)/).filter(Boolean).map((line) => ({ content: line.replace(/\r?\n$/, ""), end: line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "" }));
  const after = text.split(/(?<=\n)/).filter(Boolean).map((line) => ({ content: line.replace(/\n$/, ""), ended: line.endsWith("\n") }));
  const out: string[] = [];
  let b = 0;
  let a = 0;
  let last: string = fallback;
  // Endings of the lines that the next added lines replace.
  let replaced: string[] = [];
  for (const part of diffArrays(before.map((l) => l.content), after.map((l) => l.content))) {
    const n = part.value.length;
    if (part.removed) {
      replaced = before.slice(b, b + n).map((l) => l.end).filter(Boolean);
      b += n;
      continue;
    }
    for (let i = 0; i < n; i++) {
      const line = after[a++]!;
      const end = part.added ? (replaced[i] ?? replaced.at(-1) ?? last) : (before[b++]!.end || last);
      out.push(line.ended ? line.content + end : line.content);
      if (line.ended) last = end;
    }
    replaced = [];
  }
  return out.join("");
}

/** Hash of the file currently on disk, or null when it does not exist. */
export async function currentHash(abs: string): Promise<string | null> {
  try {
    return hashBytes(await readFile(abs));
  } catch {
    return null;
  }
}

/** Write through a temporary sibling and rename, so readers never see a half-written file. */
export async function writeAtomic(abs: string, content: string | Uint8Array, mode?: number): Promise<void> {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.socrates-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, content);
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, abs);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/**
 * Create a file that must not exist yet. The content is written to a
 * temporary sibling and hard-linked into place, which fails instead of
 * overwriting if something appeared at the path in the meantime.
 */
export async function writeNew(abs: string, content: string | Uint8Array, mode?: number): Promise<boolean> {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.socrates-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, content);
    if (mode !== undefined) await chmod(tmp, mode);
    await link(tmp, abs);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

export async function statOrNull(abs: string) {
  try {
    return await stat(abs);
  } catch {
    return null;
  }
}

/** Split normalized text into lines; a final newline does not create an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** A missing-file error that names close matches in the same directory. */
export async function notFound(file: ResolvedPath): Promise<ToolError> {
  const dir = path.dirname(file.abs);
  const base = path.basename(file.abs).toLowerCase();
  let suggestions: string[] = [];
  try {
    const names = await readdir(dir);
    suggestions = names
      .map((name) => ({ name, score: similarity(base, name.toLowerCase()) }))
      .filter((c) => c.score >= 0.6)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((c) => path.posix.join(path.posix.dirname(file.rel), c.name));
  } catch {
    // The directory itself is missing; no suggestions.
  }
  return new ToolError(
    "file_not_found",
    `${file.rel} does not exist.${suggestions.length ? ` Similar: ${suggestions.join(", ")}.` : ""}`,
    suggestions.length ? "Use one of the similar paths, or glob to find the file." : "Use glob to find the file, for example pattern **/" + path.basename(file.abs) + ".",
  );
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (b.startsWith(a) || a.startsWith(b)) return 0.8;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}
