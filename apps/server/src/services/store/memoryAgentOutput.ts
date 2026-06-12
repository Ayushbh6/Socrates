import { createHash } from "node:crypto"

export type MemoryPatchProposal = {
  path?: string
  document?: "identity" | "operating_principles"
  oldText?: string
  newText?: string
  expectedBeforeHash?: string
  rationale?: string
  sourceTurnIds?: string[]
}

export type MemoryAgentOutput = {
  no_op?: boolean
  skillPatches?: MemoryPatchProposal[]
  toolUsageDocPatches?: MemoryPatchProposal[]
  soulPatchProposals?: MemoryPatchProposal[]
}

export const parseMemoryAgentOutput = (text: string): MemoryAgentOutput => {
  const trimmed = text.trim()
  const jsonText = trimmed.startsWith("{") ? trimmed : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)
  const parsed = JSON.parse(jsonText) as MemoryAgentOutput
  return {
    ...(parsed.no_op === true ? { no_op: true } : {}),
    ...(Array.isArray(parsed.skillPatches) ? { skillPatches: parsed.skillPatches.map(normalizeMemoryPatch).filter(Boolean) as MemoryPatchProposal[] } : {}),
    ...(Array.isArray(parsed.toolUsageDocPatches) ? { toolUsageDocPatches: parsed.toolUsageDocPatches.map(normalizeMemoryPatch).filter(Boolean) as MemoryPatchProposal[] } : {}),
    ...(Array.isArray(parsed.soulPatchProposals) ? { soulPatchProposals: parsed.soulPatchProposals.map(normalizeMemoryPatch).filter(Boolean) as MemoryPatchProposal[] } : {}),
  }
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

const normalizeMemoryPatch = (value: unknown): MemoryPatchProposal | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  return {
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(record.document === "identity" || record.document === "operating_principles" ? { document: record.document } : {}),
    ...(typeof record.oldText === "string" ? { oldText: record.oldText } : {}),
    ...(typeof record.newText === "string" ? { newText: record.newText } : {}),
    ...(typeof record.expectedBeforeHash === "string" ? { expectedBeforeHash: record.expectedBeforeHash } : {}),
    ...(typeof record.rationale === "string" ? { rationale: record.rationale } : {}),
    ...(Array.isArray(record.sourceTurnIds) ? { sourceTurnIds: record.sourceTurnIds.filter((item): item is string => typeof item === "string") } : {}),
  }
}

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1
