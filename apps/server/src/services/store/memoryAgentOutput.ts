import { createHash } from "node:crypto"

export type MemoryPatchProposal = {
  document?: "identity" | "operating_principles"
  oldText?: string
  newText?: string
  expectedBeforeHash?: string
  rationale?: string
  sourceTurnIds?: string[]
}

export const validateMemoryPatch = (current: string, patch: MemoryPatchProposal): { ok: true; next: string } | { ok: false; error: string } => {
  if (patch.expectedBeforeHash && patch.expectedBeforeHash !== hashText(current)) {
    return { ok: false, error: "Expected before hash did not match current file." }
  }
  if (!patch.oldText || patch.newText === undefined) {
    return { ok: false, error: "Memory patch must include oldText and newText." }
  }
  const occurrences = countOccurrences(current, patch.oldText)
  if (occurrences === 0) {
    return { ok: false, error: "oldText was not found in target memory file." }
  }
  if (occurrences > 1) {
    return { ok: false, error: "oldText matched more than once in target memory file." }
  }
  return { ok: true, next: current.replace(patch.oldText, patch.newText) }
}

export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex")

export const simpleDiff = (oldText: string, newText: string): string =>
  [`--- old`, `+++ new`, ...oldText.split(/\r?\n/).map((line) => `-${line}`), ...newText.split(/\r?\n/).map((line) => `+${line}`)].join("\n")

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1
