import { describe, expect, it } from "vitest";
import { encodeMonoPcm16Wav } from "./audio";

const ascii = (view: DataView, offset: number, length: number): string =>
  Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join("");

describe("encodeMonoPcm16Wav", () => {
  it("writes a valid mono 16-bit PCM WAV header and clamps samples", () => {
    const wav = encodeMonoPcm16Wav(new Float32Array([-2, -1, 0, 1, 2]), 48_000);
    const view = new DataView(wav);

    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(ascii(view, 36, 4)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(10);
    expect(view.getInt16(44, true)).toBe(-32_768);
    expect(view.getInt16(46, true)).toBe(-32_768);
    expect(view.getInt16(48, true)).toBe(0);
    expect(view.getInt16(50, true)).toBe(32_767);
    expect(view.getInt16(52, true)).toBe(32_767);
  });

  it("rejects an invalid microphone sample rate", () => {
    expect(() => encodeMonoPcm16Wav(new Float32Array([0]), 0)).toThrow("invalid sample rate");
  });
});
