import { ChevronLeft, Folder, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useDialog } from "../lib/dialog";
import type { Folders } from "../lib/types";

/** Browse this Mac's folders and choose one. */
export function FolderPicker({ title, onChoose, onCancel }: { title: string; onChoose: (path: string) => Promise<void>; onCancel: () => void }) {
  const [listing, setListing] = useState<Folders | null>(null);
  const [home, setHome] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  const modal = useRef<HTMLDivElement>(null);
  useDialog(modal, onCancel);

  const open = (path?: string) => {
    if (busy) return;
    const id = ++request.current;
    setError(null);
    setLoading(true);
    api.folders(path).then((found) => {
      if (request.current !== id) return;
      setListing(found);
      setTyped(found.path);
      if (!path) setHome(found.path);
    }, (e) => { if (request.current === id) setError(e.message); })
      .finally(() => { if (request.current === id) setLoading(false); });
  };
  // A typed or pasted path; ~ is the home folder the picker opened in.
  const typedPath = () => {
    const value = typed.trim();
    return home && (value === "~" || value.startsWith("~/")) ? home + value.slice(1) : value;
  };
  const go = () => { if (!busy) open(typedPath()); };
  useEffect(() => {
    open();
    return () => { request.current++; };
  }, []);

  const choose = async () => {
    if (!listing || busy || loading || !typed.trim()) return;
    const id = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const found = typedPath() === listing.path ? listing : await api.folders(typedPath());
      if (id !== request.current) return;
      setListing(found);
      setTyped(found.path);
      await onChoose(found.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // At the page level, so no panel's blur or clipping can trap the dialog.
  return createPortal(
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div ref={modal} tabIndex={-1} className="modal picker" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <strong>{title}</strong>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="Close"><X aria-hidden /></button>
        </div>
        <div className="picker-path">
          <button type="button" className="icon-button" disabled={!listing?.parent} onClick={() => listing?.parent && open(listing.parent)} aria-label="Up one folder"><ChevronLeft aria-hidden /></button>
          <input value={typed} disabled={busy} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} aria-label="Folder path" spellCheck={false} />
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
          <button type="button" className="solid-button" disabled={!listing || busy || loading || !typed.trim()} onClick={choose}>Choose this folder</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
