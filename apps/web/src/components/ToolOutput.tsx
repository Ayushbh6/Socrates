import { Check, Copy, FileText, Folder } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { highlight } from "../lib/highlight";
import type { Layout } from "../lib/output";

/** Copies text, then says so for a moment. */
export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="copy-button"
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
      data-done={done}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard?.writeText(text).then(() => setDone(true), () => {});
      }}
    >
      {done ? <Check aria-hidden /> : <Copy aria-hidden />}
    </button>
  );
}

/** Code in its language's colours, or plain when the language is unknown. */
export function Code({ code, language }: { code: string; language: string | null }) {
  const html = highlight(code, language);
  return html !== null ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>;
}

/** A path as its file name, with the folder it is in apart. */
export function splitPath(path: string): { name: string; dir: string } {
  const at = path.replace(/\/+$/, "").lastIndexOf("/");
  return at < 0 ? { name: path, dir: "" } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

/** Occurrences of a search pattern marked in a line (as a regular expression, else literally). */
function marked(text: string, pattern: string | null): ReactNode {
  if (!pattern) return text;
  let re: RegExp;
  try {
    re = new RegExp(pattern, "gi");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  }
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) break;
    parts.push(text.slice(at, m.index), <mark key={m.index}>{m[0]}</mark>);
    at = m.index! + m[0].length;
  }
  if (!parts.length) return text;
  parts.push(text.slice(at));
  return parts;
}

/**
 * A call's result laid out to read (lib/output.ts): numbered code, matches
 * under their files, a file list, terminal output or indented JSON.
 * `cut` says where the preview was shortened: before it (a command's
 * output is its end) or after it.
 */
export function ToolOutput({ layout, cut, pattern = null }: { layout: Layout; cut: "before" | "after" | null; pattern?: string | null }) {
  const before = cut === "before" && <p className="out-cut">Earlier output not shown</p>;
  const after = cut === "after" && <p className="out-cut">Cut short here; open the full output for the rest</p>;
  switch (layout.kind) {
    case "code": {
      const code = layout.lines.map((l) => l.text).join("\n");
      return (
        <div className="out out-code">
          {layout.range && <p className="out-label">{layout.range}</p>}
          <div className="code-grid">
            <pre className="gutter" aria-hidden>{layout.lines.map((l) => l.n).join("\n")}</pre>
            <pre className="code-body"><Code code={code} language={layout.language} /></pre>
          </div>
          {after}
        </div>
      );
    }
    case "matches":
      return (
        <div className="out out-matches">
          {layout.files.map((f, i) => {
            const { name, dir } = splitPath(f.path);
            return (
              <div key={i} className="match-file">
                <p className="out-file"><FileText aria-hidden /><span className="out-name">{name}</span>{dir && <span className="out-dir">{dir}</span>}</p>
                <div className="code-grid">
                  <pre className="gutter" aria-hidden>{f.hits.map((h) => h.n ?? "").join("\n")}</pre>
                  <pre className="code-body">{f.hits.map((h, j) => <span key={j} className="match-line">{marked(h.text, pattern)}{"\n"}</span>)}</pre>
                </div>
              </div>
            );
          })}
          {after}
        </div>
      );
    case "files":
      return (
        <div className="out out-files">
          <ul>
            {layout.paths.map((p, i) => {
              const folder = p.endsWith("/");
              const { name, dir } = splitPath(p);
              return <li key={i}>{folder ? <Folder aria-hidden /> : <FileText aria-hidden />}<span className="out-name">{name}{folder ? "/" : ""}</span>{dir && <span className="out-dir">{dir}</span>}</li>;
            })}
          </ul>
          {after}
        </div>
      );
    case "terminal":
      return (
        <div className="out out-terminal">
          {before}
          <pre className="terminal-text" data-wrap={layout.wrap}><Code code={layout.text.replace(/\n+$/, "")} language={layout.language} /></pre>
          {after}
        </div>
      );
    case "json":
      return (
        <div className="out out-terminal">
          <pre className="terminal-text"><Code code={layout.text} language="json" /></pre>
          {after}
        </div>
      );
    case "text":
      return (
        <div className="out out-text">
          {before}
          <pre>{layout.text}</pre>
          {after}
        </div>
      );
  }
}
