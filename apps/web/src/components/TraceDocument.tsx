import { Children, isValidElement, useEffect, useId, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import { type CallDetail, type ContextBlock, tokens } from "../lib/observe";
import { Fold } from "./inspect-kit";

/** Keep all recorded sections together; unwrap only a known legacy outer XML block. */
export function contextDocument(blocks: ContextBlock[]): string {
  return blocks.map(b => {
    if (!b.name || !/^[A-Z_]+$/.test(b.name)) return b.text;
    const match = new RegExp(`^<${b.name}(?:\\s[^>]*)?>\\n([\\s\\S]*)\\n</${b.name}>$`).exec(b.text);
    return match ? `# ${b.name}\n\n${match[1]}` : b.text;
  }).join("\n\n");
}

const title = (children: ReactNode) => typeof children === "string" && /^[A-Z_ ]+$/.test(children)
  ? children.toLowerCase().replace(/_/g, " ").replace(/^./, c => c.toUpperCase()) : children;

/** Safe Markdown; evidence's outer `text` fence becomes prose, inner code remains code. */
export function TraceDocument({ text, evidence = false }: { text: string; evidence?: boolean }) {
  return <div className="trace-document prose"><Markdown remarkPlugins={[remarkGfm]} components={{
    a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    // Recorded inputs must not load arbitrary remote images when somebody opens Inspect.
    img: ({ alt }) => <span className="muted">[Image: {alt || "attachment"}]</span>,
    h1: ({ children }) => <h2>{title(children)}</h2>,
    h2: ({ children }) => <h3>{title(children)}</h3>,
    h3: ({ children }) => <h4>{title(children)}</h4>,
    pre: ({ children }) => {
      const child = Children.toArray(children)[0];
      if (evidence && isValidElement<{ className?: string; children?: ReactNode }>(child) && child.props.className === "language-text") {
        return <div className="trace-evidence"><TraceDocument text={String(child.props.children ?? "")} /></div>;
      }
      return <pre>{children}</pre>;
    },
  }}>{text}</Markdown></div>;
}

/** The exact recorded system prompt is fetched only when requested, never reconstructed. */
export function TraceInputs({ id, context, rebuilt, open }: { id: string; context: ContextBlock[] | null; rebuilt: boolean; open: boolean }) {
  const [tab, setTab] = useState<"context" | "system">("context");
  const [record, setRecord] = useState<{ id: string; data?: CallDetail; error?: string } | null>(null);
  const prefix = useId();
  useEffect(() => {
    if (tab !== "system") return;
    let alive = true;
    api.observeCall(id).then(data => alive && setRecord({ id, data }),
      () => alive && setRecord({ id, error: "The recorded request is unavailable. It may have expired from the call log." }));
    return () => { alive = false; };
  }, [id, tab]);
  const current = record?.id === id ? record : null;
  const size = context?.reduce((sum, b) => sum + b.tokens, 0);
  return <Fold title={rebuilt ? "Model input · context updated" : "Model input"} meta={size ? `~${tokens(size)} context text tokens` : undefined} open={open}>
    <div className="trace-input">
      <div className="trace-tabs" role="tablist" aria-label="Recorded model input">
        {(["context", "system"] as const).map((name, i, names) => <button key={name} type="button" role="tab" id={`${prefix}-${name}`} aria-controls={`${prefix}-panel`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1}
          onClick={() => setTab(name)} onKeyDown={e => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
            e.preventDefault();
            const next = e.key === "Home" ? names[0]! : e.key === "End" ? names[1]! : names[1 - i]!;
            setTab(next); document.getElementById(`${prefix}-${next}`)?.focus();
          }}>{name === "context" ? "Context" : "System prompt"}</button>)}
      </div>
      <div id={`${prefix}-panel`} role="tabpanel" aria-labelledby={`${prefix}-${tab}`} tabIndex={0} className="trace-reader" key={tab}>
        {tab === "context" ? context ? <TraceDocument text={contextDocument(context)} evidence /> : <p className="muted">Context continues from the preceding step. Changes are shown below; the full input is available in Raw request.</p>
          : current?.error ? <p role="alert">{current.error}</p>
          : current?.data ? <><p className="trace-caption">Recorded system prompt · thinking {current.data.request.effort ?? "model default"}</p><TraceDocument text={current.data.request.system || "No system prompt was recorded."} /></>
          : <p className="muted">Loading recorded system prompt…</p>}
      </div>
    </div>
  </Fold>;
}

/** Native routing_result is a terminal decision, so no tool response is expected. */
export function RoutingResult({ input }: { input: unknown }) {
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const labels: Record<string, string> = { continue_current: "Continue the current goal", continue_task: "Continue the current task", compound: "Route a multipart request", resume_existing: "Use an existing goal", create_new: "Create a goal", general: "General conversation", resume_task: "Continue a task", create_task: "Create a task", ask_user: "Ask for clarification" };
  const fields = [["Goal", value.new_goal_title ?? value.goal_label], ["Task", value.new_task_title ?? value.task_label], ["Task action", value.task_decision], ["Reason", value.reason]].filter(([, v]) => v != null && v !== "");
  return <div className="routing-result">
    <strong>{labels[String(value.decision)] ?? String(value.decision ?? "Routing decision").replace(/_/g, " ")}</strong>
    <dl>{fields.map(([key, value]) => <div key={String(key)}><dt>{String(key)}</dt><dd>{value === "current" && (key === "Goal" || key === "Task") ? `Current ${String(key).toLowerCase()}` : labels[String(value)] ?? String(value)}</dd></div>)}</dl>
    <Fold title="Recorded decision fields"><pre>{JSON.stringify(input, null, 2)}</pre></Fold>
  </div>;
}

/** Final-answer JSON is transport; show its answer as prose and retain the full fields below. */
export function ModelOutput({ text }: { text: string }) {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && "full_answer" in value && typeof value.full_answer === "string") {
      return <div className="model-output"><TraceDocument text={value.full_answer} /><Fold title="Recorded answer fields"><pre>{JSON.stringify(value, null, 2)}</pre></Fold></div>;
    }
  } catch { /* Plain text is already the readable answer. */ }
  return <div className="model-output"><TraceDocument text={text} /></div>;
}
