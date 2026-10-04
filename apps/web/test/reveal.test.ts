import { describe, expect, it } from "vitest";
import { FRAME_MS, cut, nextShown } from "../src/lib/reveal";

describe("letting text out", () => {
  it("shows a burst progressively and keeps pace with a trickle", () => {
    let shown = 0;
    let frames = 0;
    while (shown < 150) {
      const next = nextShown(shown, 150);
      expect(next).toBeGreaterThan(shown);
      shown = next;
      frames++;
    }
    expect(frames).toBeLessThan(70);
    // Early frames show a good part of the burst, later ones taper off.
    expect(nextShown(0, 150)).toBeGreaterThanOrEqual(12);
    expect(nextShown(148, 150)).toBe(149);
    // A trickle of one character at a time is shown as it comes.
    expect(nextShown(10, 11)).toBe(11);
    expect(nextShown(11, 11)).toBe(11);
    expect(nextShown(20, 11)).toBe(11);
  });

  it("follows time, not frames, so slow frames never leave the text behind", () => {
    const after = (frameMs: number, ms: number) => {
      let shown = 0;
      for (let t = 0; t < ms; t += frameMs) shown = nextShown(shown, 4_000, frameMs);
      return shown;
    };
    // Half a second at 60 frames a second or at 3 frames a second shows about the same amount.
    const smooth = after(FRAME_MS, 500);
    const slow = after(300, 500);
    expect(smooth).toBeGreaterThan(3_500);
    expect(slow).toBeGreaterThan(3_000);
    // A pause, such as a hidden tab, catches up at once rather than crawling.
    expect(nextShown(0, 4_000, 5_000)).toBeGreaterThan(3_900);
  });

  it("never cuts a character in two", () => {
    const text = "ab😀cd";
    expect(cut(text, 2)).toBe("ab");
    expect(cut(text, 3)).toBe("ab😀");
    expect(cut(text, 4)).toBe("ab😀");
    expect(cut(text, 99)).toBe(text);
    expect(cut(text, 0)).toBe("");
  });
});
