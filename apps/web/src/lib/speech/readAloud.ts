const DEFAULT_SPEECH_CHUNK_LENGTH = 260;

const plainSpeechText = (markdown: string): string => markdown
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/^\s{0,3}#{1,6}\s+/gm, "")
  .replace(/^\s{0,3}(?:[-*+] |\d+[.)]\s+)/gm, "")
  .replace(/^\s{0,3}>\s?/gm, "")
  .replace(/```(?:[^\n]*)\n?/g, "")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/[*_~]/g, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/\|/g, " ")
  .replace(/[ \t]+/g, " ")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const splitLongSegment = (segment: string, maxLength: number): string[] => {
  if (segment.length <= maxLength) return [segment];
  const words = segment.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxLength || !current) {
      current = next;
      continue;
    }
    chunks.push(current);
    current = word;
  }
  if (current) chunks.push(current);
  return chunks;
};

export const speechChunksFromMarkdown = (
  markdown: string,
  maxLength = DEFAULT_SPEECH_CHUNK_LENGTH,
): string[] => {
  const text = plainSpeechText(markdown);
  if (!text) return [];
  const sentenceLikeSegments = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .flatMap((segment) => splitLongSegment(segment, maxLength));
  const chunks: string[] = [];
  let current = "";
  for (const segment of sentenceLikeSegments) {
    const next = current ? `${current} ${segment}` : segment;
    if (next.length <= maxLength || !current) {
      current = next;
      continue;
    }
    chunks.push(current);
    current = segment;
  }
  if (current) chunks.push(current);
  return chunks;
};
