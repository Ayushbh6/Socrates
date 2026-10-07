import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Pseudo-terminals for interactive programs (agent-harness.md, "terminal").
 * node-pty is a native module: it is loaded on first use, and a machine where
 * it cannot load keeps pipe sessions and reports `pty_unavailable`.
 */

type PtyModule = typeof import("node-pty");
let loaded: PtyModule | null | undefined;

export function loadPty(): PtyModule | null {
  if (loaded !== undefined) return loaded;
  try {
    const require = createRequire(import.meta.url);
    const mod = require("node-pty") as PtyModule;
    // The prebuilt spawn-helper is published without its executable bit, and
    // every spawn fails ("posix_spawnp failed") until it has one.
    const root = path.dirname(require.resolve("node-pty/package.json"));
    for (const dir of [path.join(root, "prebuilds", `${process.platform}-${process.arch}`), path.join(root, "build", "Release")]) {
      const helper = path.join(dir, "spawn-helper");
      if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
    }
    loaded = mod;
  } catch {
    loaded = null;
  }
  return loaded;
}

/** The bytes a terminal sends for each named key. */
export const KEY_BYTES: Record<string, string> = {
  ENTER: "\r",
  TAB: "\t",
  ESCAPE: "\x1b",
  BACKSPACE: "\x7f",
  DELETE: "\x1b[3~",
  UP: "\x1b[A",
  DOWN: "\x1b[B",
  RIGHT: "\x1b[C",
  LEFT: "\x1b[D",
  HOME: "\x1b[H",
  END: "\x1b[F",
  PAGE_UP: "\x1b[5~",
  PAGE_DOWN: "\x1b[6~",
  CTRL_C: "\x03",
  CTRL_D: "\x04",
  CTRL_L: "\x0c",
  CTRL_Z: "\x1a",
};

/** A complete escape sequence at the start of the text: CSI, OSC, character-set, or a two-character escape. */
const ESCAPE = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[@-Z\\-_=>78])/;
/** Erase line, or go to a column: what a progress line does before it is drawn again. */
const REWRITE = /^\x1b\[(?:[0-2]?K|\d*G)$/;
/** What does not change what a redrawn line says: spinner glyphs and punctuation, but not the marks that say it worked or failed. */
const NOT_MEANING = /[^\p{L}\p{N}✔✓✖✗✘×⚠]+/gu;
/** Stands for a redraw boundary while a chunk is cleaned. */
const REDRAW = "\x1f";
const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[()][0-9A-Za-z]|[@-Z\\-_=>78])/g;
/** A sequence longer than this without its end is not one; its ESC is dropped. */
const ESCAPE_MAX = 64;

/**
 * A terminal's output as plain text for the agent: colours and cursor
 * movement removed, "\r\n" and a lone "\r" (a redrawn progress line) as line
 * breaks, backspaces applied. A sequence split between two chunks waits for
 * its end, so nothing is half-removed.
 */
export class TerminalText {
  private carry = "";
  /** The last emitted text ended a line (or nothing was emitted yet). */
  private atStart = true;
  /** What the last redrawn line said, without punctuation or spinner glyphs. */
  private lastKey = "";

  push(chunk: string): string {
    let text = this.carry + chunk;
    this.carry = "";
    const esc = text.lastIndexOf("\x1b");
    if (esc >= 0 && text.length - esc < ESCAPE_MAX && !ESCAPE.test(text.slice(esc))) {
      this.carry = text.slice(esc);
      text = text.slice(0, esc);
    }
    // "\r" may be the first half of "\r\n" in the next chunk.
    if (text.endsWith("\r")) {
      this.carry = `\r${this.carry}`;
      text = text.slice(0, -1);
    }
    // Erasing the line or going to column 1 rewrites the line, as a carriage return does.
    text = text.replace(ESCAPES, (sequence) => (REWRITE.test(sequence) ? REDRAW : "")).replace(/\x1b/g, "").replace(/\r*\n/g, "\n").replace(/\r/g, REDRAW);
    while (/[^\n\x08]\x08/.test(text)) text = text.replace(/[^\n\x08]\x08/g, "");
    text = text.replace(/[\x00-\x08\x0b-\x1e\x7f]/g, "");
    const out = this.lines(text);
    if (out) this.atStart = out.endsWith("\n");
    return out;
  }

  /**
   * Redraws of one line (a spinner, a progress bar) each begin a line; a
   * redraw that says the same as the line before, apart from its symbols,
   * adds nothing.
   */
  private lines(text: string): string {
    const pieces = text.split(REDRAW);
    let out = pieces[0] ?? "";
    // The line being redrawn is the unfinished one before the first redraw.
    if (pieces.length > 1 && out && !out.endsWith("\n")) this.lastKey = out.slice(out.lastIndexOf("\n") + 1).replace(NOT_MEANING, "");
    for (const piece of pieces.slice(1)) {
      if (!piece) continue;
      const key = piece.replace(NOT_MEANING, "");
      const same = key !== "" && key === this.lastKey;
      this.lastKey = key;
      if (same) continue;
      const startsLine = out === "" ? this.atStart : out.endsWith("\n");
      out += (startsLine ? "" : "\n") + piece;
    }
    // Text on its own line after a newline is never a redraw of the line before it.
    if (pieces.length === 1 && out.includes("\n")) this.lastKey = "";
    return out;
  }

  /** What is still held back when the process ends. */
  flush(): string {
    const rest = this.carry.replace(ESCAPES, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
    this.carry = "";
    return rest;
  }
}
