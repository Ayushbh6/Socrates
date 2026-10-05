import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { EFFORT_LABELS, PROVIDER_LABELS, filterModels } from "../lib/models";
import { type AppState, store } from "../lib/store";
import type { Effort, ListedModel, Provider } from "../lib/types";
import { Popover } from "./Popover";

/** How many of one provider's models the menu lists before asking for a narrower search. */
const SHOWN_PER_PROVIDER = 40;

type Listing = { models: ListedModel[] } | { error: string } | null;

/**
 * The chat model, chosen beside Send (architecture/web.md, "Model and
 * thinking"): every provider with a key lists its models, searchable; a typed
 * id the lists do not have can be used as well. Changing the model restarts
 * Socrates, so it waits until nothing is working.
 */
export function ModelMenu({ app, onSettings }: { app: AppState; onSettings: () => void }) {
  const chat = app.status?.models.chat;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const live = app.model.live;
  const working = !!live && (live.busy || live.lanes.some((l) => l.running));

  useEffect(() => {
    if (!open) return;
    let current = true;
    setError(null);
    Promise.all([api.providers(), api.keys()]).then(([all, keys]) => {
      if (!current) return;
      // Only a provider with a key can answer, so only those are offered.
      const usable = all.filter((p) => p.keys.some((k) => keys[k]));
      // The provider in use first.
      usable.sort((a, b) => Number(b.name === chat?.provider) - Number(a.name === chat?.provider));
      setProviders(usable);
      for (const p of usable) {
        api.models(p.name).then(
          (models) => current && setListings((l) => ({ ...l, [p.name]: { models } })),
          (e) => current && setListings((l) => ({ ...l, [p.name]: { error: e instanceof Error ? e.message : String(e) } })),
        );
      }
    }, (e) => current && setError(e instanceof Error ? e.message : String(e)));
    return () => { current = false; };
  }, [open, chat?.provider]);

  if (!chat) return null;
  const choose = async (provider: string, model: string) => {
    if (provider === chat.provider && model === chat.model) return setOpen(false);
    setSaving(true);
    setError(null);
    try {
      await store.chooseModel(provider, model);
      setOpen(false);
      setQuery("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  // A model id has no spaces; words with spaces only search.
  const typed = /^\S+$/.test(query.trim()) ? query.trim() : "";
  const known = typed && Object.values(listings).some((l) => l && "models" in l && l.models.some((m) => m.id === typed));

  return (
    <div className="chip-anchor">
      <button type="button" className="composer-model" onClick={() => setOpen(!open)} aria-expanded={open} title="Choose the chat model">
        {chat.model} <ChevronDown aria-hidden />
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="model-menu" align="right" above>
          <input className="model-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search models, or type a model id" aria-label="Search models" spellCheck={false} autoFocus />
          {working && <p className="menu-note">Socrates is working: change the model when it is idle.</p>}
          {error && <p className="setup-error" role="alert">{error}</p>}
          <div className="model-list">
            {providers.map((p) => {
              const listing = listings[p.name];
              const { shown, more } = listing && "models" in listing ? filterModels(listing.models, query, SHOWN_PER_PROVIDER) : { shown: [], more: 0 };
              // While searching, a provider with nothing to offer is left out.
              if (query.trim() && listing && "models" in listing && !shown.length && !(typed && !known)) return null;
              return (
                <section key={p.name} aria-label={PROVIDER_LABELS[p.name] ?? p.name}>
                  <p className="menu-title">{PROVIDER_LABELS[p.name] ?? p.name}</p>
                  {!listing && <p className="menu-note"><LoaderCircle aria-hidden className="spin" /> Loading models…</p>}
                  {listing && "error" in listing && <p className="menu-note">{listing.error}</p>}
                  {shown.map((m) => {
                    const selected = p.name === chat.provider && m.id === chat.model;
                    return (
                      <button key={m.id} type="button" className="menu-item model-item" role="menuitem" disabled={working || saving} onClick={() => choose(p.name, m.id)}>
                        <span className="menu-text"><strong>{m.name ?? m.id}</strong>{m.name && <small>{m.id}</small>}</span>
                        {selected && <Check aria-hidden className="menu-check" />}
                      </button>
                    );
                  })}
                  {more > 0 && <p className="menu-note">{more} more: search to narrow.</p>}
                  {typed && !known && (
                    <button type="button" className="menu-item model-item" role="menuitem" disabled={working || saving} onClick={() => choose(p.name, typed)}>
                      <span className="menu-text"><strong>Use “{typed}”</strong><small>with {PROVIDER_LABELS[p.name] ?? p.name}</small></span>
                    </button>
                  )}
                </section>
              );
            })}
          </div>
          <button type="button" className="quiet-button model-settings" onClick={() => { setOpen(false); onSettings(); }}>Routing model and keys in Settings</button>
        </Popover>
      )}
    </div>
  );
}

/**
 * How hard the chat model thinks, beside the model: only the levels this
 * model accepts. A change applies to the next model request, even while
 * Socrates works.
 */
export function EffortMenu({ app }: { app: AppState }) {
  const effort = app.status?.models.chat?.effort;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!effort?.levels.length) return null;
  const current = effort.current;
  const choose = async (level: Effort) => {
    setError(null);
    try {
      await store.setEffort(level);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="chip-anchor">
      <button type="button" className="composer-model" onClick={() => setOpen(!open)} aria-expanded={open} title="How hard the model thinks">
        {current ? EFFORT_LABELS[current] : "Thinking"} <ChevronDown aria-hidden />
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="effort-menu" align="right" above>
          <p className="menu-title">Thinking</p>
          {[...effort.levels].reverse().map((level) => (
            <button key={level} type="button" className="menu-item" role="menuitem" onClick={() => choose(level)}>
              <span className="menu-text"><strong>{EFFORT_LABELS[level]}</strong>{level === effort.default && <small>Default</small>}</span>
              {level === current && <Check aria-hidden className="menu-check" />}
            </button>
          ))}
          {error && <p className="setup-error" role="alert">{error}</p>}
        </Popover>
      )}
    </div>
  );
}
