import { X } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useDialog } from "../lib/dialog";
import { type AppState, store } from "../lib/store";
import { EFFORT_LABELS, PROVIDER_LABELS } from "../lib/models";
import type { Effort, Embeddings, ListedModel, MemoryKind, MemoryView, ModelChoice, ModelInUse, Provider, WorkMemoryGoalView, WorkMemoryPart } from "../lib/types";
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
        <MemorySection app={app} />
        <MemorySearch app={app} />
        <TaskArchiveSettings app={app} />
        <TimeZone app={app} />
        <Section title="Where Socrates works">
          <AccessControls app={app} approvals />
        </Section>
      </div>
    </div>,
    document.body,
  );
}

function TaskArchiveSettings({ app }: { app: AppState }) {
  const saved = app.settings?.inactiveTaskMonths === undefined ? 12 : app.settings.inactiveTaskMonths;
  const [months, setMonths] = useState(saved ?? 12);
  const [enabled, setEnabled] = useState(saved !== null);
  const { busy, save, feedback } = useSave();
  return <Section title="Inactive tasks">
    <p className="settings-hint">Archive tasks after this long without conversation or a status change. History is kept; archiving does not mark work completed. Restore a task from Archived to use it again.</p>
    <label className="archive-enabled"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Automatically archive inactive tasks</label>
    <div className="archive-period">
      <input aria-label="Inactivity period" type="range" min="1" max="24" step="1" value={months} disabled={!enabled || busy} onChange={e => setMonths(Number(e.target.value))} />
      <label><input aria-label="Inactive months" type="number" min="1" max="24" value={months} disabled={!enabled || busy} onChange={e => setMonths(Number(e.target.value))} /> months</label>
    </div>
    <p className="settings-hint">Default: 12 months. Checks run on startup and hourly; saving a shorter period can archive older tasks immediately.</p>
    <div className="settings-actions">{feedback}<button type="button" className="solid-button" disabled={busy || !Number.isInteger(months) || months < 1 || months > 24} onClick={() => save(() => store.saveSettings({ inactiveTaskMonths: enabled ? months : null }))}>Save inactivity period</button></div>
  </Section>;
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
  const [router, setRouter] = useState<ModelChoice | null>(app.settings!.router ?? (app.status!.models.router ? { provider: app.status!.models.router.provider, model: app.status!.models.router.model, effort: app.status!.models.router.effort?.current ?? null } : null));
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
    choice.effort === undefined ? { ...choice, model } : { ...choice, model, effort: model === choice.model ? choice.effort : null };
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
      {row("Routing", router, "router", setRouter, "Automatic: GPT-6 Luna on OpenRouter, else the chat provider's router model", routerModels)}
      <RouterThinking choice={router} inUse={inUse.router} onChange={setRouter} />
      {row("Compaction", compactor, "main", setCompactor, "Automatic: the chat model", compactorModels)}
      <p className="settings-hint">Compaction is the call that summarizes an old part of a long task so the work can go on. It copies the user's open requests word for word, so a strong model suits it; by default it is the chat model.</p>
      <div className="settings-actions">
        {feedback}
        <button type="button" className="solid-button" disabled={busy || !!(chat && !chat.model.trim()) || !!(router && !router.model.trim()) || !!(compactor && !compactor.model.trim())} onClick={() => save(() => store.saveSettings({ chat, router, compactor }))}>Save models</button>
      </div>
    </Section>
  );
}

/** Query the selected model, so levels from a previous selection cannot leak into the next. */
function RouterThinking({ choice, inUse, onChange }: { choice: ModelChoice | null; inUse: ModelInUse | null; onChange: (c: ModelChoice) => void }) {
  const provider = choice?.provider ?? inUse?.provider;
  const model = choice?.model ?? inUse?.model;
  const key = `${provider}:${model}`;
  const [loaded, setLoaded] = useState<{ key: string; levels: Effort[]; error?: string } | null>(null);
  useEffect(() => {
    if (!provider || !model) return;
    let alive = true;
    const timer = setTimeout(() => {
      api.modelEfforts(provider, model).then(result => alive && setLoaded({ key, levels: result.levels }),
        () => alive && setLoaded({ key, levels: [], error: "Could not load thinking levels. Try selecting the model again." }));
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [provider, model, key]);
  const same = provider === inUse?.provider && model === inUse?.model;
  const levels = loaded?.key === key ? loaded.levels : same ? inUse?.effort?.levels ?? [] : [];
  return <div className="field-row routing-thinking">
    <label htmlFor="router-thinking" className="field-label">Routing thinking</label>
    <select id="router-thinking" disabled={!provider || !model || !levels.length} value={choice ? choice.effort ?? "" : inUse?.effort?.current ?? ""}
      onChange={e => provider && model && onChange({ provider, model, effort: e.target.value as Effort || null })}>
      <option value="">Model default</option>
      {levels.map(level => <option key={level} value={level}>{EFFORT_LABELS[level]}</option>)}
    </select>
    <span className="settings-hint">{loaded?.key === key && loaded.error ? loaded.error : !levels.length ? loaded?.key === key ? "No thinking levels reported for this model." : "Loading thinking levels…" : "Applies to the router independently of the chat model."}</span>
  </div>;
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

const MEMORY_GROUPS: { kind: MemoryKind; title: string }[] = [
  { kind: "about", title: "About you" },
  { kind: "preference", title: "How you like to work" },
  { kind: "knowledge", title: "Facts and decisions" },
];

/**
 * What Socrates remembers about the user (architecture/web.md, "Memory"):
 * the two switches, every entry by kind with where it was said, and edit,
 * forget and add. Changes apply from the next message, without a restart.
 */
function MemorySection({ app }: { app: AppState }) {
  const [list, setList] = useState<MemoryView[] | null>(null);
  const [editing, setEditing] = useState<{ number: number; text: string } | null>(null);
  const [draft, setDraft] = useState<{ text: string; kind: MemoryKind }>({ text: "", kind: "preference" });
  const { busy, save, feedback } = useSave();
  const reload = async () => setList(await api.memories());
  useEffect(() => {
    api.memories().then(setList, () => setList([]));
  }, []);
  const switches = app.settings!.memory;
  const toggle = (key: "save" | "use" | "decider", on: boolean) => save(() => store.saveSettings({ memory: { [key]: on } }));
  const where = (m: MemoryView) => [
    m.alwaysOn ? "Always on" : m.kind === "knowledge" ? "Recalled when relevant" : "Recalled when relevant: no room left to keep it always on",
    m.uses ? `shown to Socrates ${m.uses === 1 ? "once" : m.uses === 2 ? "twice" : `${m.uses} times`}` : null,
    m.goal ? `only in ${m.goal.title}` : null,
    m.source ? `from ${m.source.goal.title} / ${m.source.task.title}, ${new Date(m.source.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : "added by you",
  ].filter(Boolean).join(" · ");
  return (
    <Section title="Memory">
      <p className="settings-hint">What Socrates remembers about you, in every goal: who you are and how you like to work, saved when you say it. Undo one under its answer or change it here. Forgetting removes it from what Socrates uses; the conversation it came from stays in your history. After an answer, Socrates also keeps short notes on how your work is done, for one task or its whole goal; they are listed below, and the first switch below covers them.</p>
      <label className="memory-switch"><input type="checkbox" checked={switches.save} disabled={busy} onChange={(e) => void toggle("save", e.target.checked)} /> Save new memories from my conversations</label>
      <label className="memory-switch"><input type="checkbox" checked={switches.use} disabled={busy} onChange={(e) => void toggle("use", e.target.checked)} /> Use memories when answering</label>
      <label className="memory-switch"><input type="checkbox" checked={switches.decider} disabled={busy} onChange={(e) => void toggle("decider", e.target.checked)} /> Ask a small model when to recall and save</label>
      <p className="settings-hint">{app.status!.decider === "no_key"
        ? "Needs an OpenRouter key; without one, Socrates recalls from keywords and meaning alone and saves when you ask."
        : "Uses Perplexity Decider V1.2 through OpenRouter, with TypeSafe Jev 1.14 as an automatic backup. Sends your message, recent conversation and attached images; after each answer, also the answer and any tool summaries. These checks help Socrates recall and save useful information. Each attempt and its cost appear in Inspect."}</p>
      {list && !list.length && <p className="settings-hint">Nothing yet. Tell Socrates something about yourself, or add it below.</p>}
      {MEMORY_GROUPS.map(({ kind, title }) => {
        const entries = (list ?? []).filter((m) => m.kind === kind);
        if (!entries.length) return null;
        return (
          <div key={kind} className="memory-group">
            <p className="memory-group-title">{title}</p>
            <ul className="memory-list">
              {entries.map((m) => (
                <li key={m.number}>
                  {editing?.number === m.number ? (
                    <form className="field-row" onSubmit={(e: FormEvent) => { e.preventDefault(); void save(async () => { await api.editMemory(m.number, { text: editing.text }); setEditing(null); await reload(); }); }}>
                      <input value={editing.text} maxLength={280} onChange={(e) => setEditing({ ...editing, text: e.target.value })} aria-label="Memory" autoFocus />
                      <button type="submit" className="quiet-button" disabled={busy || !editing.text.trim()}>Save</button>
                      <button type="button" className="quiet-button" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : (
                    <>
                      <span className="memory-text">{m.text}</span>
                      <span className="memory-meta">{where(m)}</span>
                      <span className="memory-actions">
                        <button type="button" className="quiet-button" onClick={() => setEditing({ number: m.number, text: m.text })}>Edit</button>
                        <button type="button" className="quiet-button" disabled={busy} onClick={() => void save(async () => { await api.forgetMemory(m.number); await reload(); })}>Forget</button>
                      </span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <form className="field-row memory-add" onSubmit={(e: FormEvent) => { e.preventDefault(); void save(async () => { await api.addMemory({ text: draft.text, kind: draft.kind, goal: null }); setDraft({ ...draft, text: "" }); await reload(); }); }}>
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as MemoryKind })} aria-label="Kind of memory">
          {MEMORY_GROUPS.map((g) => <option key={g.kind} value={g.kind}>{g.title}</option>)}
        </select>
        <input value={draft.text} maxLength={280} placeholder="Add a memory, such as: Prefers short answers." onChange={(e) => setDraft({ ...draft, text: e.target.value })} aria-label="New memory" />
        <button type="submit" className="quiet-button" disabled={busy || !draft.text.trim()}>Add</button>
      </form>
      <WorkMemoryList />
      <div className="settings-actions">{feedback}</div>
    </Section>
  );
}

const day = (at: string) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const notes = (n: number) => (n === 1 ? "1 note" : `${n} notes`);

/**
 * Work memory, by goal and then by task (architecture/web.md, "Memory"):
 * what Socrates wrote in the background, each index with its topics. Read
 * only; the files in the data folder are a copy it rewrites.
 */
function WorkMemoryList() {
  const [goals, setGoals] = useState<WorkMemoryGoalView[] | null>(null);
  useEffect(() => {
    api.workMemory().then(setGoals, () => setGoals([]));
  }, []);
  if (!goals) return null;
  return (
    <div className="memory-group work-memory">
      <p className="memory-group-title">Notes on your work, by goal and task</p>
      <p className="settings-hint">{goals.length
        ? "Lessons and decisions Socrates wrote after its answers. Each is also a plain file under memory/ in Socrates' data folder: a copy Socrates rewrites, so editing a file does not change what it uses."
        : "None yet. After an answer that settles a decision or teaches a lesson, Socrates writes it here in the background."}</p>
      {goals.map((g) => {
        const count = (g.own?.topics.length ?? 0) + g.tasks.reduce((n, t) => n + t.topics.length, 0);
        return (
          <details key={g.goal.number} className="work-memory-goal">
            <summary><span>{g.goal.general ? "General" : g.goal.title}</span><span className="memory-meta">{notes(count)} · {day(g.updatedAt)}</span></summary>
            {g.own && <WorkMemoryBlock title="Whole goal" part={g.own} />}
            {g.tasks.map((t) => <WorkMemoryBlock key={t.task.number} title={t.task.title} part={t} />)}
          </details>
        );
      })}
    </div>
  );
}

function WorkMemoryBlock({ title, part }: { title: string; part: WorkMemoryPart }) {
  return (
    <div className="work-memory-part">
      <p className="work-memory-title">{title} <span className="memory-meta">memory/{part.folder}</span></p>
      {part.index && <pre className="work-memory-text">{part.index}</pre>}
      {part.topics.map((t) => (
        <details key={t.name} className="work-memory-topic">
          <summary><span>{t.name}</span><span className="memory-meta">{day(t.updatedAt)}</span></summary>
          <pre className="work-memory-text">{t.text}</pre>
        </details>
      ))}
    </div>
  );
}

function MemorySearch({ app }: { app: AppState }) {
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
