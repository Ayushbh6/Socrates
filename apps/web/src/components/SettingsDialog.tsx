import { X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useDialog } from "../lib/dialog";
import { type AppState, store } from "../lib/store";
import { PROVIDER_LABELS } from "../lib/models";
import type { Embeddings, ListedModel, ModelChoice, Provider } from "../lib/types";
import { AccessControls } from "./AccessMenu";

const EMBEDDERS: Embeddings["provider"][] = ["ollama", "openrouter", "openai", "custom"];

/** Everything the user chooses (architecture/web.md, "Settings"). Model, key and memory changes restart Socrates, so they wait until it is idle. */
export function SettingsDialog({ app, onClose }: { app: AppState; onClose: () => void }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const modal = useRef<HTMLDivElement>(null);
  useDialog(modal, onClose, !!app.settings && !!app.status);
  useEffect(() => {
    api.providers().then(setProviders, () => {});
  }, []);
  if (!app.settings || !app.status) return null;
  return createPortal(
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={modal} tabIndex={-1} className="modal settings" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="modal-head">
          <strong>Settings</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X aria-hidden /></button>
        </div>
        <Models app={app} providers={providers} />
        <ChatNames app={app} providers={providers} />
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

/** A provider's chat models, to suggest while typing; none while loading or when they cannot be listed. */
function useModelList(provider: string | undefined): ListedModel[] {
  const [models, setModels] = useState<ListedModel[]>([]);
  useEffect(() => {
    setModels([]);
    if (!provider) return;
    let current = true;
    api.models(provider).then((list) => current && setModels(list), () => {});
    return () => { current = false; };
  }, [provider]);
  return models;
}

function Models({ app, providers }: { app: AppState; providers: Provider[] }) {
  const [chat, setChat] = useState<ModelChoice | null>(app.settings!.chat);
  const [router, setRouter] = useState<ModelChoice | null>(app.settings!.router);
  const [compactor, setCompactor] = useState<ModelChoice | null>(app.settings!.compactor);
  const { busy, save, feedback } = useSave();
  const inUse = app.status!.models;
  const chatModels = useModelList(chat?.provider);
  const routerModels = useModelList(router?.provider);
  const compactorModels = useModelList(compactor?.provider);
  const pick = (value: string, kind: "main" | "router", set: (c: ModelChoice | null) => void) => {
    const provider = providers.find((p) => p.name === value);
    set(provider ? { provider: provider.name, model: provider[kind] } : null);
  };
  // A chat model keeps its thinking level only while it stays the same model.
  const typed = (choice: ModelChoice, model: string): ModelChoice =>
    choice.effort === undefined ? { ...choice, model } : { ...choice, model, effort: model === app.settings!.chat?.model ? app.settings!.chat?.effort ?? null : null };
  const row = (label: string, choice: ModelChoice | null, kind: "main" | "router", set: (c: ModelChoice | null) => void, auto: string, listed: ListedModel[]) => (
    <div className="field-row">
      <span className="field-label">{label}</span>
      <select value={choice?.provider ?? ""} onChange={(e) => pick(e.target.value, kind, set)} aria-label={`${label} provider`}>
        <option value="">{auto}</option>
        {providers.map((p) => <option key={p.name} value={p.name}>{PROVIDER_LABELS[p.name] ?? p.name}</option>)}
      </select>
      <input value={choice?.model ?? ""} disabled={!choice} placeholder="the provider's default" onChange={(e) => choice && set(typed(choice, e.target.value))} aria-label={`${label} model`} spellCheck={false} list={`models-${label}`} />
      <datalist id={`models-${label}`}>{listed.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
    </div>
  );
  return (
    <Section title="Models">
      <p className="settings-hint">
        In use: {inUse.chat ? `${inUse.chat.provider} · ${inUse.chat.model}` : "none yet"}{inUse.chat?.source === "detected" ? " (picked from your keys)" : ""}
        {inUse.router ? `; routing with ${inUse.router.model}` : ""}
        {inUse.compactor ? `; compaction with ${inUse.compactor.model}` : ""}.
      </p>
      {row("Chat", chat, "main", setChat, "Automatic: the first provider with a key", chatModels)}
      {row("Routing", router, "router", setRouter, "Automatic: the chat provider's router model", routerModels)}
      {row("Compaction", compactor, "main", setCompactor, "Automatic: the chat model", compactorModels)}
      <p className="settings-hint">Compaction is the call that summarizes an old part of a long task so the work can go on. It copies the user's open requests word for word, so a strong model suits it; by default it is the chat model.</p>
      <div className="settings-actions">
        {feedback}
        <button type="button" className="solid-button" disabled={busy || !!(chat && !chat.model.trim()) || !!(router && !router.model.trim()) || !!(compactor && !compactor.model.trim())} onClick={() => save(() => store.saveSettings({ chat, router, compactor }))}>Save models</button>
      </div>
    </Section>
  );
}

/** OpenRouter's default namer: an instruct model with no thinking mode (apps/server/src/titles.ts, DEFAULT_TITLER). */
const QWEN_NAMER = "qwen/qwen3-30b-a3b-instruct-2507";

/**
 * The model that names standard-mode chats after their first answer. It is
 * used outside the work itself, so a change applies at once, even while
 * Socrates works.
 */
function ChatNames({ app, providers }: { app: AppState; providers: Provider[] }) {
  const [titler, setTitler] = useState<ModelChoice | null>(app.settings!.titler ?? null);
  const { busy, save, feedback } = useSave();
  const listed = useModelList(titler?.provider);
  const inUse = app.status!.models.titler;
  return (
    <Section title="Chat names">
      <p className="settings-hint">
        After a new chat's first answer, this model gives it a short name. A small, fast model that doesn't think suits it best; automatic is Qwen3 30B Instruct on OpenRouter, or the routing model without an OpenRouter key.
        {inUse ? ` In use: ${inUse.provider} · ${inUse.model}.` : ""}
      </p>
      <div className="field-row">
        <span className="field-label">Names</span>
        <select value={titler?.provider ?? ""} onChange={(e) => { const p = providers.find((x) => x.name === e.target.value); setTitler(p ? { provider: p.name, model: p.name === "openrouter" ? QWEN_NAMER : p.router } : null); }} aria-label="Chat names provider">
          <option value="">Automatic</option>
          {providers.map((p) => <option key={p.name} value={p.name}>{PROVIDER_LABELS[p.name] ?? p.name}</option>)}
        </select>
        <input value={titler?.model ?? ""} disabled={!titler} placeholder="the provider's default" onChange={(e) => titler && setTitler({ ...titler, model: e.target.value })} aria-label="Chat names model" spellCheck={false} list="models-chat-names" />
        <datalist id="models-chat-names">{listed.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
      </div>
      <div className="settings-actions">
        {feedback}
        <button type="button" className="solid-button" disabled={busy || !!(titler && !titler.model.trim())} onClick={() => save(() => store.saveSettings({ titler }))}>Save</button>
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
            <span className="key-dot" data-set={set} /> {owner(name) ? PROVIDER_LABELS[owner(name)!.name] ?? name : "Memory search"}
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
          {EMBEDDERS.map((p) => <option key={p} value={p}>{p === "ollama" ? "Ollama on this Mac" : p === "custom" ? "Custom endpoint" : PROVIDER_LABELS[p] ?? p}</option>)}
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
