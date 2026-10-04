import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { continueTask } from "../../router/test/helpers";
import { call, contextText, final, world } from "./helpers";

const png = readFileSync(path.join(import.meta.dirname, "../../tools/test/fixture-label.png"));

describe("images in a turn", () => {
  it("shows an image read in this turn to a model that can see, and only text about it later", async () => {
    const w = await world({ files: { "label.png": png } });
    const { socrates, model } = w.socrates([continueTask(), continueTask()], [
      { toolCalls: [call("read", { path: "label.png" })] },
      final({ full_answer: "It says ORCHID." }),
      final({ full_answer: "The label said ORCHID." }),
    ]);
    model.vision = true;
    await socrates.handle("What does label.png say?");
    const result = model.requests[1]!.messages.at(-1)!;
    expect(result).toMatchObject({ role: "tool", content: "label.png — image, 400×400 PNG, 11 KB, shown below.", images: [{ mediaType: "image/png", data: png.toString("base64") }] });

    // A later turn sees what was read, as text; it reads the file again to look.
    await socrates.handle("And what did it say?");
    const later = model.requests[2]!;
    expect(contextText(later)).toContain("label.png — image, 400×400 PNG");
    expect(JSON.stringify(later.messages)).not.toContain(png.toString("base64").slice(0, 40));
  });

  it("never sends an image to a model that cannot see", async () => {
    const w = await world({ files: { "label.png": png } });
    const { socrates, model } = w.socrates([continueTask()], [{ toolCalls: [call("read", { path: "label.png" })] }, final()]);
    await socrates.handle("What does label.png say?");
    const result = model.requests[1]!.messages.at(-1)!;
    expect(result).not.toHaveProperty("images");
    expect(result.content).toContain("cannot see images");
  });
});
