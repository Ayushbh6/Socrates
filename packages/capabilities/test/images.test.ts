import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IMAGE_MAX_BYTES, MCP_IMAGES_MAX } from "@socrates/tools";
import { renderResult, resultImages } from "../src/mcp";

const png = readFileSync(path.join(import.meta.dirname, "../../tools/test/fixture-label.png"));
const block = (data: Buffer, mimeType = "image/png") => ({ type: "image" as const, data: data.toString("base64"), mimeType });
const result = (...content: unknown[]) => ({ content }) as Parameters<typeof resultImages>[0];

describe("images in an MCP result", () => {
  it("shows a screenshot to a model, as the bytes' own format, and still describes it in the text", () => {
    const r = result({ type: "text", text: "Took a screenshot." }, block(png));
    expect(resultImages(r)).toEqual([{ mediaType: "image/png", data: png.toString("base64") }]);
    expect(renderResult(r)).toBe(`Took a screenshot.\n[image image/png, about ${png.length} bytes]`);
    // The declared type may be wrong or missing; the bytes decide.
    expect(resultImages(result(block(png, "application/octet-stream")))[0]!.mediaType).toBe("image/png");
  });

  it("leaves out what is not an image a model accepts, what is too large, and what is past the limit", () => {
    expect(resultImages(result(block(Buffer.from("not an image at all, just text"))))).toEqual([]);
    const big = Buffer.concat([png, Buffer.alloc(IMAGE_MAX_BYTES)]);
    expect(resultImages(result(block(big)))).toEqual([]);
    expect(resultImages(result({ type: "audio", data: "AAAA", mimeType: "audio/wav" }, { type: "text", text: "hi" }))).toEqual([]);
    expect(resultImages(result(...Array.from({ length: MCP_IMAGES_MAX + 3 }, () => block(png))))).toHaveLength(MCP_IMAGES_MAX);
  });
});
