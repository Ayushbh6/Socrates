import { describe, expect, it } from "vitest";
import { VOICE_LEVEL, WAV_RATE, appendSpoken, clock, encodeWav, level, resample } from "../src/lib/voice";

const tone = (amplitude: number, n = 800) => Float32Array.from({ length: n }, (_, i) => amplitude * Math.sin(i / 3));

describe("voice", () => {
  it("keeps a quiet room under the voice line and lets speech rise above it", () => {
    expect(level(new Float32Array(0))).toBe(0);
    expect(level(tone(0.004))).toBeLessThan(VOICE_LEVEL);
    expect(level(tone(0.15))).toBeGreaterThan(0.6);
    expect(level(tone(1))).toBeLessThanOrEqual(1);
  });

  it("brings 48 kHz down to 16 kHz, keeping the shape", () => {
    const ramp = Float32Array.from({ length: 4800 }, (_, i) => i / 4800);
    const out = resample(ramp, 48_000, WAV_RATE);
    expect(out.length).toBe(1600);
    expect(out[800]).toBeCloseTo(0.5, 2);
    expect(resample(ramp, 16_000, 16_000)).toBe(ramp);
  });

  it("writes mono 16-bit WAV with a correct header, clipping what is too loud", async () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2]), WAV_RATE);
    expect(wav.type).toBe("audio/wav");
    const view = new DataView(await wav.arrayBuffer());
    const text = (at: number) => String.fromCharCode(...new Uint8Array(view.buffer, at, 4));
    expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(8);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
  });

  it("puts speech after what is typed, with one space", () => {
    expect(appendSpoken("", " Hello there. ")).toBe("Hello there.");
    expect(appendSpoken("Fix the tests", "and then commit.")).toBe("Fix the tests and then commit.");
    expect(appendSpoken("Fix the tests\n", "Then commit.")).toBe("Fix the tests\nThen commit.");
    expect(appendSpoken("typed", "  ")).toBe("typed");
  });

  it("shows minutes and seconds", () => {
    expect(clock(7.9)).toBe("0:07");
    expect(clock(83)).toBe("1:23");
  });
});
