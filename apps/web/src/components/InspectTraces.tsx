import { ArrowRight, Brain, ChevronsDownUp, ChevronsUpDown, Layers, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../lib/api";
import { asked, dayLabel } from "../lib/model";
import {
  type CallRow, duration, inspectHref, percent, type QuestionRow, type Range, roleLabel, shortModel, speed, tokens, type Trace, type TraceCall, type TraceItem, usd,
} from "../lib/observe";
import { MoveChip, PromptBar, Fold, prettyJson, usePolled } from "./inspect-kit";
import { Prose } from "./Prose";

/** The traces: every message with calls, and for the one open, everything that happened for it in order. */
export function InspectTraces({ question, range, ms, onCall }: { question: string | null; range: Range; ms: number; onCall: (id: string) => void }) {
  const list = usePolled(() => api.observeQuestions(range), [range], ms);
  const [filter, setFilter] = useState("");
  const questions = list.data?.questions ?? [];
  const shown = useMemo(() => questions.filter((q) => !filter.trim() || q.message.toLowerCase().includes(filter.trim().toLowerCase())), [questions, filter]);
  const openId = question ?? questions[0]?.userEventId ?? null;
  return (
    <div className="inspect-split">
      <QuestionList questions={shown} total={questions.length} open={openId} filter={filter} onFilter={setFilter} loading={!list.data && !list.error} error={list.error} />
      <section className="trace-pane" aria-label="Trace">
        {openId ? <TraceView id={openId} ms={ms} onCall={onCall} /> : <p className="inspect-empty">Ask Socrates something and everything that happens for it shows up here: the router's thinking, the context it was given, each step of the agent, every tool call and its result, and the answer.</p>}
      </section>
    </div>
  );
}

function QuestionList({ questions, total, open, filter, onFilter, loading, error }: { questions: QuestionRow[]; total: number; open: string | null; filter: string; onFilter: (v: string) => void; loading: boolean; error: string | null }) {
  const groups: { day: string; items: QuestionRow[] }[] = [];
  for (const q of questions) {
    const day = dayLabel(q.at);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1)!.items.push(q);
  }
  return (
    <nav className="question-list" aria-label="Questions">
      <h3>Questions <small>{total}</small></h3>
      <input className="search" type="search" placeholder="Search what was asked" value={filter} onChange={(e) => onFilter(e.target.value)} aria-label="Search questions" />
      {error && <p className="inspect-note" role="alert">{error}</p>}
      {!questions.length && <p className="inspect-empty">{loading ? "Loading…" : filter ? "Nothing matches." : "No calls in this time range."}</p>}
      {groups.map((g) => (
        <div key={g.day}>
          <p className="day">{g.day}</p>
          {g.items.map((q) => {
            const move = q.parts[0]?.move;
            return (
              <a key={q.userEventId} className="q-row" href={inspectHref("traces", q.userEventId)} data-current={q.userEventId === open}>
                <span className="q-text">{q.message.trim() || "An image"}</span>
                <span className="q-meta">
                  {move && <MoveChip move={move} />}
                  {q.outcome === "clarify" && <b className="chip-move" data-move="ask" data-switch="true">Asked back</b>}
                  <span>{q.calls} calls</span>
                  <span>{usd(q.priced ? q.costUsd : null)}</span>
                  <span>{percent(q.cacheHitRate)} cached</span>
                  <time dateTime={q.at}>{asked(q.at)}</time>
                </span>
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

const sum = (calls: CallRow[], f: (c: CallRow) => number) => calls.reduce((n, c) => n + f(c), 0);

function TraceView({ id, ms, onCall }: { id: string; ms: number; onCall: (id: string) => void }) {
  const trace = usePolled(() => api.observeTrace(id), [id], ms);
  const [expand, setExpand] = useState<{ open: boolean; key: number }>({ open: false, key: 0 });
  if (trace.error && !trace.data) return <p className="inspect-note" role="alert">{trace.error}</p>;
  if (!trace.data) return <p className="inspect-empty">Loading…</p>;
  const { question, items } = trace.data;
  const calls = items.filter((i): i is TraceCall => i.kind === "call").map((i) => i.call);
  const prompt = sum(calls, (c) => c.promptTokens), cached = sum(calls, (c) => c.cacheReadTokens);
  const priced = calls.filter((c) => c.costUsd !== null).length;
  // Each call's growth over the one before it in its group.
  const previous = new Map<string, number>();
  const growth = new Map<string, number | null>();
  for (const i of items) {
    if (i.kind !== "call") continue;
    const key = i.group === "router" ? "router" : i.turnId ?? "";
    growth.set(i.call.id, previous.has(key) ? i.call.promptTokens - previous.get(key)! : null);
    previous.set(key, i.call.promptTokens);
  }
  const widest = Math.max(1, ...calls.map((c) => c.promptTokens));
  return (
    <>
      <header className="trace-head">
        <div className="trace-title">
          <p className="question-text">{question.message}</p>
          <p className="question-sub">{dayLabel(question.at)}, {asked(question.at)}{question.lane ? ` · lane ${question.lane}` : ""}</p>
        </div>
        <dl className="strip">
          <div><dt>Calls</dt><dd>{calls.length}</dd></div>
          <div><dt>Cost</dt><dd>{usd(priced ? sum(calls, (c) => c.costUsd ?? 0) : null)}</dd></div>
          <div><dt>Tokens in</dt><dd>{tokens(prompt)}</dd></div>
          <div><dt>Cached</dt><dd>{percent(prompt ? cached / prompt : null)}</dd></div>
          <div><dt>Out</dt><dd>{tokens(sum(calls, (c) => c.outputTokens))}</dd></div>
          <div><dt>Model time</dt><dd>{duration(sum(calls, (c) => c.ms))}</dd></div>
        </dl>
        <button type="button" className="quiet-button" onClick={() => setExpand({ open: !expand.open, key: expand.key + 1 })}>
          {expand.open ? <><ChevronsDownUp aria-hidden /> Collapse all</> : <><ChevronsUpDown aria-hidden /> Expand all</>}
        </button>
      </header>
      <ol className="timeline" key={expand.key} data-open={expand.open}>
        {items.map((item, i) => <li key={i} data-kind={item.kind}><i className="node" aria-hidden /><Item item={item} open={expand.open} widest={widest} growth={item.kind === "call" ? growth.get(item.call.id) ?? null : null} onCall={onCall} /></li>)}
      </ol>
    </>
  );
}

function Item({ item, open, widest, growth, onCall }: { item: TraceItem; open: boolean; widest: number; growth: number | null; onCall: (id: string) => void }) {
  switch (item.kind) {
    case "user":
      return (
        <article className="card card-user">
          <h4>You asked{item.lane ? ` · lane ${item.lane}` : ""}</h4>
          <p className="card-text">{item.text}</p>
          {item.attachments.length > 0 && <p className="chips">{item.attachments.map((a) => <span key={a} className="chip">{a}</span>)}</p>}
        </article>
      );
    case "call":
      return <CallCard item={item} open={open} widest={widest} growth={growth} onCall={onCall} />;
    case "routing":
      return (
        <article className="card card-decision">
          <h4>The router's decision</h4>
          {item.clarification ? <p className="card-text">It asked back: “{item.clarification}”</p> : null}
          <p className="meta">
            <code>{shortModel(item.routing.model)}</code> · {item.routing.attempts} attempt{item.routing.attempts === 1 ? "" : "s"} · {item.routing.ledgerQueries} ledger {item.routing.ledgerQueries === 1 ? "query" : "queries"}
            {item.routing.escalated ? " · escalated to the main model" : ""}{item.routing.fallback ? ` · fallback “${item.routing.fallback}”` : ""}
          </p>
          {item.routing.reason && <p className="card-text">“{item.routing.reason}”</p>}
          {item.routing.validationErrors.length > 0 && <Fold title="Rejected answers" meta={`${item.routing.validationErrors.length}`} open={open}><pre>{item.routing.validationErrors.join("\n")}</pre></Fold>}
          {item.routing.decision != null && <Fold title="The decision as returned" open={open}><pre>{JSON.stringify(item.routing.decision, null, 2)}</pre></Fold>}
        </article>
      );
    case "turn":
      return (
        <article className="card card-turn">
          <h4>Turn {item.part.projectTurn} <MoveChip move={item.part.move} /> <span className={`status status-${item.part.status}`}>{item.part.status.replace("_", " ")}</span></h4>
          <p className="places">
            {item.part.from && item.part.move !== "continued" && <><span className="place"><b>g{item.part.from.goal.number}</b> {item.part.from.goal.title} <ArrowRight aria-hidden /> <b>t{item.part.from.task.number}</b> {item.part.from.task.title}</span><ArrowRight aria-hidden className="to" /></>}
            <span className="place"><b>g{item.part.to.goal.number}</b> {item.part.to.goal.title} <ArrowRight aria-hidden /> <b>t{item.part.to.task.number}</b> {item.part.to.task.title}</span>
          </p>
          {item.part.route && <p className="meta">Route: <code>{item.part.route}</code></p>}
        </article>
      );
    case "compaction":
      return (
        <article className="card card-compaction">
          <h4><Layers aria-hidden /> Context compacted</h4>
          <p className="card-text">{tokens(item.compaction.before_tokens)} → {tokens(item.compaction.after_tokens)} tokens by {item.compaction.layers.join(", ")}{item.compaction.checkpoint ? `, saved as ${item.compaction.checkpoint}` : ""}.</p>
        </article>
      );
    case "answer":
      return (
        <article className="card card-answer">
          <h4>{item.stopped ? `Stopped (${item.stopped})` : item.status === "in_progress" ? "Answering…" : "The answer"}</h4>
          {item.text ? <div className="answer"><Prose text={item.text} animate={false} writing={false} /></div> : <p className="muted">{item.status === "in_progress" ? "Still working." : "No answer was written."}</p>}
        </article>
      );
  }
}

function CallCard({ item, open, widest, growth, onCall }: { item: TraceCall; open: boolean; widest: number; growth: number | null; onCall: (id: string) => void }) {
  const c = item.call;
  const enteredTokens = item.entered.reduce((n, e) => n + e.tokens, 0);
  const contextTokens = item.context?.reduce((n, b) => n + b.tokens, 0) ?? 0;
  return (
    <article className="card card-call" data-group={item.group} data-failed={!c.ok && c.error?.kind !== "aborted"}>
      <header>
        <h4>{item.group === "router" ? <Brain aria-hidden /> : <Wrench aria-hidden />} {roleLabel(c)} <small><code>{shortModel(c.model)}</code></small></h4>
        <button type="button" className="quiet-button" onClick={() => onCall(c.id)}>Raw request</button>
      </header>
      <dl className="strip small">
        <div><dt>In</dt><dd>{tokens(c.promptTokens)}{growth !== null && <small> {growth >= 0 ? "+" : "−"}{tokens(Math.abs(growth))}</small>}</dd></div>
        <div><dt>Cached</dt><dd>{percent(c.promptTokens ? c.cacheReadTokens / c.promptTokens : null)}</dd></div>
        <div><dt>Out</dt><dd>{tokens(c.outputTokens)}{c.reasoningTokens ? <small> {tokens(c.reasoningTokens)} thinking</small> : null}</dd></div>
        <div><dt>First token</dt><dd>{duration(c.firstTokenMs)}</dd></div>
        <div><dt>Speed</dt><dd>{speed(c.tokensPerSecond)}</dd></div>
        <div><dt>Time</dt><dd>{duration(c.ms)}</dd></div>
        <div><dt>Cost</dt><dd>{usd(c.costUsd)}</dd></div>
      </dl>
      <PromptBar call={c} widest={widest} />
      {c.error && <p className="inspect-note" role="alert">{c.error.kind === "aborted" ? "Stopped before it finished." : `Failed: ${c.error.kind}${c.error.status ? ` ${c.error.status}` : ""}: ${c.error.message}`}</p>}

      {item.context && (
        <Fold title={item.rebuilt ? "Context rebuilt after compaction" : "Context it was given"} meta={`${item.context.length} blocks · ${tokens(contextTokens)} tokens`} open={open}>
          <div className="blocks">
            {item.context.map((b, i) => (
              <Fold key={i} title={b.name ? <code className="block-name">{b.name}</code> : <span className="muted">text</span>} meta={<>{tokens(b.tokens)} tokens{b.cacheAfter ? <b className="cache-mark" title="A prompt-cache breakpoint follows this block">cache point</b> : null}</>} tone={b.name ?? "plain"}>
                <pre>{b.text}</pre>
              </Fold>
            ))}
          </div>
        </Fold>
      )}
      {item.entered.length > 0 && (
        <Fold title="Entered since the last step" meta={`${item.entered.length} message${item.entered.length === 1 ? "" : "s"} · ${tokens(enteredTokens)} tokens`} open={open}>
          <div className="blocks">
            {item.entered.map((e, i) => (
              <Fold key={i} title={<span className="role" data-role={e.role}>{e.label}</span>} meta={`${tokens(e.tokens)} tokens`} tone={e.label.includes("(error)") ? "error" : undefined}>
                <pre>{prettyJson(e.text)}</pre>
              </Fold>
            ))}
          </div>
        </Fold>
      )}
      {item.reasoning && <Fold title="Thinking" meta={`${tokens(Math.round(item.reasoning.length / 4))} tokens, about`} open={open}><pre className="thinking">{item.reasoning}</pre></Fold>}
      {item.text.trim() && <Fold title={item.toolCalls.length ? "Said before the tools" : "Said"} open={open || !item.toolCalls.length}><pre className="said">{item.text}</pre></Fold>}
      {item.toolCalls.map((t) => (
        <Fold key={t.id} title={<><b className="tool-name">{t.name}</b> <span className="tool-args">{summarize(t.input)}</span></>} meta={t.result ? (t.result.isError ? "error" : `${tokens(Math.round(t.result.content.length / 4))} tokens back`) : "no result recorded"} tone={t.result?.isError ? "error" : "tool"} open={open}>
          <h5>Called with</h5>
          <pre>{JSON.stringify(t.input, null, 2)}</pre>
          <h5>The tool answered</h5>
          <pre>{t.result ? prettyJson(t.result.content) : "The turn ended before the result was sent back to the model."}</pre>
        </Fold>
      ))}
    </article>
  );
}

/** A tool call's arguments in one short line. */
function summarize(input: unknown): string {
  if (input === null || typeof input !== "object") return String(input);
  const text = Object.entries(input as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === "string" ? v.replace(/\s+/g, " ") : JSON.stringify(v)}`).join(", ");
  return text.length > 110 ? `${text.slice(0, 109)}…` : text;
}
