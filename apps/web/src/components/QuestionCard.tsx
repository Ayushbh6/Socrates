import { useLayoutEffect, useRef, useState } from "react";
import type { AttachmentView } from "../lib/types";

/** The user's question, floating above the canvas, with the images attached to it; a long one is cut off with Show more. */
export function QuestionCard({ text, note, attachments = [] }: { text: string; note: string | null; attachments?: AttachmentView[] }) {
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
      {attachments.length > 0 && (
        <ul className="question-images" aria-label="Attached images">
          {attachments.map((a) => (
            <li key={a.id}>
              <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer" title={`${a.name}, ${a.width}×${a.height}`}>
                <img src={`/api/attachments/${a.id}`} alt={a.name} loading="lazy" />
              </a>
            </li>
          ))}
        </ul>
      )}
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
