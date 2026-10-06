import { ChevronLeft, ChevronRight, Database, FolderOpen, Search, Table2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { bytes, type Cell, type DbColumn, type DbOverview, type DbRow, inspectHref } from "../lib/observe";
import { Tile, prettyJson, usePolled } from "./inspect-kit";

const PAGE = 50;
const number = (n: number) => n.toLocaleString("en-US");

/** The databases as tables and rows, read-only: how many there are, what is in them, and any row whole. */
export function InspectData({ db, table, ms, onCall }: { db: string | null; table: string | null; ms: number; onCall: (id: string) => void }) {
  const overview = usePolled(() => api.observeData(), [], ms * 2);
  const [internal, setInternal] = useState(false);
  const data = overview.data;
  if (overview.error && !data) return <p className="inspect-note" role="alert">{overview.error}</p>;
  if (!data) return <p className="inspect-empty">Loading…</p>;
  const first = data.databases[0];
  const selected = db && table ? { db, table } : first ? { db: first.id, table: first.tables.find((t) => t.kind !== "internal")?.name ?? "" } : null;
  return (
    <div className="data">
      <section className="tiles" aria-label="The data">
        <Tile label="Databases" value={String(data.totals.databases)} sub={data.databases.map((d) => d.label).join(" · ")} />
        <Tile label="Tables" value={String(data.totals.tables)} sub="not counting index internals" />
        <Tile label="Records" value={number(data.totals.records)} sub={data.index ? `incl. ${number(data.index.documents)} in the embedding index` : "memory search is off"} />
        <Tile label="On disk" value={bytes(data.totals.bytes)} sub={`${data.files.length} more files and folders`} />
      </section>
      <div className="data-split">
        <nav className="tables" aria-label="Tables">
          {data.databases.map((d) => <Tables key={d.id} db={d} selected={selected} internal={internal} />)}
          <label className="check"><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Show index internals</label>
          <h3 className="files-title"><FolderOpen aria-hidden /> Beside the databases</h3>
          <ul className="files">
            {data.files.map((f) => <li key={f.name}><span><b>{f.name}</b><small>{f.about}</small></span><span>{bytes(f.bytes)}{f.files !== null && <small>{number(f.files)} files</small>}</span></li>)}
            {data.index && <li><span><b>Embedding index</b><small>documents</small></span><span>{number(data.index.documents)}</span></li>}
          </ul>
        </nav>
        <section className="viewer" aria-label="Rows">
          {selected && selected.table ? <Viewer key={`${selected.db}/${selected.table}`} db={selected.db} table={selected.table} rows={data.databases.find((d) => d.id === selected.db)?.tables.find((t) => t.name === selected.table)?.rows ?? 0} ms={ms * 2} onCall={onCall} /> : <p className="inspect-empty">Choose a table.</p>}
        </section>
      </div>
    </div>
  );
}

function Tables({ db, selected, internal }: { db: DbOverview; selected: { db: string; table: string } | null; internal: boolean }) {
  const shown = db.tables.filter((t) => internal || t.kind !== "internal");
  const max = Math.max(1, ...shown.map((t) => t.rows));
  return (
    <section className="db">
      <h3><Database aria-hidden /> {db.label} <small>{number(db.records)} records · {bytes(db.bytes)}</small></h3>
      <p className="db-about">{db.about}</p>
      <ul>
        {shown.map((t) => (
          <li key={t.name}>
            <a href={inspectHref("data", db.id, t.name)} data-current={selected?.db === db.id && selected.table === t.name} data-kind={t.kind}>
              <Table2 aria-hidden />
              <span className="t-name">{t.name}{t.kind !== "table" && <em>{t.kind}</em>}</span>
              <span className="t-count">{number(t.rows)}</span>
              <i className="t-bar" style={{ width: `${Math.max(2, (t.rows / max) * 100)}%` }} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Viewer({ db, table, rows: totalRows, ms, onCall }: { db: string; table: string; rows: number; ms: number; onCall: (id: string) => void }) {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ order?: string; dir: "asc" | "desc" }>({ dir: "desc" });
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { const t = setTimeout(() => { setQ(input); setOffset(0); }, 250); return () => clearTimeout(t); }, [input]);
  const page = usePolled(() => api.observeTable(db, table, { offset, limit: PAGE, ...(q ? { q } : {}), ...(sort.order ? { order: sort.order } : {}), dir: sort.dir }), [db, table, offset, q, sort.order, sort.dir], ms);
  const p = page.data;
  const from = p && p.matched ? offset + 1 : 0, to = p ? Math.min(offset + PAGE, p.matched) : 0;
  return (
    <>
      <header className="viewer-head">
        <h3>{db}<span className="muted">.</span>{table} <small>{number(p?.total ?? totalRows)} rows · {p?.columns.length ?? "…"} columns</small></h3>
        <label className="search-box"><Search aria-hidden /><input type="search" placeholder="Search every column" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Search the table" /></label>
        <div className="pager">
          <span>{p ? (p.matched ? `${number(from)}–${number(to)} of ${number(p.matched)}${q ? " matching" : ""}` : "No rows") : ""}</span>
          <button type="button" className="icon-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} aria-label="Previous page"><ChevronLeft aria-hidden /></button>
          <button type="button" className="icon-button" disabled={!p || offset + PAGE >= p.matched} onClick={() => setOffset(offset + PAGE)} aria-label="Next page"><ChevronRight aria-hidden /></button>
        </div>
      </header>
      {page.error && !p && <p className="inspect-note" role="alert">{page.error}</p>}
      {p && (
        <div className="grid-scroll">
          <table className="grid">
            <thead>
              <tr>
                {p.columns.map((c) => (
                  <th key={c.name} aria-sort={sort.order === c.name ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                    <button type="button" onClick={() => { setSort({ order: c.name, dir: sort.order === c.name && sort.dir === "desc" ? "asc" : "desc" }); setOffset(0); }}>
                      {c.name}{c.primaryKey && <em>key</em>}<small>{c.type.toLowerCase()}</small>{sort.order === c.name && <span aria-hidden>{sort.dir === "asc" ? "▲" : "▼"}</span>}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {p.rows.map((row, i) => (
                <tr key={p.ids[i] ?? i} data-open={p.ids[i] === open} tabIndex={0} onClick={() => p.ids[i] != null && setOpen(p.ids[i])} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && p.ids[i] != null && (e.preventDefault(), setOpen(p.ids[i]))}>
                  {row.map((cell, j) => <td key={j} title={typeof cell === "string" ? cell : undefined} data-null={cell === null} data-number={typeof cell === "number"}>{cell === null ? "NULL" : typeof cell === "string" ? cell.replace(/\s+/g, " ") : cell}</td>)}
                </tr>
              ))}
              {!p.rows.length && <tr><td colSpan={p.columns.length} className="muted">No rows.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {open !== null && <RowDetail db={db} table={table} rowid={open} onClose={() => setOpen(null)} onCall={onCall} />}
    </>
  );
}

/** Where a row leads: a message's trace, or a call. */
function links(db: string, table: string, columns: DbColumn[], values: Cell[]): { label: string; href?: string; call?: string }[] {
  const at = (name: string) => values[columns.findIndex((c) => c.name === name)];
  const out: { label: string; href?: string; call?: string }[] = [];
  if (db === "ledger" && table === "events" && at("type") === "user_message" && typeof at("id") === "string") out.push({ label: "Open this message's trace", href: inspectHref("traces", String(at("id"))) });
  if (db === "ledger" && table === "turns" && typeof at("user_event_id") === "string") out.push({ label: "Open the trace of its message", href: inspectHref("traces", String(at("user_event_id"))) });
  if (db === "calls" && table === "calls") {
    if (typeof at("id") === "string") out.push({ label: "Open this call", call: String(at("id")) });
    if (typeof at("user_event_id") === "string") out.push({ label: "Open the trace of its message", href: inspectHref("traces", String(at("user_event_id"))) });
  }
  return out;
}

function RowDetail({ db, table, rowid, onClose, onCall }: { db: string; table: string; rowid: number; onClose: () => void; onCall: (id: string) => void }) {
  const row = usePolled<DbRow>(() => api.observeRow(db, table, rowid), [db, table, rowid], 60_000);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const r = row.data;
  return (
    <aside className="db-row-detail" aria-label="Row">
      <header>
        <h4>{table} <small>row {rowid}</small></h4>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close the row"><X aria-hidden /></button>
      </header>
      {row.error && !r && <p className="inspect-note" role="alert">{row.error}</p>}
      {r && (
        <>
          <p className="chips">{links(db, table, r.columns, r.values).map((l) => l.call ? <button key={l.label} type="button" className="chip chip-link" onClick={() => onCall(l.call!)}>{l.label}</button> : <a key={l.label} className="chip chip-link" href={l.href}>{l.label}</a>)}</p>
          <dl className="fields">
            {r.columns.map((c, i) => {
              const v = r.values[i] ?? null;
              return (
                <div key={c.name}>
                  <dt>{c.name}<small>{c.type.toLowerCase()}{c.primaryKey ? " · key" : ""}</small></dt>
                  <dd>{v === null ? <span className="muted">NULL</span> : typeof v === "number" ? v : <pre>{prettyJson(v)}</pre>}</dd>
                </div>
              );
            })}
          </dl>
        </>
      )}
    </aside>
  );
}
