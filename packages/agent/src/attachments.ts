import { readFile } from "node:fs/promises";
import type { Attachment, ImageData } from "@socrates/contracts";
import type { LedgerStore, Turn } from "@socrates/store";

/** The images attached to the message a turn answers (agent-harness.md, "Images"). */
export function requestAttachments(store: LedgerStore, turn: Turn): Attachment[] {
  return store.requestForTurn(turn.id).attachments;
}

/**
 * The lines naming a message's attachments, kept with the message wherever it
 * is shown to a model, so a later turn knows each image's path and reads it
 * again to look. `vision` says whether the current model is shown them now
 * (null in history, where they are never shown).
 */
export function attachmentLines(attachments: Attachment[], vision: boolean | null = null): string {
  if (!attachments.length) return "";
  const lines = attachments.map((a, i) => `${i + 1}. ${a.path} — ${JSON.stringify(a.name)}, ${a.width}×${a.height} ${a.media_type.slice("image/".length).toUpperCase()}`);
  const note = vision === true ? "They are shown with this message; read one by its path to look again later."
    : vision === false ? "The current model cannot see images: only their names and sizes are known. Say so rather than guess what they show."
    : "Read one by its path to look at it again.";
  return `[The user attached ${attachments.length === 1 ? "an image" : `${attachments.length} images`}. ${note}]\n${lines.join("\n")}`;
}

/** The attached images themselves, for a model that can see; one that has gone missing is left out. */
export async function attachmentImages(attachments: Attachment[], log?: (message: string) => void): Promise<ImageData[]> {
  const images: ImageData[] = [];
  for (const a of attachments) {
    try {
      images.push({ mediaType: a.media_type, data: (await readFile(a.path)).toString("base64") });
    } catch (error) {
      log?.(`attachment ${a.id} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return images;
}
