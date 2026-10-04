import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cut, nextShown } from "../lib/reveal";

/**
 * Markdown text. One that is written while the page watches (`animate` at
 * the time it first appears) is let out evenly rather than in the bursts it
 * arrives in, and keeps going after the saved answer replaces its draft;
 * `writing` says more of it is still coming.
 */
export function Prose({ text, animate, writing }: { text: string; animate: boolean; writing: boolean }) {
  const still = useReducedMotion();
  const [smooth] = useState(animate && !still);
  const [shown, setShown] = useState(smooth ? 0 : text.length);
  const at = useRef(shown);
  useEffect(() => {
    if (!smooth) {
      at.current = text.length;
      setShown(text.length);
      return;
    }
    let frame = 0;
    const tick = () => {
      at.current = nextShown(Math.min(at.current, text.length), text.length);
      setShown(at.current);
      if (at.current < text.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, smooth]);
  return (
    <div className="prose" data-live={writing || shown < text.length}>
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>{cut(text, shown)}</Markdown>
    </div>
  );
}
