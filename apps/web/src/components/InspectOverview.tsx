import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { asked, dayLabel } from "../lib/model";
import {
  average, type Breakdown, bytes, type DeciderStats, duration, inspectHref, type PriceRow, percent, type Range, ratio, roleLabel, shortModel, speed, stacked, type Summary, tokenRows, tokens, totalPerBucket, usd,
} from "../lib/observe";
import { ChartCard, HBars, Lines, type SeriesDef, StackedColumns } from "./charts";
import { MoveChip, PromptBar, Tile, usePolled } from "./inspect-kit";

const GROUP_COLORS: Record<string, string> = { Agent: "var(--s1)", Router: "var(--s2)", Compaction: "var(--s3)", "Wrap-up and repair": "var(--s4)", Decider: "var(--s6)", Other: "var(--s5)" };
const ROLE_NAME: Record<string, string> = { work: "Agent", wrap_up: "Wrap-up", repair: "Repair", router: "Router", compaction: "Compaction", embedding: "Embeddings", decision: "Memory decider", other: "Other" };

/** The overview: totals with their trends, the day's calls, tokens, cache, speed and cost over time, and what is happening now. */
export function InspectOverview({ range, ms, onCall }: { range: Range; ms: number; onCall: (id: string) => void }) {
  const summary = usePolled(() => api.observeSummary(range), [range], ms);
  const series = usePolled(() => api.observeSeries(range), [range], ms);
  const recent = usePolled(() => api.observeRecent(14), [], ms);
  const costly = usePolled(() => api.observeCostly(range), [range], ms);
  const decider = usePolled(() => api.observeDecider(range), [range], ms);
  const error = summary.error ?? series.error;
  const s = summary.data;
  const sr = series.data;
  if (error && !s) return <p className="inspect-note" role="alert">{error}</p>;
  if (!s || !sr) return <p className="inspect-empty">Loading…</p>;

  const t = s.totals, w = s.work;
  const agentRoles = ["work", "wrap_up", "repair"] as const;
  const calls = stacked(sr, (b) => b.calls);
  const callSeries: SeriesDef[] = calls.groups.map((g) => ({ name: g, color: GROUP_COLORS[g]! }));
  const tokenSeries: SeriesDef[] = [{ name: "Prompt from the cache", color: "var(--s3)" }, { name: "Prompt sent fresh", color: "var(--s1)" }, { name: "Output", color: "var(--s5)" }];
  const rows = tokenRows(sr);
  const cacheAgent = ratio(sr, [...agentRoles], (b) => b.cacheReadTokens, (b) => b.promptTokens);
  const cacheRouter = ratio(sr, ["router"], (b) => b.cacheReadTokens, (b) => b.promptTokens);
  const measuredSpeeds = (b: typeof sr.buckets[number]) => b.speedSamples ?? b.calls;
  const measuredFirsts = (b: typeof sr.buckets[number]) => b.firstTokenSamples ?? b.calls;
  const speedAgent = average(sr, [...agentRoles], (b) => b.tokensPerSecond, measuredSpeeds);
  const speedRouter = average(sr, ["router"], (b) => b.tokensPerSecond, measuredSpeeds);
  const firstAgent = average(sr, [...agentRoles], (b) => b.firstTokenMs, measuredFirsts);
  const hit = (r: number | null) => (r === null ? undefined : r >= 0.8 ? "good" : r < 0.4 ? "warn" : undefined);
  const cost = totalPerBucket(sr, (b) => b.costUsd);
  const calledPerBucket = totalPerBucket(sr, (b) => b.calls);
  const costByRole = Object.entries(s.byModel.filter((r) => r.role !== "embedding").reduce<Record<string, number>>((acc, r) => ({ ...acc, [`${ROLE_NAME[r.role]} · ${shortModel(r.model).replace(/^[^:]*:/, "")}`]: (acc[`${ROLE_NAME[r.role]} · ${shortModel(r.model).replace(/^[^:]*:/, "")}`] ?? 0) + r.costUsd }), {})).map(([label, value]) => ({ label, value, color: "var(--s1)" })).sort((a, b) => b.value - a.value);
  const widest = Math.max(1, ...(recent.data ?? []).map((c) => c.promptTokens));

  return (
    <div className="overview">
      <section className="tiles" aria-label="Totals">
        <Tile label="Recorded cost" value={usd(s.unpricedCalls && !t.priced ? null : t.costUsd)} sub={s.unpricedCalls ? `${t.priced ? "Partial · " : ""}${s.unpricedCalls} call${s.unpricedCalls === 1 ? "" : "s"} with no price` : "reported or estimated from prices"} tone={s.unpricedCalls ? "warn" : undefined} trend={cost} color="var(--s1)" />
        <Tile label="Model calls" value={String(s.byModel.filter((r) => r.role !== "embedding").reduce((n, r) => n + r.calls, 0))} sub={`${t.failed} failed · ${t.stopped} stopped`} tone={t.failed ? "warn" : undefined} trend={calledPerBucket} color="var(--s2)" />
        <Tile label="Agent cache hit" value={percent(w.cacheHitRate)} sub={`${tokens(w.cacheReadTokens)} of ${tokens(w.promptTokens)} prompt tokens`} tone={hit(w.cacheHitRate)} trend={cacheAgent} color="var(--s3)" />
        <Tile label="Tokens in" value={tokens(t.promptTokens)} sub={`${tokens(t.outputTokens)} out · ${percent(t.cacheHitRate)} cached overall`} trend={totalPerBucket(sr, (b) => b.promptTokens)} color="var(--s1)" />
        <Tile label="Output rate" value={speed(w.tokensPerSecond)} sub="mean of agent call rates" trend={speedAgent} color="var(--s5)" />
        <Tile label="First output" value={duration(w.firstTokenMs)} sub="streamed text or thinking" trend={firstAgent} color="var(--s4)" />
      </section>

      <div className="grid-2">
        <ChartCard title="Model calls" note="per hour or day" series={callSeries}
          table={{ head: ["Time", ...calls.groups], rows: sr.at.map((a, i) => [new Date(a).toLocaleString(), ...calls.rows[i]!.map(String)]) }}>
          <StackedColumns at={sr.at} bucketMs={sr.bucketMs} series={callSeries} rows={calls.rows} format={(n) => String(Math.round(n * 10) / 10)} label="Model calls over time, stacked by what they were for" />
        </ChartCard>
        <ChartCard title="Tokens" note="what went in and out" series={tokenSeries}
          table={{ head: ["Time", ...tokenSeries.map((x) => x.name)], rows: sr.at.map((a, i) => [new Date(a).toLocaleString(), ...rows[i]!.map(tokens)]) }}>
          <StackedColumns at={sr.at} bucketMs={sr.bucketMs} series={tokenSeries} rows={rows} format={tokens} label="Tokens over time: prompt from the cache, prompt sent fresh, and output" />
        </ChartCard>
      </div>

      <div className="grid-3">
        <ChartCard title="Cache hit rate" note="share of prompt tokens served from cache" series={[{ name: "Agent", color: "var(--s1)" }, { name: "Router", color: "var(--s2)" }]}
          table={{ head: ["Time", "Agent", "Router"], rows: sr.at.map((a, i) => [new Date(a).toLocaleString(), percent(cacheAgent[i] ?? null), percent(cacheRouter[i] ?? null)]) }}>
          <Lines at={sr.at} bucketMs={sr.bucketMs} series={[{ name: "Agent", color: "var(--s1)" }, { name: "Router", color: "var(--s2)" }]} values={[cacheAgent, cacheRouter]} max={1} format={(n) => percent(n)} label="Cache hit rate over time for the agent and the router" />
        </ChartCard>
        <ChartCard title="Output rate" note="mean output / call seconds" series={[{ name: "Agent", color: "var(--s1)" }, { name: "Router", color: "var(--s2)" }]}
          table={{ head: ["Time", "Agent", "Router"], rows: sr.at.map((a, i) => [new Date(a).toLocaleString(), speed(speedAgent[i] ?? null), speed(speedRouter[i] ?? null)]) }}>
          <Lines at={sr.at} bucketMs={sr.bucketMs} series={[{ name: "Agent", color: "var(--s1)" }, { name: "Router", color: "var(--s2)" }]} values={[speedAgent, speedRouter]} format={speed} label="Mean call output rates over time for the agent and the router" />
        </ChartCard>
        <ChartCard title="Time to first output" note="the agent, streamed"
          table={{ head: ["Time", "First output"], rows: sr.at.map((a, i) => [new Date(a).toLocaleString(), duration(firstAgent[i] ?? null)]) }}>
          <Lines at={sr.at} bucketMs={sr.bucketMs} series={[{ name: "Agent", color: "var(--s1)" }]} values={[firstAgent]} format={(n) => duration(n)} label="The agent's time to first token over time" />
        </ChartCard>
      </div>

      <section className="panel" aria-label="By model">
          <h3>By model</h3>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Used for</th><th>Model</th><th>Calls</th><th>Prompt</th><th>Cached</th><th>Output</th><th>Output rate</th><th>First output</th><th>Cost</th></tr></thead>
              <tbody>
                {s.byModel.map((r: Breakdown) => (
                  <tr key={`${r.role}/${r.model}`}>
                    <td>{ROLE_NAME[r.role]}</td>
                    <td><code title={r.model}>{shortModel(r.model)}</code></td>
                    <td>{r.calls}{r.failed ? <em className="failed"> ({r.failed} failed)</em> : null}{r.stopped ? <em className="muted"> ({r.stopped} stopped)</em> : null}</td>
                    <td>{tokens(r.promptTokens)}</td>
                    <td>{percent(r.cacheHitRate)}</td>
                    <td>{tokens(r.outputTokens)}</td>
                    <td>{speed(r.tokensPerSecond)}</td>
                    <td>{duration(r.firstTokenMs)}</td>
                    <td>{r.role === "embedding" ? "–" : usd(r.priced ? r.costUsd : null)}</td>
                  </tr>
                ))}
                {!s.byModel.length && <tr><td colSpan={9} className="muted">No calls in this range.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

      {decider.data && decider.data.answered + decider.data.failed > 0 && <DeciderPanel d={decider.data} />}

      <div className="grid-2">
        <section className="panel" aria-label="Cost by model">
          <h3>Where the money went</h3>
          {costByRole.some((i) => i.value > 0) ? <HBars items={costByRole} format={usd} /> : <p className="inspect-empty">Nothing priced in this range.</p>}
          <p className="inspect-foot">Calls are kept {s.retentionDays} days · the log takes {bytes(s.storedBytes)}.</p>
        </section>
        <section className="panel" aria-label="Costliest questions">
          <h3>Costliest questions</h3>
          <ul className="costly">
            {(costly.data ?? []).map((q) => (
              <li key={q.userEventId}>
                <a href={inspectHref("traces", q.userEventId)}>
                  <span className="costly-text">{q.message.trim() || "An image"}</span>
                  <span className="costly-meta">
                    {q.parts[0] && <MoveChip move={q.parts[0].move} />}
                    <span>{q.calls} calls</span><span>{percent(q.cacheHitRate)} cached</span>
                    <time dateTime={q.at}>{dayLabel(q.at)}, {asked(q.at)}</time>
                  </span>
                  <b>{usd(q.priced ? q.costUsd : null)}</b>
                </a>
              </li>
            ))}
            {!costly.data?.length && <li className="muted">Nothing yet.</li>}
          </ul>
        </section>
      </div>

      <section className="panel" aria-label="Latest calls">
          <h3>Latest calls <span className="live-dot" aria-hidden /></h3>
          <ul className="feed">
            {(recent.data ?? []).map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => onCall(c.id)} data-failed={!c.ok && c.error?.kind !== "aborted"}>
                  <time dateTime={c.startedAt}>{asked(c.startedAt)}</time>
                  <span className="feed-name">{roleLabel(c)}<small><code>{shortModel(c.model)}</code></small></span>
                  <span className="feed-bar">{c.role === "embedding" ? <small className="muted">{c.ok ? "embedded" : "failed"}</small> : <PromptBar call={c} widest={widest} />}</span>
                  <span className="feed-num">{c.role === "embedding" ? "" : `${tokens(c.promptTokens)} in · ${tokens(c.outputTokens)} out`}</span>
                  <span className="feed-num">{duration(c.ms)}</span>
                  <span className="feed-num">{c.error ? (c.error.kind === "aborted" ? "stopped" : "failed") : usd(c.costUsd)}</span>
                </button>
              </li>
            ))}
            {!recent.data?.length && <li className="muted">No calls yet. Ask Socrates something.</li>}
          </ul>
        </section>

      <Prices summary={s} />
    </div>
  );
}

/** Each model with the price in force; a model with none says its calls are not in the cost. */
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
    <section className="panel" aria-label="Prices">
      <h3>Prices <small>US dollars per million tokens</small></h3>
      <ul className="prices">
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

/** What the memory decider said and what followed: the rates its thresholds are set from. */
function DeciderPanel({ d }: { d: DeciderStats }) {
  const of = (n: number, total: number) => (total ? `${n} of ${total}` : "–");
  return (
    <section className="panel" aria-label="Memory decider">
      <h3>Memory decider</h3>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Question</th><th>Said likely</th><th>Then</th><th>Said unlikely</th><th>Then anyway</th></tr></thead>
          <tbody>
            <tr><td>Would a recall help?</td><td>{d.recall.likely}</td><td>{of(d.recall.likelyOffered, d.recall.likely)} offered</td><td>{d.recall.unlikely}</td><td>{of(d.recall.unlikelyOffered, d.recall.unlikely)} offered</td></tr>
            {d.work.likely + d.work.unlikely > 0 && <tr><td>Was the work worth recording?</td><td>{d.work.likely}</td><td>{of(d.work.likelyWrote, d.work.likely)} wrote project notes</td><td>{d.work.unlikely}</td><td>–</td></tr>}
            <tr><td>Is something worth saving?</td><td>{d.save.likely}</td><td>{of(d.save.likelySaved, d.save.likely)} saved</td><td>{d.save.unlikely}</td><td>{of(d.save.unlikelySaved, d.save.unlikely)} saved</td></tr>
          </tbody>
        </table>
      </div>
      <p className="inspect-foot">{d.answered} answered{d.failed ? `, ${d.failed} failed` : ""} · median {duration(d.medianMs)} · {usd(d.costUsd)}. A save the agent made when the decider said unlikely is a miss; a likely one it ignored cost one line.</p>
    </section>
  );
}
