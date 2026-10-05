/** How the full output of one tool call is shown (architecture/web.md, "Tool output"). */
export type EvidenceView =
  | { kind: "diff"; lines: { type: "head" | "hunk" | "add" | "del" | "same"; text: string }[] }
  | { kind: "json"; text: string }
  | { kind: "text"; text: string };

/** A file change as its diff, a structured result as tidy JSON, anything else as it was recorded. */
export function viewEvidence(content: string | null): EvidenceView {
  if (content === null) return { kind: "text", text: "No output was recorded for this call yet." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: "text", text: content };
  }
  if (parsed && typeof parsed === "object" && typeof (parsed as { diff?: unknown }).diff === "string" && (parsed as { diff: string }).diff) {
    return { kind: "diff", lines: diffLines((parsed as { diff: string }).diff) };
  }
  return typeof parsed === "object" && parsed !== null ? { kind: "json", text: JSON.stringify(parsed, null, 2) } : { kind: "text", text: content };
}

export function diffLines(diff: string): Extract<EvidenceView, { kind: "diff" }>["lines"] {
  return diff.replace(/\n$/, "").split("\n").map((text) => ({
    // A file's header: "*** path", "+++ path (created)", "--- path (deleted)".
    type: text.startsWith("+++") || text.startsWith("---") || text.startsWith("*** ") ? "head" : text.startsWith("@@") ? "hunk" : text.startsWith("+") ? "add" : text.startsWith("-") ? "del" : "same",
    text,
  }));
}
