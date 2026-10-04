import { AlertTriangle, Check, ChevronRight, CornerDownRight, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Exchange, Step } from "../lib/model";
import { type Segment, groupLabel, workSegments, workSummary } from "../lib/work";
import { EvidenceViewer } from "./EvidenceViewer";

/**
 * The work behind an answer, shown apart from it (architecture/web.md, "Work
 * and answer"): open while Socrates works, folded into one line once the
 * answer starts, and open again on a click.
 */
export function Work({ exchange }: { exchange: Exchange }) {
  const working = exchange.state === "working";
  const answering = exchange.answers.length > 0 || exchange.draft?.kind === "answer" || exchange.question !== null;
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (working && !answering);
  // "Working for" counts up while the work goes on.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [working]);

  const segments = workSegments(exchange);
  if (!segments.length) return null;
  return (
    <div className="work" data-open={expanded}>
      <button type="button" className="work-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <ChevronRight aria-hidden className="work-chevron" />
        <span>{workSummary(segments, exchange, now)}</span>
        {working && !answering && <LoaderCircle aria-hidden className="spin" />}
      </button>
      {expanded && (
        <div className="work-body">
          {segments.map((segment, i) => <SegmentView key={i} segment={segment} newest={working && i === segments.length - 1} />)}
        </div>
      )}
    </div>
  );
}

function SegmentView({ segment, newest }: { segment: Segment; newest: boolean }) {
  switch (segment.kind) {
    case "thinking":
      return <Thinking segment={segment} />;
    case "narration":
      return <p className="work-narration" data-live={segment.live}>{segment.text}</p>;
    case "tools":
      return <ToolGroup segment={segment} newest={newest} />;
    case "meta":
      return <Meta step={segment.step} />;
  }
}

/** The model's thinking: the newest lines while it thinks, then one line that opens to all of it. */
function Thinking({ segment }: { segment: Extract<Segment, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  if (segment.live) {
    return (
      <div className="thinking" data-live>
        <p className="thinking-label">Thinking…</p>
        <div className="thinking-text"><Markdown remarkPlugins={[remarkGfm]}>{segment.text}</Markdown></div>
      </div>
    );
  }
  return (
    <div className="thinking" data-open={open}>
      <button type="button" className="thinking-label" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight aria-hidden className="work-chevron" /> Thought
      </button>
      {open && (
        <div className="thinking-text">
          <Markdown remarkPlugins={[remarkGfm]}>{segment.text}</Markdown>
          {segment.truncated && <p className="thinking-cut">Shown up to its first 20,000 characters.</p>}
        </div>
      )}
    </div>
  );
}

/** Tool calls of one kind in a row: "Read 2 files", open while they run. */
function ToolGroup({ segment, newest }: { segment: Extract<Segment, { kind: "tools" }>; newest: boolean }) {
  const running = segment.steps.some((s) => s.status === "running");
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (newest || running);
  return (
    <div className="tool-group" data-open={expanded}>
      <button type="button" className="group-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <ChevronRight aria-hidden className="work-chevron" />
        <span>{groupLabel(segment.group, segment.steps)}</span>
        {running && <LoaderCircle aria-hidden className="spin" />}
      </button>
      {expanded && (
        <ol className="steps">
          {segment.steps.map((step) => <ToolRow key={`${step.task}:${step.handle}`} step={step} />)}
        </ol>
      )}
    </div>
  );
}

function ToolRow({ step }: { step: Extract<Step, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState(false);
  return (
    <li className="tool" data-status={step.status} data-open={open}>
      <button type="button" className="tool-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight aria-hidden className="tool-chevron" />
        <code>{step.line}</code>
        {step.status === "running" ? <LoaderCircle aria-label="Running" className="spin" /> : step.status === "ok" ? <Check aria-label="Done" /> : <X aria-label="Failed" />}
      </button>
      {open && (
        <div className="tool-output">
          {step.preview !== null && <pre>{step.preview}{step.truncated ? "\n…" : ""}</pre>}
          {step.status === "running" ? <p className="tool-running">Running…</p> : (
            <button type="button" className="quiet-button" onClick={() => setViewing(true)}>Open the full output</button>
          )}
        </div>
      )}
      {viewing && <EvidenceViewer task={step.task} handle={step.handle} onClose={() => setViewing(false)} />}
    </li>
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
