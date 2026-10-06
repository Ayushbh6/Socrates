import { ArrowLeft, ArrowRight, GitBranch, Layers } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { asked, dayLabel } from "../lib/model";
import {
  type Breakdown, type CallRow, MOVES, type PartView, type PriceRow, type QuestionDetail, type QuestionRow, RANGES, type Range, type Summary,
  bytes, duration, percent, promptSplit, roleLabel, shortModel, speed, switched, tokens, usd,
} from "../lib/observe";
import type { AppState } from "../lib/store";
import { InspectCall } from "./InspectCall";
import "../inspect.css";

/** How often the page asks again while it is open, and while Socrates is working. */
const POLL_MS = 5_000;
const POLL_BUSY_MS = 1_500;

/** Fetches again every `ms` while the page is open; a failure keeps what was shown and says so. */
function usePolled<T>(load: () => Promise<T>, deps: unknown[], ms: number): { data: T | null; error: string | null } {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let alive = true;
    const run = () => loader.current().then(
      (data) => alive && setState({ data, error: null }),
      (error: Error) => alive && setState((s) => ({ data: s.data, error: error.message })),
    );
    void run();
    const timer = setInterval(() => { if (!document.hidden) void run(); }, ms);
    return () => { alive = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ms]);
  return state;
}

/**
 * The inspect page (architecture/web.md, "Inspect"): what every question cost,
 * how much of each prompt the provider's cache served, where each message
 * sent the work, and the exact context behind any single call.
 */
export function Inspect({ app, question }: { app: AppState; question: string | null }) {
  const [range, setRange] = useState<Range>("24h");
  const [call, setCall] = useState<string | null>(null);
  const busy = app.model.live?.busy ?? false;
  const ms = busy ? POLL_BUSY_MS : POLL_MS;
  const summary = usePolled(() => api.observeSummary(range), [range], ms);
  const list = usePolled(() => api.observeQuestions(range), [range], ms);
  const questions = list.data?.questions ?? [];
  // The newest question is open until another is chosen.
  const openId = question ?? questions[0]?.userEventId ?? null;
  const detail = usePolled(() => (openId ? api.observeQuestion(openId) : Promise.resolve(null)), [openId], ms);
  const error = summary.error ?? list.error;
  const choose = useCallback((id: string) => { location.hash = `#/inspect/${id}`; setCall(null); }, []);

  return (
    <main className="inspect">
      <header className="inspect-head">
        <a className="quiet-button" href="#/chat"><ArrowLeft aria-hidden /> Back to chat</a>
        <h1>Inspect</h1>
        <div className="range-tabs" role="radiogroup" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.id} type="button" role="radio" aria-checked={range === r.id} data-on={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>
      </header>

      {error && !summary.data && <p className="inspect-note" role="alert">{error}</p>}
      {summary.data && (
        <>
          <Tiles summary={summary.data} />
          <Prices summary={summary.data} />
          <Models rows={summary.data.byModel} />
          <p className="inspect-foot">Calls are kept {summary.data.retentionDays} days · {bytes(summary.data.storedBytes)} stored · refreshes {busy ? "every second or two while Socrates works" : "every few seconds"}</p>
        </>
      )}

      <div className="inspect-split">
        <QuestionList questions={questions} open={openId} onChoose={choose} loading={!list.data && !list.error} />
        <section className="inspect-detail" aria-label="The question">
          {detail.data ? <Question detail={detail.data} call={call} onCall={setCall} /> : <p className="inspect-empty">{openId ? "Loading…" : "Ask Socrates something and every model call made for it shows up here."}</p>}
        </section>
      </div>
      {call && <InspectCall id={call} onClose={() => setCall(null)} />}
    </main>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: ReactNode; tone?: "good" | "warn" }) {
  return (
    <div className="tile" data-tone={tone}>
      <span className="tile-label">{label}</span>
      <strong className="tile-value">{value}</strong>
      {sub && <span className="tile-sub">{sub}</span>}
    </div>
  );
}

function Tiles({ summary }: { summary: Summary }) {
  const { totals: t, work: w } = summary;
  const hit = (r: number | null) => (r === null ? undefined : r >= 0.8 ? "good" : r < 0.4 ? "warn" : undefined);
  return (
    <section className="tiles" aria-label="Totals">
      <Tile label="Spent" value={usd(t.costUsd)} sub={summary.unpricedCalls ? `${summary.unpricedCalls} call${summary.unpricedCalls === 1 ? "" : "s"} with no price` : `${t.calls} calls`} tone={summary.unpricedCalls ? "warn" : undefined} />
      <Tile label="Agent cache hit" value={percent(w.cacheHitRate)} sub={`${tokens(w.cacheReadTokens)} of ${tokens(w.promptTokens)} prompt tokens`} tone={hit(w.cacheHitRate)} />
      <Tile label="All calls cache hit" value={percent(t.cacheHitRate)} sub={`${tokens(t.cacheReadTokens)} of ${tokens(t.promptTokens)}`} tone={hit(t.cacheHitRate)} />
      <Tile label="Tokens" value={`${tokens(t.promptTokens)} in`} sub={`${tokens(t.outputTokens)} out`} />
      <Tile label="Speed" value={speed(t.tokensPerSecond)} sub="while generating" />
      <Tile label="First token" value={duration(t.firstTokenMs)} sub="streamed calls" />
      {t.failed > 0 && <Tile label="Failed calls" value={String(t.failed)} tone="warn" />}
    </section>
  );
}

/** Models with no price: their calls are not in the cost until the user says what they cost. */
function Prices({ summary }: { summary: Summary }) {
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ input: "", cachedInput: "", output: "" });
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { void api.observePrices().then(setRows, () => {}); }, [summary.byModel.length, summary.unpriced.join(",")]);
  if (!rows.length) return null;
  const edit = (row: PriceRow) => {
    setEditing(row.model);
    setProblem(null);
    setDraft({ input: String(row.price?.input ?? ""), cachedInput: String(row.price?.cachedInput ?? ""), output: String(row.price?.output ?? "") });
  };
  const save = async () => {
    const number = (v: string) => (v.trim() === "" ? null : Number(v));
    const input = number(draft.input), output = number(draft.output), cachedInput = number(draft.cachedInput);
    if (input === null || output === null || [input, output, cachedInput].some((n) => n !== null && (!Number.isFinite(n) || n < 0))) return setProblem("Give the input and output price as numbers, in dollars per million tokens.");
    try {
      const current = (await api.settings()).prices;
      await api.setSettings({ prices: { ...current, [editing!]: { input, cachedInput, cacheWrite: null, output } } });
      setRows(await api.observePrices());
      setEditing(null);
    } catch (e) {
      setProblem((e as Error).message);
    }
  };
  return (
    <section className="prices" aria-label="Prices">
      <h2>Prices <small>US dollars per million tokens</small></h2>
      <ul>
        {rows.map((row) => (
          <li key={row.model} data-missing={row.price === null}>
            <code>{row.model}</code>
            {editing === row.model ? (
              <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
                <label>in<input inputMode="decimal" value={draft.input} onChange={(e) => setDraft({ ...draft, input: e.target.value })} autoFocus /></label>
                <label>cached<input inputMode="decimal" value={draft.cachedInput} placeholder="= in" onChange={(e) => setDraft({ ...draft, cachedInput: e.target.value })} /></label>
                <label>out<input inputMode="decimal" value={draft.output} onChange={(e) => setDraft({ ...draft, output: e.target.value })} /></label>
                <button type="submit" className="solid-button">Save</button>
                <button type="button" className="quiet-button" onClick={() => setEditing(null)}>Cancel</button>
              </form>
            ) : (
              <>
                <span className="price-text">{row.price ? `in ${row.price.input} · cached ${row.price.cachedInput ?? "= in"} · out ${row.price.output}` : "No price known: these calls are not in the cost"}</span>
                <small>{row.source === "settings" ? "yours" : row.source === "list" ? "OpenRouter's list price" : ""}</small>
                <button type="button" className="quiet-button" onClick={() => edit(row)}>{row.price ? "Change" : "Set a price"}</button>
              </>
            )}
          </li>
        ))}
      </ul>
      {problem && <p className="inspect-note" role="alert">{problem}</p>}
    </section>
  );
}

function Models({ rows }: { rows: Breakdown[] }) {
  if (!rows.length) return null;
  return (
    <section className="models" aria-label="By model">
      <h2>By model</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Used for</th><th>Model</th><th>Calls</th><th>Prompt</th><th>Cached</th><th>Output</th><th>Speed</th><th>First token</th><th>Cost</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.role}/${r.model}`}>
                <td>{r.role === "work" ? "Agent" : r.role === "wrap_up" ? "Wrap-up" : r.role === "repair" ? "Repair" : r.role === "router" ? "Router" : r.role === "compaction" ? "Compaction" : r.role === "embedding" ? "Embeddings" : r.role}</td>
                <td><code title={r.model}>{shortModel(r.model)}</code></td>
                <td>{r.calls}{r.failed ? <em className="failed"> ({r.failed} failed)</em> : null}</td>
                <td>{tokens(r.promptTokens)}</td>
                <td>{percent(r.cacheHitRate)}</td>
                <td>{tokens(r.outputTokens)}</td>
                <td>{speed(r.tokensPerSecond)}</td>
                <td>{duration(r.firstTokenMs)}</td>
                <td>{r.role === "embedding" ? "–" : usd(r.priced ? r.costUsd : null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function QuestionList({ questions, open, onChoose, loading }: { questions: QuestionRow[]; open: string | null; onChoose: (id: string) => void; loading: boolean }) {
  const groups: { day: string; items: QuestionRow[] }[] = [];
  for (const q of questions) {
    const day = dayLabel(q.at);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1)!.items.push(q);
  }
  return (
    <nav className="question-list" aria-label="Questions">
      <h2>Questions</h2>
      {!questions.length && <p className="inspect-empty">{loading ? "Loading…" : "No calls in this time range."}</p>}
      {groups.map((g) => (
        <div key={g.day}>
          <p className="sidebar-day">{g.day}</p>
          {g.items.map((q) => {
            const move = q.parts[0]?.move;
            return (
              <button key={q.userEventId} type="button" className="q-row" data-current={q.userEventId === open} onClick={() => onChoose(q.userEventId)}>
                <span className="q-text">{q.message.trim() || "An image"}</span>
                <span className="q-meta">
                  {move && switched(move) && <b className="chip-move" data-move={move}>{MOVES[move]}</b>}
                  {q.outcome === "clarify" && <b className="chip-move" data-move="ask">Asked back</b>}
                  <span>{q.calls} calls</span>
                  <span>{usd(q.priced ? q.costUsd : null)}</span>
                  <span>{percent(q.cacheHitRate)} cached</span>
                  <time dateTime={q.at}>{asked(q.at)}</time>
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function Place({ place }: { place: { goal: { number: number; title: string }; task: { number: number; title: string } } }) {
  return <span className="place"><b>g{place.goal.number}</b> {place.goal.title} <ArrowRight aria-hidden className="place-sep" /> <b>t{place.task.number}</b> {place.task.title}</span>;
}

function Part({ part }: { part: PartView }) {
  return (
    <li className="part">
      <div className="part-move">
        <b className="chip-move" data-move={part.move}>{MOVES[part.move]}</b>
        {part.route && <code title="The router's own words for the choice">{part.route}</code>}
      </div>
      {part.from && part.move !== "continued" && <p className="part-from">From <Place place={part.from} /></p>}
      <p className="part-to">{part.move === "continued" ? "Stayed on " : "Now on "}<Place place={part.to} /></p>
      {part.compactions.map((c) => (
        <p key={c.count} className="part-compaction"><Layers aria-hidden /> Context compacted: {tokens(c.before_tokens)} → {tokens(c.after_tokens)} tokens ({c.layers.join(", ")}{c.checkpoint ? `, saved as ${c.checkpoint}` : ""})</p>
      ))}
    </li>
  );
}

function Question({ detail, call, onCall }: { detail: QuestionDetail; call: string | null; onCall: (id: string) => void }) {
  const { question: q, routing, totals } = detail;
  const widest = Math.max(1, ...detail.calls.map((c) => c.promptTokens));
  return (
    <>
      <header className="question-head">
        <p className="question-text">{q.message}</p>
        <p className="question-sub">{dayLabel(q.at)}, {asked(q.at)}{q.lane ? ` · lane ${q.lane}` : ""} · {totals.calls} calls · {usd(totals.priced ? totals.costUsd : null)} · {percent(totals.cacheHitRate)} cached · {duration(totals.ms)} of model time</p>
      </header>

      <section className="routing" aria-label="Where it went">
        <h2><GitBranch aria-hidden /> Where it went</h2>
        {detail.parts.length > 0 && <ul>{detail.parts.map((p) => <Part key={p.turnId} part={p} />)}</ul>}
        {detail.clarification && <p className="routing-ask">The router asked back: “{detail.clarification}”</p>}
        {routing && (
          <p className="routing-by">
            Chosen by <code>{routing.model}</code> in {routing.attempts} attempt{routing.attempts === 1 ? "" : "s"}{routing.escalated ? ", escalated to the main model" : ""}{routing.fallback ? `, by the fallback “${routing.fallback}”` : ""} with {routing.ledgerQueries} ledger {routing.ledgerQueries === 1 ? "query" : "queries"}.
            {routing.reason && <> Its reason: “{routing.reason}”</>}
          </p>
        )}
        {!detail.parts.length && !detail.clarification && <p className="inspect-empty">This message was not routed.</p>}
      </section>

      <section className="calls" aria-label="Model calls">
        <h2>Model calls</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>#</th><th>Call</th><th>Prompt (cached · written · fresh)</th><th>Output</th><th>First token</th><th>Speed</th><th>Time</th><th>Cost</th></tr>
            </thead>
            <tbody>
              {detail.calls.map((c, i) => <CallLine key={c.id} index={i + 1} call={c} widest={widest} open={call === c.id} onOpen={() => onCall(c.id)} />)}
            </tbody>
          </table>
        </div>
        <p className="inspect-foot">Click a call to see exactly what the model was given and what it said.</p>
      </section>
    </>
  );
}

function CallLine({ index, call: c, widest, open, onOpen }: { index: number; call: CallRow; widest: number; open: boolean; onOpen: () => void }) {
  const split = promptSplit(c);
  const width = (n: number) => `${(n / widest) * 100}%`;
  return (
    <tr className="call-row" data-open={open} data-failed={!c.ok} tabIndex={0} onClick={onOpen} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}>
      <td>{index}</td>
      <td><span className="call-name">{roleLabel(c)}</span><small><code>{c.model}</code>{c.stopReason && c.stopReason !== "end" ? ` · ${c.stopReason}` : ""}{c.error ? ` · ${c.error.kind}` : ""}</small></td>
      <td className="prompt-cell">
        <div className="prompt-bar" role="img" aria-label={`${tokens(split.cached)} cached, ${tokens(split.written)} written, ${tokens(split.fresh)} fresh`}>
          <i data-part="cached" style={{ width: width(split.cached) }} />
          <i data-part="written" style={{ width: width(split.written) }} />
          <i data-part="fresh" style={{ width: width(split.fresh) }} />
        </div>
        <small>{tokens(c.promptTokens)} · {percent(c.promptTokens ? c.cacheReadTokens / c.promptTokens : null)} cached</small>
      </td>
      <td>{tokens(c.outputTokens)}{c.reasoningTokens ? <small> {tokens(c.reasoningTokens)} thinking</small> : null}</td>
      <td>{duration(c.firstTokenMs)}</td>
      <td>{speed(c.tokensPerSecond)}</td>
      <td>{duration(c.ms)}</td>
      <td>{usd(c.costUsd)}{c.costSource === "reported" ? <small> reported</small> : null}</td>
    </tr>
  );
}

