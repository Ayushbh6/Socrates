import { ArrowRight, FolderOpen, KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { type AppState, store } from "../lib/store";
import { FolderPicker } from "./FolderPicker";

const PROVIDERS = [
  { name: "Anthropic", key: "ANTHROPIC_API_KEY" },
  { name: "OpenAI", key: "OPENAI_API_KEY" },
  { name: "Gemini", key: "GEMINI_API_KEY" },
  { name: "OpenRouter", key: "OPENROUTER_API_KEY" },
  { name: "DeepSeek", key: "DEEPSEEK_API_KEY" },
];

/** Socrates' front door: one button once it is set up, a short setup before that. */
export function Welcome({ app, onOpen }: { app: AppState; onOpen: () => void }) {
  const ready = app.status?.ready ?? false;
  return (
    <main className="welcome">
      <p className="welcome-eyebrow">Your thinking workspace</p>
      <h1 className="welcome-title">Socrates</h1>
      <p className="welcome-motto">Think clearly. Ask well. Live examined.</p>
      {app.error ? (
        <p className="welcome-sub">Socrates could not load: {app.error}</p>
      ) : !app.status ? (
        <p className="welcome-sub">Waking Socrates…</p>
      ) : ready ? (
        <>
          <p className="welcome-sub">{app.status.workingFolder ? `Working in ${app.status.workingFolder.name}.` : "Ready when you are."}</p>
          <button type="button" className="welcome-button" onClick={onOpen} autoFocus>
            Chat with Socrates <ArrowRight aria-hidden />
          </button>
        </>
      ) : (
        <Setup app={app} />
      )}
    </main>
  );
}

function Setup({ app }: { app: AppState }) {
  const [provider, setProvider] = useState(PROVIDERS[0]!.key);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.setKey(provider, value.trim());
      setValue("");
      await store.refreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="setup" aria-label="Set up Socrates">
      <p className="welcome-sub">A short setup comes first.</p>
      {app.status?.setup.map((line) => <p key={line} className="setup-line">{line}</p>)}
      <form className="setup-row" onSubmit={save}>
        <KeyRound aria-hidden className="setup-icon" />
        <select value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider">
          {PROVIDERS.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
        </select>
        <input type="password" autoComplete="off" placeholder="API key" value={value} onChange={(e) => setValue(e.target.value)} aria-label="API key" />
        <button type="submit" disabled={saving || !value.trim()}>{saving ? "Saving…" : "Save"}</button>
      </form>
      <p className="setup-hint">The key stays on this Mac, in Socrates' own folder. It is never shown again.</p>
      <div className="setup-row">
        <FolderOpen aria-hidden className="setup-icon" />
        <span className="setup-folder">{app.status?.workingFolder?.path ?? "No project folder yet"}</span>
        <button type="button" onClick={() => setPicking(true)}>Choose…</button>
      </div>
      {error && <p className="setup-error" role="alert">{error}</p>}
      {picking && (
        <FolderPicker
          title="Choose the project folder"
          onCancel={() => setPicking(false)}
          onChoose={async (path) => {
            await store.chooseProjectFolder(path);
            setPicking(false);
          }}
        />
      )}
    </section>
  );
}
