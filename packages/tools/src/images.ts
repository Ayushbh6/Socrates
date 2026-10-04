import type { ImageData } from "@socrates/contracts";

/** The largest image shown to a model; every vision provider accepts images up to this size. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** File endings read as images rather than text. */
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export interface ImageInfo {
  mediaType: ImageData["mediaType"];
  width: number;
  height: number;
}

/**
 * The format and pixel size of an image, read from its header, or null when
 * the bytes are not a PNG, JPEG, GIF or WebP image.
 */
export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) {
    return { mediaType: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b.toString("latin1", 0, 3) === "GIF") {
    return { mediaType: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8X") return { mediaType: "image/webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { mediaType: "image/webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === "VP8 ") return { mediaType: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the JPEG segments to the frame header, which holds the size.
    for (let at = 2; at + 9 < b.length; ) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mediaType: "image/jpeg", width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) };
      }
      at += 2 + b.readUInt16BE(at + 2);
    }
    return null;
  }
  return null;
}

/** A short description of an image: "1280×720 PNG, 45 KB". */
export function describeImage(info: ImageInfo, bytes: number): string {
  const kind = info.mediaType.slice("image/".length).toUpperCase();
  const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${info.width}×${info.height} ${kind}, ${size}`;
}
