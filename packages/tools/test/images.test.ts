import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IMAGE_MAX_BYTES, imageInfo } from "../src/images";
import { harness } from "./helpers";

const png = readFileSync(path.join(import.meta.dirname, "fixture-label.png"));

describe("image headers", () => {
  it("reads the format and size of PNG, GIF, JPEG and WebP images, and nothing else", () => {
    expect(imageInfo(png)).toEqual({ mediaType: "image/png", width: 400, height: 400 });
    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02]);
    expect(imageInfo(gif)).toEqual({ mediaType: "image/gif", width: 800, height: 600 });
    // SOI, an APP0 segment, then a baseline frame header: 0x0258 (600) high, 0x0320 (800) wide.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03]);
    expect(imageInfo(jpeg)).toEqual({ mediaType: "image/jpeg", width: 800, height: 600 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "latin1"); webp.write("WEBP", 8, "latin1"); webp.write("VP8X", 12, "latin1");
    webp.writeUIntLE(799, 24, 3); webp.writeUIntLE(599, 27, 3);
    expect(imageInfo(webp)).toEqual({ mediaType: "image/webp", width: 800, height: 600 });
    expect(imageInfo(Buffer.from("not an image at all, just text"))).toBeNull();
  });
});

describe("read on an image", () => {
  it("shows the image to a model that can see, records its hash, and stores no bytes", async () => {
    const h = harness({ files: { "shots/label.png": png } });
    const r = await h.call("read", { path: "shots/label.png" }, { vision: true });
    expect(r.isError).toBe(false);
    expect(r.content).toBe("shots/label.png — image, 400×400 PNG, 11 KB, shown below.");
    expect(r.images).toEqual([{ mediaType: "image/png", data: png.toString("base64") }]);
    const completed = h.store.listEvents({ type: "tool_completed" }).at(-1)!.payload as { result: unknown; observed: { hash: string }[]; content: string };
    expect(completed.result).toEqual({ path: "shots/label.png", image: { media_type: "image/png", width: 400, height: 400, bytes: png.length }, shown: true });
    expect(completed.observed[0]!.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(completed)).not.toContain(png.toString("base64").slice(0, 40));
  });

  it("tells a model that cannot see that the content is unknown, and shows it nothing", async () => {
    const h = harness({ files: { "label.png": png } });
    const r = await h.call("read", { path: "label.png" });
    expect(r.images).toBeUndefined();
    expect(r.content).toContain("cannot see images, so its content is unknown");
  });

  it("refuses an image too large to show, and a file that only looks like an image", async () => {
    const big = Buffer.concat([png, Buffer.alloc(IMAGE_MAX_BYTES)]);
    const h = harness({ files: { "big.png": big, "fake.jpg": "plain text\n" } });
    const tooLarge = await h.call("read", { path: "big.png" }, { vision: true });
    expect(tooLarge.json.error).toMatchObject({ code: "image_too_large" });
    expect(tooLarge.json.error.correction).toContain("sips -Z 1600");
    expect((await h.call("read", { path: "fake.jpg" }, { vision: true })).json.error.code).toBe("not_an_image");
  });
});
