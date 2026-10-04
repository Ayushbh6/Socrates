import { X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { type AppState, store } from "../lib/store";
import type { Embeddings, ModelChoice, Provider } from "../lib/types";
import { AccessControls } from "./AccessMenu";

const LABELS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini", openrouter: "OpenRouter", deepseek: "DeepSeek" };
const EMBEDDERS: Embeddings["provider"][] = ["ollama", "openrouter", "openai", "custom"];

/** Everything the user chooses (architecture/web.md, "Settings"). Model, key and memory changes restart Socrates, so they wait until it is idle. */
export function SettingsDialog({ app, onClose }: { app: AppState; onClose: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  useEffect(() => {
    api.providers().then(setProviders, () => {});
  }, []);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  if (!app.settings || !app.status) return null;
  return createPortal(
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="modal-head">
          <strong>Settings</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X aria-hidden /></button>
        </div>
        <Models app={app} providers={providers} />
        <Keys providers={providers} />
        <Memory app={app} />
        <TimeZone app={app} />
        <Section title="Where Socrates works">
          <AccessControls app={app} approvals />
        </Section>
      </div>
    </div>,
    document.body,
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** Save a change and say how it went. */
function useSave() {
  const [state, setState] = useState<{ busy: boolean; error: string | null; saved: boolean }>({ busy: false, error: null, saved: false });
  const save = async (work: () => Promise<unknown>) => {
    setState({ busy: true, error: null, saved: false });
    try {
      await work();
      setState({ busy: false, error: null, saved: true });
    } catch (e) {
      setState({ busy: false, error: e instanceof Error ? e.message : String(e), saved: false });
    }
  };
  const feedback = state.error ? <p className="setup-error" role="alert">{state.error}</p> : state.saved ? <p className="settings-saved">Saved.</p> : null;
  return { busy: state.busy, save, feedback };
}

function Models({ app, providers }: { app: AppState; providers: Provider[] }) {
  const [chat, setChat] = useState<ModelChoice | null>(app.settings!.chat);
  const [router, setRouter] = useState<ModelChoice | null>(app.settings!.router);
  const { busy, save, feedback } = useSave();
  const inUse = app.status!.models;
  const pick = (value: string, kind: "main" | "router", set: (c: ModelChoice | null) => void) => {
    const provider = providers.find((p) => p.name === value);
    set(provider ? { provider: provider.name, model: provider[kind] } : null);
  };
  const row = (label: string, choice: ModelChoice | null, kind: "main" | "router", set: (c: ModelChoice | null) => void, auto: string) => (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <select value={choice?.provider ?? ""} onChange={(e) => pick(e.target.value, kind, set)} aria-label={`${label} provider`}>
        <option value="">{auto}</option>
        {providers.map((p) => <option key={p.name} value={p.name}>{LABELS[p.name] ?? p.name}</option>)}
      </select>
      <input value={choice?.model ?? ""} disabled={!choice} placeholder="the provider's default" onChange={(e) => choice && set({ ...choice, model: e.target.value })} aria-label={`${label} model`} spellCheck={false} />
    </div>
  );
  return (
    <Section title="Models">
      <p className="settings-hint">
        In use: {inUse.chat ? `${inUse.chat.provider} · ${inUse.chat.model}` : "none yet"}{inUse.chat?.source === "detected" ? " (picked from your keys)" : ""}
        {inUse.router ? `; routing with ${inUse.router.model}` : ""}.
      </p>
      {row("Chat", chat, "main", setChat, "Automatic: the first provider with a key")}
      {row("Routing", router, "router", setRouter, "Automatic: the chat provider's router model")}
      <div className="settings-actions">
        {feedback}
        <button type="button" className="solid-button" disabled={busy || !!(chat && !chat.model.trim()) || !!(router && !router.model.trim())} onClick={() => save(() => store.saveSettings({ chat, router }))}>Save models</button>
      </div>
    </Section>
  );
}

function Keys({ providers }: { providers: Provider[] }) {
  const [keys, setKeys] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const { busy, save, feedback } = useSave();
  useEffect(() => {
    api.keys().then(setKeys, () => {});
  }, []);
  const owner = (name: string) => providers.find((p) => p.keys.includes(name));
  const change = (name: string, value: string | null) =>
    save(async () => {
      await store.saveKey(name, value);
      setValues({ ...values, [name]: "" });
      setKeys(await api.keys());
    });
  return (
    <Section title="API keys">
      <p className="settings-hint">Keys stay on this Mac, in Socrates' own folder, and are never shown again.</p>
      {Object.entries(keys).map(([name, set]) => (
        <form
          key={name}
          className="field-row"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (values[name]?.trim()) void change(name, values[name]!.trim());
          }}
        >
          <span className="field-label" title={name}>
            <span className="key-dot" data-set={set} /> {owner(name) ? LABELS[owner(name)!.name] ?? name : "Memory search"}
            <small>{name}</small>
          </span>
          <input type="password" autoComplete="off" placeholder={set ? "Set: type to replace" : "Not set"} value={values[name] ?? ""} onChange={(e) => setValues({ ...values, [name]: e.target.value })} aria-label={name} />
          <button type="submit" className="quiet-button" disabled={busy || !values[name]?.trim()}>Save</button>
          {set && <button type="button" className="quiet-button" disabled={busy} onClick={() => void change(name, null)}>Remove</button>}
        </form>
      ))}
      <div className="settings-actions">{feedback}</div>
    </Section>
  );
}

function Memory({ app }: { app: AppState }) {
  const [embeddings, setEmbeddings] = useState<Embeddings>(app.settings!.embeddings);
  const { busy, save, feedback } = useSave();
  const status = app.status!.embeddings;
  return (
    <Section title="Memory search">
      <p className="settings-hint">
        {status.state === "ready" ? `Ready${status.index ? `: ${status.index.documents} pieces of memory indexed` : ""}.` : status.detail ?? "Unavailable: memory search uses keywords only."}
      </p>
      <div className="field-row">
        <span className="field-label">Embeddings</span>
        <select value={embeddings.provider} onChange={(e) => setEmbeddings({ provider: e.target.value as Embeddings["provider"], model: null, url: null })} aria-label="Embedding provider">
          {EMBEDDERS.map((p) => <option key={p} value={p}>{p === "ollama" ? "Ollama on this Mac" : p === "custom" ? "Custom endpoint" : LABELS[p] ?? p}</option>)}
        </select>
        <input value={embeddings.model ?? ""} placeholder="default model" onChange={(e) => setEmbeddings({ ...embeddings, model: e.target.value || null })} aria-label="Embedding model" spellCheck={false} />
      </div>
      <div className="field-row">
        <span className="field-label">Address</span>
        <input value={embeddings.url ?? ""} placeholder="the provider's default address" onChange={(e) => setEmbeddings({ ...embeddings, url: e.target.value || null })} aria-label="Embedding address" spellCheck={false} />
      </div>
      <div className="settings-actions">
        {feedback}
        <button type="button" className="solid-button" disabled={busy} onClick={() => save(() => store.saveSettings({ embeddings }))}>Save memory search</button>
      </div>
    </Section>
  );
}

function TimeZone({ app }: { app: AppState }) {
  const [zone, setZone] = useState(app.settings!.timeZone ?? "");
  const { busy, save, feedback } = useSave();
  return (
    <Section title="Time zone">
      <div className="field-row">
        <span className="field-label">Zone</span>
        <input value={zone} placeholder={`Follows this Mac: ${app.status!.timeZone}`} onChange={(e) => setZone(e.target.value)} aria-label="Time zone" spellCheck={false} />
        <button type="button" className="solid-button" disabled={busy} onClick={() => save(() => store.saveSettings({ timeZone: zone.trim() || null }))}>Save</button>
      </div>
      <div className="settings-actions">{feedback}</div>
    </Section>
  );
}
