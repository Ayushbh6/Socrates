/** At most this many images go with one message. */
export const IMAGES_MAX = 10;
/** Images are sent at most this many pixels on their longest side… */
const EDGE_MAX = 2000;
/** …and at most this large, which every provider accepts. */
const BYTES_MAX = 5 * 1024 * 1024;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/**
 * An image ready to attach: the file itself when it is small enough, or a
 * copy drawn at most 2,000 pixels on its longest side and under 5 MB (a PNG
 * stays a PNG when it fits, otherwise it becomes a JPEG).
 */
export async function prepareImage(file: File): Promise<Blob> {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error(`${file.name} is not a PNG, JPEG, GIF or WebP image.`);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, EDGE_MAX / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= BYTES_MAX) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = (type: string, quality?: number) => new Promise<Blob | null>((done) => canvas.toBlob(done, type, quality));
  let blob = file.type === "image/png" ? await encode("image/png") : null;
  if (!blob || blob.size > BYTES_MAX) blob = await encode("image/jpeg", 0.88);
  if (!blob || blob.size > BYTES_MAX) throw new Error(`${file.name} is too large to attach, even made smaller.`);
  return blob;
}
