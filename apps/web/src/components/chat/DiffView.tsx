import type { DiffLine, DiffFile } from "./editPresentation";

export function DiffView({ files }: { files: DiffFile[] }) {
  return (
    <div className="space-y-3">
      {files.map((file, fileIndex) => (
        <div key={`${file.path}-${fileIndex}`} className="overflow-hidden rounded-xl border border-gray-200 bg-[#191b1f] shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-white/5 px-3 py-2 text-xs">
            <span className="min-w-0 truncate font-mono text-gray-100">{file.path}</span>
            <span className="shrink-0 font-mono">
              <span className="text-emerald-400">+{file.added}</span> <span className="text-red-400">-{file.removed}</span>
            </span>
          </div>
          <div className="max-h-96 overflow-auto font-mono text-xs leading-5">
            {file.lines.slice(0, 500).map((line, index) => (
              <DiffRow key={`${file.path}-${fileIndex}-${index}`} line={line} />
            ))}
            {file.lines.length > 500 && (
              <div className="border-t border-white/10 px-3 py-2 text-[11px] text-gray-400">
                Showing first 500 diff lines. Full diff is still preserved in the trace.
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const style =
    line.kind === "add"
      ? "border-l-2 border-emerald-400 bg-emerald-500/15 text-emerald-50"
      : line.kind === "remove"
        ? "border-l-2 border-red-400 bg-red-500/15 text-red-50"
        : line.kind === "hunk"
          ? "bg-sky-500/10 text-sky-200"
          : line.kind === "meta"
            ? "text-gray-500"
            : "text-gray-300";
  const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : line.kind === "hunk" ? "" : " ";

  return (
    <div className={`grid grid-cols-[3.5rem_1.25rem_minmax(0,1fr)] px-2 ${style}`}>
      <span className="select-none pr-2 text-right text-gray-500">{formatLineNumbers(line)}</span>
      <span className="select-none text-center text-gray-400">{marker}</span>
      <span className="whitespace-pre">{line.content || " "}</span>
    </div>
  );
}

function formatLineNumbers(line: DiffLine): string {
  if (line.kind === "hunk" || line.kind === "meta") {
    return "";
  }
  if (line.oldLine !== undefined && line.newLine !== undefined) {
    return `${line.oldLine}/${line.newLine}`;
  }
  if (line.oldLine !== undefined) {
    return String(line.oldLine);
  }
  if (line.newLine !== undefined) {
    return String(line.newLine);
  }
  return "";
}
