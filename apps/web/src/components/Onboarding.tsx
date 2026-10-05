import { ArrowRight, Check, FolderOpen, Plus, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api } from "../lib/api";
import { type AppState, store } from "../lib/store";
import { FolderPicker } from "./FolderPicker";

/** The keys onboarding offers, in the order people most often have them. */
export const KEY_PROVIDERS = [
  { name: "Anthropic", key: "ANTHROPIC_API_KEY" },
  { name: "OpenAI", key: "OPENAI_API_KEY" },
  { name: "Gemini", key: "GEMINI_API_KEY" },
  { name: "OpenRouter", key: "OPENROUTER_API_KEY" },
  { name: "DeepSeek", key: "DEEPSEEK_API_KEY" },
];

const nameOf = (folder: string) => folder.split("/").filter(Boolean).at(-1) ?? folder;

/**
 * `#/onboarding` (architecture/web.md, "Onboarding"): who the user is, one API
 * key, and, if they like, the folders Socrates may work in. Only the key is
 * needed; the folders are a head start, since the header changes them at any time.
 */
export function Onboarding({ app, onDone }: { app: AppState; onDone: () => void }) {
  const [name, setName] = useState(app.status?.profile.name ?? "");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = app.status?.ready ?? false;

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await store.finishOnboarding(name);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  return (
    <main className="onboarding">
      <header className="onboarding-head">
        <h1>Socrates</h1>
        <p>Three quick things. You can change every one of them later.</p>
      </header>

      <Step number={1} title="What should Socrates call you?" hint="Optional.">
        <input className="onboarding-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={80} autoComplete="given-name" autoFocus aria-label="Your name" />
      </Step>

      <Step number={2} title="Add an API key" hint="One is enough. Add more whenever you like.">
        <Keys />
      </Step>

      <Step number={3} title="Where may Socrates work?" hint="Optional. You can add, remove or change folders from the header at any time, even in the middle of a chat; a folder you add counts from your next message.">
        <Folders app={app} />
      </Step>

      <footer className="onboarding-foot">
        {error && <p className="setup-error" role="alert">{error}</p>}
        <button type="button" className="welcome-button" disabled={!ready || starting} onClick={() => void start()}>
          {starting ? "Starting…" : "Start chatting"} <ArrowRight aria-hidden />
        </button>
        {!ready && <p className="onboarding-note">Add one key above to continue.</p>}
      </footer>
    </main>
  );
}

function Step({ number, title, hint, children }: { number: number; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="onboarding-step" aria-label={title}>
      <span className="onboarding-number" aria-hidden>{number}</span>
      <div className="onboarding-body">
        <h2>{title}</h2>
        <p className="onboarding-hint">{hint}</p>
        {children}
      </div>
    </section>
  );
}

/** One row per provider: paste a key and save it; a saved one shows as set and is never shown again. */
function Keys() {
  const [set, setSet] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.keys().then(setSet, () => {});
  }, []);

  const save = async (event: FormEvent, key: string) => {
    event.preventDefault();
    const value = values[key]?.trim();
    if (!value) return;
    setSaving(key);
    setError(null);
    try {
      await store.saveKey(key, value);
      setValues({ ...values, [key]: "" });
      setSet(await api.keys());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <ul className="onboarding-keys">
        {KEY_PROVIDERS.map(({ name, key }) => (
          <li key={key}>
            <form onSubmit={(e) => void save(e, key)}>
              <span className="onboarding-provider">
                {set[key] ? <Check aria-label="Saved" className="onboarding-saved" /> : <span className="key-dot" data-set={false} aria-hidden />}
                {name}
              </span>
              <input type="password" autoComplete="off" value={values[key] ?? ""} onChange={(e) => setValues({ ...values, [key]: e.target.value })} placeholder={set[key] ? "Saved. Paste a new one to replace it" : "Paste your key"} aria-label={`${name} API key`} />
              <button type="submit" disabled={saving !== null || !values[key]?.trim()}>{saving === key ? "Saving…" : "Save"}</button>
            </form>
          </li>
        ))}
      </ul>
      <p className="onboarding-hint">A key stays on this Mac, in Socrates' own folder, and is never shown again.</p>
      {error && <p className="setup-error" role="alert">{error}</p>}
    </>
  );
}

/** The folders Socrates may use: the first becomes the project folder, new work starts there. */
function Folders({ app }: { app: AppState }) {
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const access = app.settings?.access;
  const folders = access?.folders ?? [];
  const project = app.status?.workingFolder?.path ?? null;

  const remove = async (folder: string) => {
    setError(null);
    try {
      await store.setAccess({ folders: folders.filter((f) => f !== folder) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      {folders.length > 0 && (
        <ul className="onboarding-folders">
          {folders.map((folder) => (
            <li key={folder}>
              <FolderOpen aria-hidden />
              <span title={folder}>{nameOf(folder)}<small>{folder.replace(/^\/Users\/[^/]+/, "~")}</small></span>
              {folder === project && <em>Project folder</em>}
              <button type="button" className="icon-button" aria-label={`Remove ${nameOf(folder)}`} onClick={() => void remove(folder)}><X aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="onboarding-add" onClick={() => setPicking(true)}><Plus aria-hidden /> {folders.length ? "Add another folder" : "Add a folder"}</button>
      {error && <p className="setup-error" role="alert">{error}</p>}
      {picking && (
        <FolderPicker
          title={project ? "Add a folder Socrates may use" : "Choose a folder to work in"}
          onCancel={() => setPicking(false)}
          onChoose={async (path) => {
            // The first folder is where new work starts; later ones only join the list.
            if (project) await store.setAccess({ folders: [...folders, path] });
            else await store.chooseProjectFolder(path);
            setPicking(false);
          }}
        />
      )}
    </>
  );
}
