import type { MemoryAgentSummarySections } from "@socrates/contracts"

const SECTION_KEYS = ["investigated", "changed", "skipped", "blocked"] as const
const SECTION_LABELS: Record<(typeof SECTION_KEYS)[number], string> = {
  investigated: "Investigated",
  changed: "Changed",
  skipped: "Skipped",
  blocked: "Blocked",
}

export const emptyMemoryAgentSummary = (): MemoryAgentSummarySections => ({
  investigated: "",
  changed: "",
  skipped: "",
  blocked: "",
})

export const parseMemoryAgentSummarySections = (text: string): MemoryAgentSummarySections => {
  const summary = emptyMemoryAgentSummary()
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  let current: keyof MemoryAgentSummarySections | undefined

  for (const line of lines) {
    const section = sectionForLine(line)
    if (section) {
      current = section
      continue
    }
    if (!current) {
      continue
    }
    summary[current] = `${summary[current]}${summary[current] ? "\n" : ""}${line}`.trim()
  }

  return summary
}

export const formatMemoryAgentSummarySections = (summary: MemoryAgentSummarySections): string =>
  SECTION_KEYS.map((key) => `## ${SECTION_LABELS[key]}\n${summary[key].trim() || "None."}`).join("\n\n")

const sectionForLine = (line: string): keyof MemoryAgentSummarySections | undefined => {
  const normalized = line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/:$/, "")
    .trim()
    .toLowerCase()
  return SECTION_KEYS.find((key) => normalized === key)
}
