import { AlertTriangle, Brain, Check, ChevronRight, CornerDownRight, FilePen, FileText, History, LoaderCircle, Puzzle, Search, SquareTerminal, Wrench, X } from "lucide-react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { diffLines } from "../lib/evidence";
import type { Exchange } from "../lib/model";
import type { CallView } from "../lib/types";
import { type Segment, type ToolStep, type WorkItem, arriving, callFailed, callVerb, elapsed, groupLabel, thoughtLabel, waitingLine, workSegments, workSummary } from "../lib/work";
import { EvidenceViewer, ThinkingViewer } from "./EvidenceViewer";

/** The current time, every second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/**
 * The work behind an answer, shown apart from it (architecture/web.md, "Work
 * and answer"): open while Socrates works, with a line saying what it waits
 * on; folded into one line once the answer starts, and open again on a click.
 */
export function Work({ exchange }: { exchange: Exchange }) {
  const working = exchange.state === "working" || exchange.state === "sending";
  const answering = exchange.answers.length > 0 || exchange.draft?.kind === "answer" || (exchange.question !== null && !exchange.clarification);
  const active = working && !answering;
  const [open, setOpen] = useState<boolean | null>(null);
  const now = useNow(working);

  const segments = workSegments(exchange);
  // Nothing streams and nothing runs: the model is reading or thinking before its first word.
  const waiting = active && !arriving(exchange);
  const status = waiting ? <LiveStatus label={waitingLine(exchange)} since={exchange.lastAt ?? exchange.at} now={now} /> : null;
  if (!segments.length) return status;

  const body = (
    <div className="work-body">
      {segments.map((segment, i) => <SegmentView key={i} segment={segment} newest={active && i === segments.length - 1} now={now} />)}
      {status}
    </div>
  );
  // While it works, the work is the page; afterwards it folds behind one line.
  if (active && open === null) return <div className="work" data-open="true">{body}</div>;
  const expanded = open ?? false;
  return (
    <div className="work" data-open={expanded}>
      <button type="button" className="work-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <span>{workSummary(segments, exchange, now)}</span>
        <ChevronRight aria-hidden className="work-chevron" />
      </button>
      {expanded && body}
    </div>
  );
}

/** What Socrates is waiting on, shimmering, and for how long. */
function LiveStatus({ label, since, now }: { label: string; since: string; now: number }) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return (
    <p className="live-status" role="status">
      <span className="shimmer">{label}</span>
      {seconds >= 1 && <span className="live-time">{seconds}s</span>}
    </p>
  );
}

function SegmentView({ segment, newest, now }: { segment: Segment; newest: boolean; now: number }) {
  switch (segment.kind) {
    case "narration":
      return <div className="work-narration" data-live={segment.live}><Markdown remarkPlugins={[remarkGfm]}>{segment.text}</Markdown></div>;
    case "group":
      return segment.items.length === 1 ? <ItemView item={segment.items[0]!} now={now} /> : <Group items={segment.items} newest={newest} now={now} />;
    case "meta":
      return <Meta step={segment.step} />;
  }
}

const ICONS: Record<CallView["kind"], typeof FileText> = { read: FileText, search: Search, edit: FilePen, terminal: SquareTerminal, memory: History, capability: Puzzle, other: Wrench };

/** Everything between two lines of narration: one line that opens to each thought and call, open while it is the newest. */
function Group({ items, newest, now }: { items: WorkItem[]; newest: boolean; now: number }) {
  const running = items.some((i) => (i.kind === "tool" ? i.step.status === "running" : i.live));
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? newest;
  const first = items.find((i): i is Extract<WorkItem, { kind: "tool" }> => i.kind === "tool");
  const Icon = first ? ICONS[first.step.call.kind] : Brain;
  return (
    <div className="work-group" data-open={expanded}>
      <button type="button" className="row-line" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <Icon aria-hidden className="row-icon" />
        <span className={running ? "row-text shimmer" : "row-text"}>{groupLabel(items)}</span>
        <ChevronRight aria-hidden className="row-chevron" />
      </button>
      {expanded && <div className="group-items">{items.map((item, i) => <ItemView key={item.kind === "tool" ? `${item.step.task}:${item.step.handle}` : `t${i}`} item={item} now={now} />)}</div>}
    </div>
  );
}

function ItemView({ item, now }: { item: WorkItem; now: number }) {
  return item.kind === "thinking" ? <Thinking item={item} /> : <ToolRow step={item.step} output={item.output} now={now} />;
}

/** The model's thinking: its newest lines while it thinks, then one line that opens to all of it. */
function Thinking({ item }: { item: Extract<WorkItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  if (item.live) {
    return (
      <div className="thinking" data-live>
        <p className="row-line"><Brain aria-hidden className="row-icon" /><span className="row-text shimmer">Thinking</span></p>
        <div className="thinking-text"><Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown></div>
      </div>
    );
  }
  return (
    <div className="thinking" data-open={open}>
      <button type="button" className="row-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Brain aria-hidden className="row-icon" />
        <span className="row-text">{thoughtLabel(item.ms)}</span>
        <ChevronRight aria-hidden className="row-chevron" />
      </button>
      {open && (
        <div className="thinking-text">
          <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
          {item.truncated && (
            <p className="thinking-cut">
              Shown up to its first 20,000 characters.
              {item.seq !== undefined && <button type="button" className="quiet-button" onClick={() => setFull(true)}>Show all of it</button>}
            </p>
          )}
        </div>
      )}
      {full && item.seq !== undefined && <ThinkingViewer seq={item.seq} onClose={() => setFull(false)} />}
    </div>
  );
}

/** Lines of a running command's output shown under it. */
const LIVE_LINES = 6;

/** One call: "Ran `npm test`", what it came to, and on a click its output or diff. */
function ToolRow({ step, output, now }: { step: ToolStep; output: string | null; now: number }) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState(false);
  const running = step.status === "running";
  const failed = callFailed(step);
  const Icon = ICONS[step.call.kind];
  const result = step.result;
  const took = running ? now - Date.parse(step.at) : result?.ms ?? null;
  const live = running && output ? output.replace(/\n+$/, "").split("\n").slice(-LIVE_LINES).join("\n") : "";
  return (
    <div className="tool" data-status={failed ? "error" : step.status} data-open={open}>
      <button type="button" className="row-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon aria-hidden className="row-icon" />
        <span className="row-text">
          <span className={running ? "shimmer" : undefined}>{callVerb(step)}</span>
          {step.call.target && <code>{step.call.target}</code>}
          {step.call.detail && <span className="row-detail">{step.call.detail}</span>}
        </span>
        {result?.summary && <Summary text={result.summary} failed={failed} />}
        {took !== null && took >= 1000 && <span className="row-time">{elapsed(took)}</span>}
        {running ? <LoaderCircle aria-label="Running" className="row-state spin" /> : failed ? <X aria-label="Failed" className="row-state" /> : null}
        <ChevronRight aria-hidden className="row-chevron" />
      </button>
      {live && <pre className="tool-live" aria-live="off">{live}</pre>}
      {open && (
        <div className="tool-output">
          {result?.diff ? <Diff text={result.diff} /> : result?.preview ? <pre>{result.preview}{result.truncated ? "\n…" : ""}</pre> : null}
          {running ? <p className="tool-running">Running…</p> : (
            <button type="button" className="quiet-button" onClick={() => setViewing(true)}>Open the full output</button>
          )}
        </div>
      )}
      {viewing && <EvidenceViewer task={step.task} handle={step.handle} onClose={() => setViewing(false)} />}
    </div>
  );
}

/** "+5 −2" in colour; anything else as quiet words. */
function Summary({ text, failed }: { text: string; failed: boolean }) {
  const counts = /^\+(\d+) −(\d+)$/.exec(text);
  if (counts) return <span className="row-summary"><span className="added">+{counts[1]}</span> <span className="removed">−{counts[2]}</span></span>;
  return <span className="row-summary" data-failed={failed}>{text}</span>;
}

/** An edit's change: added and removed lines in colour, under each file's name. */
function Diff({ text }: { text: string }) {
  return (
    <pre className="tool-diff">
      {diffLines(text).map((l, i) => <span key={i} className="diff-line" data-type={l.type}>{l.text || " "}</span>)}
    </pre>
  );
}

function Meta({ step }: { step: Extract<Segment, { kind: "meta" }>["step"] }) {
  switch (step.kind) {
    case "handed_off":
      return <p className="step-meta"><CornerDownRight aria-hidden /> Handed to lane {step.lane}, which is working on this task.</p>;
    case "warning":
      return <p className="step-meta warn"><AlertTriangle aria-hidden /> {step.detail}</p>;
    case "decision":
      return <p className="step-meta">{step.granted ? <Check aria-hidden /> : <X aria-hidden />} {step.granted ? "Approved" : "Refused"}: {step.detail}</p>;
  }
}
