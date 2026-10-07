import { LoaderCircle } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { useFollow } from "../lib/follow";
import { type Exchange, orbState, workLine } from "../lib/model";
import { type AppState, store } from "../lib/store";
import { AnswerView } from "./AnswerView";
import { QuestionCard } from "./QuestionCard";

/**
 * One conversation in standard mode (or `shown`, the part of it that is one chat): every question with its answer, oldest
 * first, following the newest work while the reader is at the bottom.
 */
export function Thread({ app, conversation, shown, before, extra = [], compact = false, empty }: { app: AppState; conversation: string; shown?: Exchange[]; before?: ReactNode; extra?: Exchange[]; compact?: boolean; empty: string }) {
  const list = [...(shown ?? app.model.conversations[conversation] ?? []), ...extra];
  const latest = list.at(-1) ?? null;
  const approvals = (app.model.live?.approvals ?? []).filter((a) => a.conversation === conversation);
  const line = workLine(orbState(latest, approvals), latest);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useFollow(scroller, content);
  // A new question always brings the thread to its end.
  const newest = useRef(latest?.key);
  if (latest?.key !== newest.current) following.current = true;
  newest.current = latest?.key;
  // Preserve the question at the reader's position when an older page is prepended.
  const first = useRef(list[0]?.key);
  const area = scroller.current;
  const restore = first.current && first.current !== list[0]?.key && !following.current && area
    ? { height: area.scrollHeight, top: area.scrollTop } : null;
  first.current = list[0]?.key;
  useLayoutEffect(() => {
    if (restore && scroller.current) scroller.current.scrollTop = restore.top + scroller.current.scrollHeight - restore.height;
  });

  return (
    <div className="thread" data-compact={compact} ref={scroller}>
      <div ref={content}>
        {app.older[conversation] ? (
          <button type="button" className="quiet-button thread-older" onClick={() => void store.loadOlder(conversation)}>Load earlier questions</button>
        ) : null}
        {before}
        {!list.length && <p className="thread-empty">{empty}</p>}
        {list.map((e) => (
          <article key={e.key} className="thread-item">
            <QuestionCard text={e.message} attachments={e.attachments} note={e.state === "working" || e.state === "sending" ? e.note : null} />
            <div className="thread-answer">
              <AnswerView exchange={e} approvals={e === latest ? approvals : []} />
            </div>
          </article>
        ))}
        {line && (
          <p className="thread-status" data-waiting={line.startsWith("Waiting")}>
            <LoaderCircle aria-hidden className="spin" /> {line}
          </p>
        )}
      </div>
    </div>
  );
}
