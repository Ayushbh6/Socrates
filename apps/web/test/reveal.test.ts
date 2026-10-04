import { describe, expect, it } from "vitest";
import { cut, nextShown } from "../src/lib/reveal";

describe("letting text out", () => {
  it("catches up on a burst in a fifth of a second and keeps pace with a trickle", () => {
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

  it("never cuts a character in two", () => {
    const text = "ab😀cd";
    expect(cut(text, 2)).toBe("ab");
    expect(cut(text, 3)).toBe("ab😀");
    expect(cut(text, 4)).toBe("ab😀");
    expect(cut(text, 99)).toBe(text);
    expect(cut(text, 0)).toBe("");
  });
});
