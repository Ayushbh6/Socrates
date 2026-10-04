import { useLayoutEffect, useRef, useState } from "react";

/** The user's question, floating above the canvas; a long one is cut off with Show more. */
export function QuestionCard({ text, note }: { text: string; note: string | null }) {
  const body = useRef<HTMLParagraphElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    setOpen(false);
    const el = body.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 2);
  }, [text]);
  return (
    <div className="question">
      <div className="question-card" data-open={open} data-long={long}>
        <p ref={body} className="question-text">{text}</p>
        {long && (
          <button type="button" className="question-more" onClick={() => setOpen(!open)}>
            {open ? "Show less" : "Show more"}
          </button>
        )}
      </div>
      {note && <p className="question-note">{note}</p>}
    </div>
  );
}
