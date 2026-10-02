import { createHash, randomBytes } from "node:crypto";
import { chmod, link, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
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
  eol: "\n" | "\r\n";
  bom: boolean;
  mode: number;
}

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
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new ToolError("binary_file", `${file.rel} is a binary file (${info.size} bytes).`, "Binary files cannot be read as text. Inspect it with a suitable terminal command if needed.", false);
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new ToolError("invalid_utf8", `${file.rel} is not valid UTF-8 text.`, "Inspect it with a terminal command such as file or iconv.", false);
  }
  const bom = decoded.startsWith("﻿");
  const raw = bom ? decoded.slice(1) : decoded;
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const lf = (raw.match(/\n/g) ?? []).length - crlf;
  return { text: raw.replace(/\r\n/g, "\n"), hash: hashBytes(bytes), eol: crlf > lf ? "\r\n" : "\n", bom, mode: info.mode & 0o7777 };
}

/** Encode normalized text with the file's original line endings and byte-order mark. */
export function encodeText(text: string, file: Pick<TextFile, "eol" | "bom">): string {
  const body = file.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
  return file.bom ? `﻿${body}` : body;
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
export async function writeAtomic(abs: string, content: string, mode?: number): Promise<void> {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.socrates-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, content, "utf8");
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
export async function writeNew(abs: string, content: string, mode?: number): Promise<boolean> {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.socrates-${randomBytes(4).toString("hex")}`);
  try {
    await writeFile(tmp, content, "utf8");
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
