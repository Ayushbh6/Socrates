import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { continueTask } from "../../router/test/helpers";
import { call, contextText, final, tempDir, world } from "./helpers";

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

describe("attached images", () => {
  async function attached() {
    const w = await world({ files: { "notes.md": "x\n" } });
    const folder = path.join(tempDir(), "attachments");
    mkdirSync(folder);
    const file = path.join(folder, "0123456789abcdef0123456789abcdef.png");
    writeFileSync(file, png);
    writeFileSync(path.join(folder, "..", "secret.txt"), "not for tools\n");
    const attachment = { id: "0123456789abcdef0123456789abcdef", name: "label.png", path: file, media_type: "image/png" as const, width: 400, height: 400, bytes: png.length };
    return { w, folder, file, attachment };
  }

  it("saves them with the message, shows them to a model that can see, and names their paths", async () => {
    const { w, folder, file, attachment } = await attached();
    const { socrates, model } = w.socrates([continueTask()], [final({ full_answer: "It says ORCHID." })], { attachments: folder });
    model.vision = true;
    await socrates.handle("What does this say?", { attachments: [attachment] });
    const event = w.store.listEvents({ type: "user_message" }).at(-1)!;
    expect(event.payload).toMatchObject({ text: "What does this say?", attachments: [attachment] });
    const first = model.requests[0]!.messages[0]!;
    expect(first).toMatchObject({ role: "user", images: [{ mediaType: "image/png", data: png.toString("base64") }] });
    expect(contextText(model.requests[0]!)).toContain(`What does this say?\n[The user attached an image. They are shown with this message; read one by its path to look again later.]\n1. ${file} — "label.png", 400×400 PNG`);
  });

  it("names them to a model that cannot see, and sends it nothing", async () => {
    const { w, folder, attachment } = await attached();
    const { socrates, model } = w.socrates([continueTask()], [final()], { attachments: folder });
    await socrates.handle("What does this say?", { attachments: [attachment] });
    expect(model.requests[0]!.messages[0]).not.toHaveProperty("images");
    expect(contextText(model.requests[0]!)).toContain("The current model cannot see images: only their names and sizes are known.");
  });

  it("keeps the path in later turns, so the image can be read again from there, and only the image", async () => {
    const { w, folder, file, attachment } = await attached();
    const { socrates, model } = w.socrates([continueTask(), continueTask()], [
      final({ full_answer: "Noted." }),
      { toolCalls: [call("read", { path: file }), call("read", { path: path.join(folder, "..", "secret.txt") })] },
      final({ full_answer: "It said ORCHID." }),
    ], { attachments: folder });
    model.vision = true;
    await socrates.handle("Keep this label in mind.", { attachments: [attachment] });
    await socrates.handle("What did the label I sent earlier say?");
    const later = model.requests[1]!;
    expect(later.messages[0]).not.toHaveProperty("images");
    expect(contextText(later)).toContain(`Keep this label in mind.\n[The user attached an image. Read one by its path to look at it again.]\n1. ${file}`);
    const results = model.requests[2]!.messages.filter((m) => m.role === "tool");
    expect(results[0]).toMatchObject({ content: `${file} — image, 400×400 PNG, 11 KB, shown below.`, images: [{ mediaType: "image/png" }] });
    expect(results[1]!.content).not.toContain("not for tools");
  });

  it("can be the whole message: the text stays empty, and the models are told only images came", async () => {
    const { w, folder, file, attachment } = await attached();
    const { socrates, routerModel, model } = w.socrates([continueTask(), continueTask()], [
      final({ full_answer: "A label that says ORCHID." }),
      final({ full_answer: "Yes, ORCHID." }),
    ], { attachments: folder });
    model.vision = true;
    await socrates.handle("", { attachments: [attachment] });
    expect(w.store.listEvents({ type: "user_message" }).at(-1)!.payload).toEqual({ text: "", attachments: [attachment] });
    expect(contextText(routerModel.requests[0]!)).toContain("<CURRENT_USER_MESSAGE>\n(No text: the user sent only the images in CURRENT_ATTACHMENTS.)");
    expect(model.requests[0]!.messages[0]).toMatchObject({ role: "user", images: [{ mediaType: "image/png" }] });
    expect(contextText(model.requests[0]!)).toContain(`(The user sent no text, only the images below.)\n[The user attached an image. They are shown with this message; read one by its path to look again later.]\n1. ${file}`);

    await socrates.handle("Was it ORCHID?");
    expect(contextText(model.requests[1]!)).toContain(`USER:\n(The user sent no text, only the images below.)\n[The user attached an image. Read one by its path to look at it again.]\n1. ${file}`);
  });

  it("tells the router about them, and keeps them findable by name in memory", async () => {
    const { w, folder, file, attachment } = await attached();
    const { socrates, routerModel, model } = w.socrates([continueTask(), continueTask()], [
      final({ full_answer: "Noted." }),
      { toolCalls: [call("context_retrieve", { action: "search", query: "label.png" })] },
      final({ full_answer: "Found it." }),
    ], { attachments: folder });
    await socrates.handle("Keep this label in mind.", { attachments: [attachment] });
    expect(contextText(routerModel.requests[0]!)).toContain("<CURRENT_ATTACHMENTS>\n[The user attached an image: label.png]");
    await socrates.handle("Which image did I send?");
    expect(contextText(routerModel.requests[1]!)).toContain("Keep this label in mind.\n[The user attached an image: label.png]");
    const found = model.requests[2]!.messages.at(-1)!.content;
    expect(found).toContain(file);
  });
});

