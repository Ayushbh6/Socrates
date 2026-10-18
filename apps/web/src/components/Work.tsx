import { AlertTriangle, Brain, Check, ChevronRight, CornerDownRight, FilePen, FileText, History, LoaderCircle, Puzzle, Search, ShieldCheck, ShieldX, SquareTerminal, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { diffLines } from "../lib/evidence";
import type { Exchange } from "../lib/model";
import type { CallView } from "../lib/types";
import { type Segment, type ToolStep, type WorkItem, arriving, callFailed, callVerb, elapsed, groupLabel, thoughtLabel, waitingLine, workSegments, workSummary } from "../lib/work";
import { EvidenceViewer, ThinkingViewer } from "./EvidenceViewer";
import { STAGE_MIN_MS, orientedLine, progressLine, progressTrail } from "../lib/progress";

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
  // Before any work shows, the routing line says what is happening.
  if (!segments.length) return waiting ? <ProgressLine exchange={exchange} now={now} /> : null;
  const oriented = orientedLine(exchange);

  const body = (
    <div className="work-body">
      {oriented && <Oriented exchange={exchange} label={oriented.label} ms={oriented.ms} />}
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

/**
 * The routing line: one line under the question while a message gets started,
 * changing in place as the server reports each stage. A stage stays at least
 * STAGE_MIN_MS so it can be read; clicking opens the stages so far.
 */
function ProgressLine({ exchange, now }: { exchange: Exchange; now: number }) {
  const count = exchange.progress.length;
  // A page that joins mid-way starts at the newest stage rather than replaying them.
  const [shown, setShown] = useState(() => Math.max(0, count - 1));
  const shownAt = useRef(Date.now());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (shown >= count - 1) return;
    const timer = setTimeout(() => { shownAt.current = Date.now(); setShown((s) => Math.min(s + 1, count - 1)); }, Math.max(0, STAGE_MIN_MS - (Date.now() - shownAt.current)));
    return () => clearTimeout(timer);
  }, [shown, count]);
  const label = progressLine(exchange, shown, now);
  const seconds = Math.max(0, Math.floor((now - Date.parse(exchange.at)) / 1000));
  return (
    <div className="progress-line" data-open={open}>
      <button type="button" className="progress-head" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!count}>
        <span className="progress-dot" aria-hidden />
        <span className="progress-label" role="status"><span key={label} className="progress-swap"><span className="shimmer">{label}</span></span></span>
        {seconds >= 1 && <span className="live-time">{seconds}s</span>}
        {count > 0 && <ChevronRight aria-hidden className="work-chevron" />}
      </button>
      {open && <Trail exchange={exchange} shown={shown} />}
    </div>
  );
}

function Trail({ exchange, shown, settled }: { exchange: Exchange; shown: number; settled?: boolean }) {
  return (
    <ol className="progress-trail">
      {progressTrail(exchange, shown, settled).map((item, i) => (
        <li key={i} data-done={item.done}>
          {item.done ? <Check aria-hidden /> : <span className="progress-dot" aria-hidden />}
          <span>{item.label}</span>
          <span className="live-time">{elapsed(item.offsetMs)}</span>
        </li>
      ))}
    </ol>
  );
}

/** Once work shows: how long getting started took, opening to the stages (this page only). */
function Oriented({ exchange, label, ms }: { exchange: Exchange; label: string; ms: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="progress-line" data-open={open}>
      <button type="button" className="progress-head oriented" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Check aria-hidden />
        <span>{label}</span>
        <span className="live-time">{elapsed(ms)}</span>
        <ChevronRight aria-hidden className="work-chevron" />
      </button>
      {open && <Trail exchange={exchange} shown={exchange.progress.length - 1} settled />}
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

/** A long folder by its first and last parts: "~/.codex/…/10/16". */
export function shortFolder(folder: string): string {
  const parts = folder.split("/");
  return folder.length <= 28 || parts.length <= 4 ? folder : [...parts.slice(0, 2), "…", ...parts.slice(-2)].join("/");
}

/** A path as its file name, with the folder it is in apart. */
function splitPath(path: string): { name: string; dir: string } {
  const at = path.replace(/\/+$/, "").lastIndexOf("/");
  return at < 0 ? { name: path, dir: "" } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

/**
 * One call (architecture/web.md, "Work and answer"). A command reads as its
 * first line in mono, with its folder, extra lines, approval and exit beside
 * it, and opens to a card: the whole command, its output, and a footer. A
 * file reads by its name, with its folder faint; anything else in words.
 */
function ToolRow({ step, output, now }: { step: ToolStep; output: string | null; now: number }) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState(false);
  const running = step.status === "running";
  const failed = callFailed(step);
  const Icon = ICONS[step.call.kind];
  const result = step.result;
  const took = running ? now - Date.parse(step.at) : result?.ms ?? null;
  const time = took !== null && took >= 1000 ? elapsed(took) : null;
  const live = running && output ? output.replace(/\n+$/, "").split("\n").slice(-LIVE_LINES).join("\n") : "";
  const command = step.call.kind === "terminal" && step.call.command !== undefined ? step.call : null;
  const file = (step.call.kind === "read" || step.call.kind === "edit") && step.call.target ? splitPath(step.call.target) : null;
  const more = command?.lines && command.lines > 1 ? command.lines - 1 : 0;
  return (
    <div className="tool" data-kind={step.call.kind} data-status={failed ? "error" : step.status} data-open={open}>
      <button type="button" className="row-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon aria-hidden className="row-icon" />
        {command ? (
          <span className="row-text row-command">
            <span className={running ? "shimmer" : undefined}>{command.target}</span>
          </span>
        ) : (
          <span className="row-text">
            <span className={running ? "shimmer" : undefined}>{callVerb(step)}</span>
            {file ? <><code>{file.name}</code>{file.dir && <span className="row-detail">{file.dir}</span>}</> : step.call.target && <code>{step.call.target}</code>}
            {step.call.detail && <span className="row-detail">{step.call.detail}</span>}
          </span>
        )}
        {command?.detail && <span className="row-chip">{command.detail.replace(/^in the /, "")}</span>}
        {more > 0 && <span className="row-chip">+{more} {more === 1 ? "line" : "lines"}</span>}
        {command?.folder && <span className="row-chip row-folder" title={command.folder}>{shortFolder(command.folder)}</span>}
        <span className="row-end">
          {step.approval && <Approval approval={step.approval} />}
          {result?.summary && <Summary text={result.summary} failed={failed} />}
          {time && <span className="row-time">{time}</span>}
          {running ? <LoaderCircle aria-label="Running" className="row-state spin" /> : failed ? <X aria-label="Failed" className="row-state" /> : null}
          <ChevronRight aria-hidden className="row-chevron" />
        </span>
      </button>
      {live && <pre className="tool-live" aria-live="off">{live}</pre>}
      {open && (
        <div className="tool-card">
          {command && <pre className="tool-card-command"><span aria-hidden className="tool-prompt">$ </span>{command.command}</pre>}
          {result?.diff ? <Diff text={result.diff} /> : result?.preview ? (
            // A command's preview is the end of its output; anything else's, the start.
            <pre className="tool-card-output">{command && result.truncated ? "…\n" : ""}{result.preview}{!command && result.truncated ? "\n…" : ""}</pre>
          ) : !running && command ? <p className="tool-card-empty">No output</p> : null}
          <div className="tool-card-foot">
            <span>{[command?.folder ? shortFolder(command.folder) : null, result?.summary && !/^\+\d+ −\d+$/.test(result.summary) ? result.summary : null, time].filter(Boolean).join(" · ") || (running ? "Running…" : "")}</span>
            <span className="tool-card-actions">
              {command && typeof result?.lines === "number" && <span>{result.lines} {result.lines === 1 ? "line" : "lines"}{result.saved && result.truncated ? ", all saved" : ""}</span>}
              {!running && <button type="button" className="quiet-button" onClick={() => setViewing(true)}>Open the full output</button>}
            </span>
          </div>
        </div>
      )}
      {viewing && <EvidenceViewer task={step.task} handle={step.handle} onClose={() => setViewing(false)} />}
    </div>
  );
}

/** The approval a call asked for, as a mark on its row: what was asked on hover. */
function Approval({ approval }: { approval: { granted: boolean; detail: string } }) {
  const label = `${approval.granted ? "Approved" : "Refused"}: ${approval.detail}`;
  const Mark = approval.granted ? ShieldCheck : ShieldX;
  return <span className="row-approval" data-granted={approval.granted} title={label} aria-label={label} role="img"><Mark aria-hidden /></span>;
}

/** "+5 −2" in colour; anything else as quiet words. */
function Summary({ text, failed }: { text: string; failed: boolean }) {
  const counts = /^\+(\d+) −(\d+)$/.exec(text);
  if (counts) return <span className="row-summary"><span className="added">+{counts[1]}</span> <span className="removed">−{counts[2]}</span></span>;
  return <span className={/^exit -?\d+$/.test(text) ? "row-summary exit" : "row-summary"} data-failed={failed}>{text}</span>;
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
