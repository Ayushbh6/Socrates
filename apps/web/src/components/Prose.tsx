import { useReducedMotion } from "motion/react";
import { Children, type ReactElement, type ReactNode, isValidElement, useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { FRAME_MS, cut, nextShown } from "../lib/reveal";
import { Code, CopyButton } from "./ToolOutput";

/** A fenced block: its language named above it, coloured, with a copy button. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0];
  const props = isValidElement(child) ? (child as ReactElement<{ className?: string; children?: ReactNode }>).props : null;
  const language = /language-([\w+#-]+)/.exec(props?.className ?? "")?.[1] ?? null;
  const text = String(props?.children ?? "").replace(/\n$/, "");
  return (
    <div className="code-block">
      <div className="code-block-head"><span>{language ?? "text"}</span><CopyButton text={text} label="Copy the code" /></div>
      <pre><Code code={text} language={language} /></pre>
    </div>
  );
}

/** How answers and narration render Markdown: links open apart, code blocks coloured. */
export const MARKDOWN: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

/**
 * Markdown text. One that is written while the page watches (`animate` at
 * the time it first appears) is let out evenly rather than in the bursts it
 * arrives in, and keeps going after the saved answer replaces its draft;
 * `writing` says more of it is still coming. `initialShown` carries text
 * already displayed as plain narration into a newly mounted answer.
 */
export function Prose({ text, animate, writing, initialShown = 0 }: { text: string; animate: boolean; writing: boolean; initialShown?: number }) {
  const still = useReducedMotion();
  const [animated] = useState(animate);
  const smooth = animated && !still;
  const [shown, setShown] = useState(smooth ? Math.min(initialShown, text.length) : text.length);
  const at = useRef(shown);
  useEffect(() => {
    if (!smooth) {
      at.current = text.length;
      setShown(text.length);
      return;
    }
    let frame = 0;
    let last: number | null = null;
    const tick = (now: number) => {
      at.current = nextShown(Math.min(at.current, text.length), text.length, last === null ? FRAME_MS : now - last);
      last = now;
      setShown(at.current);
      if (at.current < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, smooth]);
  return (
    <div className="prose" data-live={writing || shown < text.length}>
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN}>{cut(text, shown)}</Markdown>
    </div>
  );
}
