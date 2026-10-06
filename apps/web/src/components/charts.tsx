import { type ReactNode, useEffect, useRef, useState } from "react";
import { axisLabel, niceTicks } from "../lib/observe";

/**
 * The inspect page's charts: plain SVG, thin marks, hairline grids, a legend
 * for two or more series, a hover readout that lists every series at that
 * point, and a table view of the same numbers. Series colours are the
 * validated categorical slots (`--s1` to `--s5` in inspect.css).
 */

/** A container's width, kept current. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    const watch = new ResizeObserver(() => setWidth(node.clientWidth));
    watch.observe(node);
    return () => watch.disconnect();
  }, []);
  return [ref, width];
}

export interface SeriesDef {
  name: string;
  /** A CSS colour, normally one of the `--s1`…`--s5` variables. */
  color: string;
}

export function Legend({ series }: { series: SeriesDef[] }) {
  return (
    <ul className="legend" aria-label="Legend">
      {series.map((s) => <li key={s.name}><i style={{ background: s.color }} />{s.name}</li>)}
    </ul>
  );
}

/** A card with a title, a legend and a table view of what it draws. */
export function ChartCard({ title, note, series, table, children }: { title: string; note?: ReactNode; series?: SeriesDef[]; table?: { head: string[]; rows: ReactNode[][] }; children: ReactNode }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="chart-card">
      <header>
        <h3>{title}</h3>
        {note && <span className="chart-note">{note}</span>}
        {table && <button type="button" className="chart-toggle" aria-pressed={asTable} onClick={() => setAsTable(!asTable)}>{asTable ? "Chart" : "Table"}</button>}
      </header>
      {series && series.length > 1 && <Legend series={series} />}
      {asTable && table ? (
        <div className="chart-table">
          <table>
            <thead><tr>{table.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : children}
    </section>
  );
}

const HEIGHT = 184;
const M = { left: 44, right: 10, top: 10, bottom: 24 };

/** A rectangle whose top corners are rounded, for the data end of a bar. */
export function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const k = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + k}Q${x},${y} ${x + k},${y}H${x + w - k}Q${x + w},${y} ${x + w},${y + k}V${y + h}Z`;
}

interface Hover {
  index: number;
  /** Pointer position inside the plot, for the readout. */
  x: number;
}

function Readout({ at, bucketMs, rows, hover, width, total }: { at: string; bucketMs: number; rows: { name: string; color: string; value: string }[]; hover: Hover; width: number; total?: string }) {
  const flip = hover.x > width * 0.6;
  return (
    <div className="readout" style={{ left: flip ? undefined : hover.x + 14, right: flip ? width - hover.x + 14 : undefined }} role="status">
      <strong>{bucketMs < 86_400_000 ? `${new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${axisLabel(at, bucketMs)}` : new Date(at).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</strong>
      {rows.map((r) => <div key={r.name}><i style={{ background: r.color }} /><b>{r.value}</b><span>{r.name}</span></div>)}
      {total && <div className="readout-total"><b>{total}</b><span>total</span></div>}
    </div>
  );
}

function XAxis({ at, bucketMs, left, band, y }: { at: string[]; bucketMs: number; left: number; band: number; y: number }) {
  const step = Math.max(1, Math.ceil(at.length / 6));
  return <>{at.map((t, i) => (i % step === 0 ? <text key={t} className="axis-text" x={left + band * (i + 0.5)} y={y} textAnchor="middle">{axisLabel(t, bucketMs)}</text> : null))}</>;
}

/** Columns stacked from the baseline, one per bucket: a segment per series with a 2px gap between. */
export function StackedColumns({ at, bucketMs, series, rows, format, label }: { at: string[]; bucketMs: number; series: SeriesDef[]; rows: number[][]; format: (n: number) => string; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Hover | null>(null);
  const totals = rows.map((r) => r.reduce((a, b) => a + b, 0));
  const ticks = niceTicks(Math.max(0, ...totals), 3);
  const top = ticks.at(-1)!;
  const plotW = Math.max(10, width - M.left - M.right), plotH = HEIGHT - M.top - M.bottom;
  const band = plotW / Math.max(1, at.length);
  const barW = Math.min(24, band * 0.72);
  const y = (v: number) => M.top + plotH - (v / top) * plotH;
  return (
    <div ref={ref} className="chart" onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} style={{ width, height: HEIGHT }} role="img" aria-label={label}
          onPointerMove={(e) => {
            const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
            const index = Math.floor((x - M.left) / band);
            setHover(index >= 0 && index < at.length ? { index, x } : null);
          }}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="gridline" x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} />
              <text className="axis-text" x={M.left - 8} y={y(t) + 4} textAnchor="end">{format(t)}</text>
            </g>
          ))}
          {rows.map((row, i) => {
            const x = M.left + band * i + (band - barW) / 2;
            let base = 0;
            const lastWithValue = row.reduce((k, v, j) => (v > 0 ? j : k), -1);
            return (
              <g key={at[i]} className="column" data-hover={hover?.index === i}>
                {row.map((v, j) => {
                  if (v <= 0) return null;
                  const y0 = y(base), y1 = y(base + v);
                  // A 2px gap in the surface colour above the one below it.
                  const h = Math.max(1, y0 - y1 - (base > 0 ? 2 : 0));
                  base += v;
                  return j === lastWithValue
                    ? <path key={series[j]!.name} d={topRounded(x, y1, barW, h, 4)} fill={series[j]!.color} />
                    : <rect key={series[j]!.name} x={x} y={y1} width={barW} height={h} fill={series[j]!.color} />;
                })}
              </g>
            );
          })}
          {hover && <rect className="hit-band" x={M.left + band * hover.index} y={M.top} width={band} height={plotH} />}
          <XAxis at={at} bucketMs={bucketMs} left={M.left} band={band} y={HEIGHT - 6} />
        </svg>
      )}
      {hover && <Readout at={at[hover.index]!} bucketMs={bucketMs} hover={hover} width={width} rows={series.map((s, j) => ({ name: s.name, color: s.color, value: format(rows[hover.index]![j] ?? 0) })).filter((r, j) => (rows[hover.index]![j] ?? 0) > 0)} total={format(totals[hover.index] ?? 0)} />}
    </div>
  );
}

/** Lines over time, 2px, broken where a series has no value, with a crosshair and one readout for every series. */
export function Lines({ at, bucketMs, series, values, format, max, label }: { at: string[]; bucketMs: number; series: SeriesDef[]; values: (number | null)[][]; format: (n: number) => string; max?: number; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<Hover | null>(null);
  const top = max ?? niceTicks(Math.max(0, ...values.flat().map((v) => v ?? 0)), 3).at(-1)!;
  const ticks = max !== undefined ? niceTicks(max, 4).filter((t) => t <= max) : niceTicks(top, 3);
  const plotW = Math.max(10, width - M.left - M.right), plotH = HEIGHT - M.top - M.bottom;
  const band = plotW / Math.max(1, at.length);
  const x = (i: number) => M.left + band * (i + 0.5);
  const y = (v: number) => M.top + plotH - (Math.min(v, top) / top) * plotH;
  const path = (vs: (number | null)[]) => {
    let d = "";
    vs.forEach((v, i) => { d += v === null ? "" : `${d && vs[i - 1] !== null && vs[i - 1] !== undefined ? "L" : "M"}${x(i)},${y(v)}`; });
    return d;
  };
  return (
    <div ref={ref} className="chart" onPointerLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} style={{ width, height: HEIGHT }} role="img" aria-label={label}
          onPointerMove={(e) => {
            const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
            const index = Math.floor((px - M.left) / band);
            setHover(index >= 0 && index < at.length ? { index, x: x(index) } : null);
          }}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="gridline" x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} />
              <text className="axis-text" x={M.left - 8} y={y(t) + 4} textAnchor="end">{format(t)}</text>
            </g>
          ))}
          {hover && <line className="crosshair" x1={x(hover.index)} x2={x(hover.index)} y1={M.top} y2={M.top + plotH} />}
          {series.map((s, j) => {
            const last = values[j]!.reduce<number>((k, v, i) => (v !== null ? i : k), -1);
            return (
              <g key={s.name}>
                {series.length === 1 && values[j]!.some((v) => v !== null) && <path d={`${path(values[j]!)}L${x(last)},${M.top + plotH}L${x(values[j]!.findIndex((v) => v !== null))},${M.top + plotH}Z`} fill={s.color} opacity={0.1} stroke="none" />}
                <path d={path(values[j]!)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {values[j]!.map((v, i) => (v !== null && values[j]![i - 1] == null && values[j]![i + 1] == null ? <circle key={i} className="dot" cx={x(i)} cy={y(v)} r={4} fill={s.color} /> : null))}
                {last >= 0 && <circle className="dot" cx={x(last)} cy={y(values[j]![last]!)} r={4} fill={s.color} />}
                {hover && values[j]![hover.index] != null && <circle className="dot" cx={x(hover.index)} cy={y(values[j]![hover.index]!)} r={4} fill={s.color} />}
              </g>
            );
          })}
          <XAxis at={at} bucketMs={bucketMs} left={M.left} band={band} y={HEIGHT - 6} />
        </svg>
      )}
      {hover && <Readout at={at[hover.index]!} bucketMs={bucketMs} hover={hover} width={width} rows={series.map((s, j) => ({ name: s.name, color: s.color, value: values[j]![hover.index] == null ? "–" : format(values[j]![hover.index]!) }))} />}
    </div>
  );
}

/** A tiny trend line for a tile: no axes, the current end marked. */
export function Spark({ values, color = "var(--s1)" }: { values: (number | null)[]; color?: string }) {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return <div className="spark" aria-hidden />;
  const max = Math.max(...nums), min = Math.min(...nums, 0);
  const span = max - min || 1;
  const w = 100, h = 28;
  const pts = values.map((v, i) => (v === null ? null : [(i / (values.length - 1)) * w, h - 3 - ((v - min) / span) * (h - 6)] as const));
  const d = pts.reduce((s, p, i) => (p ? `${s}${s && pts[i - 1] ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}` : s), "");
  const last = [...pts].reverse().find(Boolean);
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      {last && <circle cx={last[0]} cy={last[1]} r={0} />}
    </svg>
  );
}

/** Horizontal bars with the value at the tip, longest first. */
export function HBars({ items, format }: { items: { label: string; sub?: string; value: number; color: string }[]; format: (n: number) => string }) {
  const max = Math.max(...items.map((i) => i.value), 0) || 1;
  return (
    <ul className="hbars">
      {items.map((i) => (
        <li key={i.label}>
          <span className="hbar-label" title={i.label}>{i.label}{i.sub && <small>{i.sub}</small>}</span>
          <span className="hbar-track"><i style={{ width: `${(i.value / max) * 100}%`, background: i.color }} /></span>
          <b>{format(i.value)}</b>
        </li>
      ))}
    </ul>
  );
}
