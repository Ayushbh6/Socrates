import { ChevronLeft, Folder, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Folders } from "../lib/types";

/** Browse this Mac's folders and choose one. */
export function FolderPicker({ title, onChoose, onCancel }: { title: string; onChoose: (path: string) => Promise<void>; onCancel: () => void }) {
  const [listing, setListing] = useState<Folders | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = (path?: string) => {
    setError(null);
    api.folders(path).then((found) => {
      setListing(found);
      setTyped(found.path);
      if (!path) setHome(found.path);
    }, (e) => setError(e.message));
  };
  // A typed or pasted path; ~ is the home folder the picker opened in.
  const go = () => open(home && (typed === "~" || typed.startsWith("~/")) ? home + typed.slice(1) : typed.trim());
  useEffect(() => {
    open();
  }, []);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel]);

  const choose = async () => {
    if (!listing) return;
    setBusy(true);
    setError(null);
    try {
      await onChoose(listing.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal picker" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <strong>{title}</strong>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="Close"><X aria-hidden /></button>
        </div>
        <div className="picker-path">
          <button type="button" className="icon-button" disabled={!listing?.parent} onClick={() => listing?.parent && open(listing.parent)} aria-label="Up one folder"><ChevronLeft aria-hidden /></button>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} aria-label="Folder path" spellCheck={false} />
        </div>
        <ul className="picker-list">
          {listing?.folders.map((f) => (
            <li key={f.path}>
              <button type="button" onClick={() => open(f.path)}><Folder aria-hidden /> {f.name}</button>
            </li>
          ))}
          {listing && !listing.folders.length && <li className="picker-empty">No folders inside.</li>}
        </ul>
        {error && <p className="setup-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="quiet-button" onClick={onCancel}>Cancel</button>
          <button type="button" className="solid-button" disabled={!listing || busy} onClick={choose}>Choose this folder</button>
        </div>
      </div>
    </div>
  );
}
