import { X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/api";
import { type CallDetail, bytes, duration, messageText, percent, promptSplit, roleLabel, speed, tokens, usd } from "../lib/observe";

type Tab = "context" | "response" | "provider";
const TABS: { id: Tab; label: string }[] = [
  { id: "context", label: "What it was given" },
  { id: "response", label: "What it said" },
  { id: "provider", label: "Provider details" },
];

/** One model call, whole: its context in the order it was sent, its reply, and everything the provider reported. */
export function InspectCall({ id, onClose }: { id: string; onClose: () => void }) {
  const [call, setCall] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("context");
  useEffect(() => {
    setCall(null);
    setError(null);
    let alive = true;
    api.observeCall(id).then((c) => alive && setCall(c), (e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [id]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" aria-label="Model call">
        <header className="drawer-head">
          <div>
            <strong>{call ? roleLabel(call) : "Model call"}</strong>
            {call && <small><code>{call.model}</code>{call.servedBy && call.servedBy !== call.model.split(":").slice(1).join(":") ? ` served by ${call.servedBy}` : ""}</small>}
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X aria-hidden /></button>
        </header>
        {error && <p className="inspect-note" role="alert">{error}</p>}
        {!call && !error && <p className="inspect-empty">Loading…</p>}
        {call && (
          <>
            <Facts call={call} />
            <div className="range-tabs drawer-tabs" role="tablist">
              {TABS.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-on={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
            </div>
            <div className="drawer-body">
              {tab === "context" && <Context call={call} />}
              {tab === "response" && <Response call={call} />}
              {tab === "provider" && <Provider call={call} />}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function Facts({ call: c }: { call: CallDetail }) {
  const split = promptSplit(c);
  const fact = (label: string, value: string) => <div><dt>{label}</dt><dd>{value}</dd></div>;
  return (
    <dl className="facts">
      {fact("Prompt", `${tokens(c.promptTokens)} tokens`)}
      {fact("Cached", `${tokens(split.cached)} (${percent(c.promptTokens ? split.cached / c.promptTokens : null)})`)}
      {c.cacheWriteTokens > 0 && fact("Written to cache", tokens(c.cacheWriteTokens))}
      {fact("Output", `${tokens(c.outputTokens)}${c.reasoningTokens ? `, ${tokens(c.reasoningTokens)} thinking` : ""}`)}
      {fact("First token", duration(c.firstTokenMs))}
      {fact("Speed", speed(c.tokensPerSecond))}
      {fact("Total time", duration(c.ms))}
      {fact("Cost", `${usd(c.costUsd)}${c.costSource ? ` (${c.costSource === "reported" ? "reported by the provider" : "from the price"})` : ""}`)}
      {c.error && fact("Failed", `${c.error.kind}${c.error.status ? ` ${c.error.status}` : ""}: ${c.error.message}`)}
    </dl>
  );
}

/** A named block that opens to its text. */
function Fold({ title, meta, children, open = false, tone }: { title: ReactNode; meta?: ReactNode; children: ReactNode; open?: boolean; tone?: string }) {
  return (
    <details className="fold" open={open} data-tone={tone}>
      <summary><span className="fold-title">{title}</span>{meta && <small>{meta}</small>}</summary>
      {children}
    </details>
  );
}

function Context({ call }: { call: CallDetail }) {
  const { request, sizes, blocks } = call;
  const [, ...rest] = request.messages;
  const total = sizes.system + sizes.tools + sizes.messages.reduce((n, m) => n + m.tokens, 0);
  return (
    <div className="context">
      <p className="context-sum">By our count this request holds about <b>{tokens(total)}</b> tokens: the system prompt {tokens(sizes.system)}, {request.tools.length} tool definitions {tokens(sizes.tools)}, and {request.messages.length} message{request.messages.length === 1 ? "" : "s"} {tokens(total - sizes.system - sizes.tools)}. The provider counted {tokens(call.promptTokens)}.</p>

      <Fold title="System prompt" meta={`${tokens(sizes.system)} tokens`}><pre>{request.system}</pre></Fold>
      <Fold title="Tools" meta={`${request.tools.length} definitions · ${tokens(sizes.tools)} tokens`}>
        <ul className="tool-list">{request.tools.map((t) => <li key={t.name}><code>{t.name}</code> <span>{t.description.split("\n")[0]}</span></li>)}</ul>
      </Fold>

      <h3>The context message <small>{tokens(sizes.messages[0]?.tokens ?? 0)} tokens, in the order it was sent</small></h3>
      {blocks.length === 0 && <p className="inspect-empty">No context message.</p>}
      {blocks.map((b, i) => (
        <Fold key={i} title={<>{b.name ? <code className="block-name">{b.name}</code> : <span className="muted">text</span>}</>} meta={<>{tokens(b.tokens)} tokens{b.cacheAfter ? <b className="cache-mark" title="A prompt-cache breakpoint follows this block">cache point</b> : null}</>} tone={b.name ?? "plain"}>
          <pre>{b.text}</pre>
        </Fold>
      ))}

      {rest.length > 0 && <h3>Then {rest.length} more message{rest.length === 1 ? "" : "s"} <small>the conversation so far this turn</small></h3>}
      {rest.map((m, i) => (
        <Fold key={i} title={<><b className="role" data-role={m.role}>{m.role === "tool" ? `tool · ${m.toolName ?? ""}` : m.role}</b> <span className="preview">{messageText(m).replace(/\s+/g, " ").slice(0, 90)}</span></>} meta={`${tokens(sizes.messages[i + 1]?.tokens ?? 0)} tokens`} tone={m.isError ? "error" : undefined}>
          <pre>{messageText(m)}</pre>
        </Fold>
      ))}
    </div>
  );
}

function Response({ call }: { call: CallDetail }) {
  const r = call.response;
  if (!r) return <p className="inspect-empty">The provider sent no reply{call.error ? `: ${call.error.message}` : "."}</p>;
  return (
    <div className="context">
      {r.reasoning && <Fold title="Thinking" meta={`${tokens(call.reasoningTokens ?? 0)} tokens`}><pre>{r.reasoning}</pre></Fold>}
      <Fold title="Text" meta={call.stopReason ?? undefined} open={!r.toolCalls.length}><pre>{r.text || "(no text)"}</pre></Fold>
      {r.toolCalls.map((t) => <Fold key={t.id} title={<>Tool call · <code>{t.name}</code></>} open><pre>{JSON.stringify(t.input, null, 2)}</pre></Fold>)}
    </div>
  );
}

function Provider({ call }: { call: CallDetail }) {
  const { request: q } = call;
  const rows: [string, string][] = [
    ["Client", call.model],
    ["Served by", call.servedBy ?? "–"],
    ["Stop reason", call.stopReason ?? "–"],
    ["Streamed", call.streamed ? "yes" : "no"],
    ["Started", new Date(call.startedAt).toLocaleString()],
    ["Thinking level sent", q.effort ?? "the model's default"],
    ["Output limit sent", q.maxOutputTokens ? tokens(q.maxOutputTokens) : "–"],
    ["Temperature", q.temperature === null ? "–" : String(q.temperature)],
    ["Tool choice", q.toolChoice],
    ["Messages sent", String(call.messageCount)],
    ["Request size", bytes(call.requestBytes)],
  ];
  return (
    <div className="context">
      <dl className="kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <Fold title="What the provider returned besides the answer" meta="response id, usage, finish reason" open>
        <pre>{call.response?.meta ? JSON.stringify(call.response.meta, null, 2) : "Nothing: the call failed or the provider reported no details."}</pre>
      </Fold>
    </div>
  );
}
