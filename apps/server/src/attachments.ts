import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Attachment } from "@socrates/contracts";
import { IMAGE_MAX_BYTES, imageInfo } from "@socrates/tools";

/** At most this many images go with one message. */
export const ATTACHMENTS_MAX = 10;
const NAME_MAX_CHARS = 200;
const EXTENSIONS: Record<Attachment["media_type"], string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" };
const ID = /^[0-9a-f]{32}$/;

export class AttachmentError extends Error {
  override name = "AttachmentError";
}

/** What a page sees of an attachment: everything but where it is stored. */
export type AttachmentView = Omit<Attachment, "path">;

export const viewOf = ({ path: _path, ...view }: Attachment): AttachmentView => view;

/**
 * Store an image the user attached (architecture/server.md, "Attachments"):
 * a PNG, JPEG, GIF or WebP image up to 5 MB, under its content hash, so the
 * same image is stored once. The name is the user's, cleaned for display.
 */
export function storeAttachment(dir: string, bytes: Buffer, name: string): Attachment {
  if (bytes.length > IMAGE_MAX_BYTES) throw new AttachmentError(`The image is ${bytes.length} bytes; at most ${IMAGE_MAX_BYTES} can be attached.`);
  const info = imageInfo(bytes);
  if (!info) throw new AttachmentError("Attach a PNG, JPEG, GIF or WebP image.");
  const id = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${id}${EXTENSIONS[info.mediaType]}`);
  if (!existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, file);
  }
  return { id, name: cleanName(name), path: file, media_type: info.mediaType, width: info.width, height: info.height, bytes: bytes.length };
}

/** A stored attachment by its id, with the name the page gave it; null when there is none. */
export function findAttachment(dir: string, id: string, name = "image"): Attachment | null {
  if (!ID.test(id) || !existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => f.startsWith(`${id}.`) && !f.endsWith(".tmp"));
  if (!file) return null;
  const bytes = readFileSync(path.join(dir, file));
  const info = imageInfo(bytes);
  return info ? { id, name: cleanName(name), path: path.join(dir, file), media_type: info.mediaType, width: info.width, height: info.height, bytes: bytes.length } : null;
}

function cleanName(name: string): string {
  // Only the last part of a path, with no control characters.
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return base.slice(0, NAME_MAX_CHARS) || "image";
}
