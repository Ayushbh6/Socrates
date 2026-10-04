import { LoaderCircle } from "lucide-react";
import { useRef } from "react";
import { useFollow } from "../lib/follow";
import { type Exchange, orbState, workLine } from "../lib/model";
import { type AppState, store } from "../lib/store";
import { AnswerView } from "./AnswerView";
import { QuestionCard } from "./QuestionCard";

/**
 * One conversation in standard mode: every question with its answer, oldest
 * first, following the newest work while the reader is at the bottom.
 */
export function Thread({ app, conversation, extra = [], compact = false, empty }: { app: AppState; conversation: string; extra?: Exchange[]; compact?: boolean; empty: string }) {
  const list = [...(app.model.conversations[conversation] ?? []), ...extra];
  const latest = list.at(-1) ?? null;
  const approvals = (app.model.live?.approvals ?? []).filter((a) => a.conversation === conversation);
  const line = workLine(orbState(latest, approvals), latest);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useFollow(scroller, content);
  // A new question always brings the thread to its end.
  const count = useRef(list.length);
  if (list.length > count.current) following.current = true;
  count.current = list.length;

  return (
    <div className="thread" data-compact={compact} ref={scroller}>
      <div ref={content}>
        {app.older[conversation] ? (
          <button type="button" className="quiet-button thread-older" onClick={() => void store.loadOlder(conversation)}>Load earlier questions</button>
        ) : null}
        {!list.length && <p className="thread-empty">{empty}</p>}
        {list.map((e) => (
          <article key={e.key} className="thread-item">
            <QuestionCard text={e.message} note={e.state === "working" || e.state === "sending" ? e.note : null} />
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
