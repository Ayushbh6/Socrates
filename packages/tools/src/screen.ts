import xterm from "@xterm/headless";

const { Terminal } = xterm;

/** What a program has drawn on its terminal right now, as the agent reads it. */
export interface ScreenSnapshot {
  cols: number;
  rows: number;
  /** The visible lines, without trailing spaces and with trailing blank lines left off. */
  lines: string[];
  /** Where the cursor is (0-based), and whether the program shows it; menus hide it while they wait. */
  cursor: { row: number; col: number; visible: boolean };
  /** Lines drawn as a selection: in reverse video, in a colour no sibling line has, or behind a pointer such as ❯ . */
  highlighted: string[];
  /** A full-screen program (an editor, a TUI) is running. */
  fullscreen: boolean;
}

/** A selection marker an option list draws before the chosen line. */
const POINTER = /^\s*(?:❯|›|▶|▸|➤|→|>|●|◉|◆|■|\[x\]|\(•\)|\(\*\))\s+\S/;

/**
 * The screen of one pseudo-terminal: the same bytes the program writes are fed
 * to a terminal emulator, so cursor movement, redraws and erasing end up as
 * what a person would see. This is what lets the agent read a menu that is
 * redrawn on every arrow key (a list of frameworks, a checkbox list, a
 * confirmation) and tell which option is selected now, which the plain-text
 * stream of redraws cannot say.
 */
export class Screen {
  private readonly terminal: InstanceType<typeof Terminal>;
  /** The program has hidden the cursor (DECTCEM). */
  cursorVisible = true;

  constructor(cols: number, rows: number) {
    this.terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  }

  write(chunk: string): void {
    const hide = chunk.lastIndexOf("\x1b[?25l");
    const show = chunk.lastIndexOf("\x1b[?25h");
    if (hide >= 0 || show >= 0) this.cursorVisible = show > hide;
    this.terminal.write(chunk);
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  dispose(): void {
    this.terminal.dispose();
  }

  /** The screen as it is once everything written so far has been drawn. */
  async snapshot(): Promise<ScreenSnapshot> {
    await new Promise<void>((done) => this.terminal.write("", done));
    const buffer = this.terminal.buffer.active;
    const cell = buffer.getNullCell();
    const lines: string[] = [];
    const inverse: boolean[] = [];
    const colour: (number | null)[] = [];
    for (let y = 0; y < this.terminal.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      lines.push(line?.translateToString(true) ?? "");
      let reverse = false;
      let fg: number | null = null;
      for (let x = 0; line && x < this.terminal.cols; x++) {
        const c = line.getCell(x, cell);
        if (!c || !c.getChars().trim()) continue;
        if (c.isInverse()) reverse = true;
        if (!c.isFgDefault() && fg === null) fg = c.getFgColor();
      }
      inverse.push(reverse);
      colour.push(fg);
    }
    let last = lines.length;
    while (last > 0 && !lines[last - 1]) last--;
    const shown = lines.slice(0, last);
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      lines: shown,
      cursor: { row: buffer.cursorY, col: buffer.cursorX, visible: this.cursorVisible },
      highlighted: highlighted(shown, inverse, colour),
      fullscreen: buffer.type === "alternate",
    };
  }
}

/** The lines that look selected: reverse video; a colour only one line of a block has; a pointer glyph on one line of several. */
function highlighted(lines: string[], inverse: boolean[], colour: (number | null)[]): string[] {
  const out = new Set<number>();
  inverse.forEach((on, i) => on && lines[i] && out.add(i));
  // A run of consecutive lines is one list; within it, one line drawn unlike the rest is the selected one.
  let start = 0;
  while (start < lines.length) {
    if (!lines[start]) { start++; continue; }
    let end = start;
    while (end + 1 < lines.length && lines[end + 1]) end++;
    const block = Array.from({ length: end - start + 1 }, (_, k) => start + k);
    if (block.length >= 3) {
      const coloured = block.filter((i) => colour[i] !== null);
      if (coloured.length === 1) out.add(coloured[0]!);
      const pointed = block.filter((i) => POINTER.test(lines[i]!));
      if (pointed.length === 1) out.add(pointed[0]!);
    }
    start = end + 1;
  }
  return [...out].sort((a, b) => a - b).map((i) => lines[i]!.trim());
}

/** The snapshot as text for a model: the screen as drawn, and what stands out on it. */
export function renderScreen(s: ScreenSnapshot): { text: string; cursor: ScreenSnapshot["cursor"]; highlighted: string[]; fullscreen: boolean } {
  return { text: s.lines.join("\n"), cursor: s.cursor, highlighted: s.highlighted, fullscreen: s.fullscreen };
}
