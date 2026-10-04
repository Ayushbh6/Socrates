import { FolderOpen, Folders, Hand, Plus, ShieldAlert, X, Zap } from "lucide-react";
import { useState } from "react";
import { type AppState, store } from "../lib/store";
import { FolderPicker } from "./FolderPicker";
import { MenuItem } from "./Composer";
import { Popover } from "./Popover";

const nameOf = (folder: string) => folder.split("/").filter(Boolean).at(-1) ?? folder;

/** The header chip: where Socrates may work, and the folder new work starts in. */
export function AccessMenu({ app }: { app: AppState }) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const access = app.settings?.access;
  if (!access) return null;
  const full = access.scope === "full";
  const label = full ? "Full access" : access.folders.length ? `My folders: ${access.folders.map(nameOf).join(", ")}` : "My folders: none yet";
  return (
    <div className="chip-anchor">
      <button type="button" className="chip header-chip" data-warn={full} onClick={() => setOpen(!open)} aria-expanded={open}>
        {full ? <ShieldAlert aria-hidden /> : <Folders aria-hidden />}
        <span className="chip-label">{label}</span>
      </button>
      {open && (
        <Popover onClose={() => !picking && setOpen(false)} className="access-menu" align="left">
          <AccessControls app={app} onPicking={setPicking} />
        </Popover>
      )}
    </div>
  );
}

/**
 * The project folder, where Socrates may work and, optionally, how its
 * actions are approved: in the header menu and in settings.
 */
export function AccessControls({ app, approvals = false, onPicking }: { app: AppState; approvals?: boolean; onPicking?: (picking: boolean) => void }) {
  const [picking, setPickingState] = useState<"add" | "project" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const access = app.settings?.access;
  if (!access) return null;
  const full = access.scope === "full";
  const setPicking = (value: "add" | "project" | null) => {
    setPickingState(value);
    onPicking?.(value !== null);
  };
  const attempt = async (work: () => Promise<void>) => {
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <p className="menu-title">Project folder</p>
      <div className="access-project">
        <FolderOpen aria-hidden />
        <span title={app.status?.workingFolder?.path}>{app.status?.workingFolder?.name ?? "None yet: new work has no files"}</span>
        <button type="button" className="quiet-button" onClick={() => setPicking("project")}>Change…</button>
      </div>
      <p className="menu-title">Where can Socrates work?</p>
      <MenuItem icon={<Folders aria-hidden />} title="My folders" detail="Only the folders you add. Anything else asks first." selected={!full} onClick={() => attempt(() => store.setAccess({ scope: "folders" }))} />
      {!full && (
        <ul className="access-folders">
          {access.folders.map((folder) => (
            <li key={folder}>
              <span title={folder}>{folder.replace(/^\/Users\/[^/]+/, "~")}</span>
              <button type="button" className="icon-button" aria-label={`Remove ${nameOf(folder)}`} onClick={() => attempt(() => store.setAccess({ folders: access.folders.filter((f) => f !== folder) }))}><X aria-hidden /></button>
            </li>
          ))}
          <li>
            <button type="button" className="quiet-button" onClick={() => setPicking("add")}><Plus aria-hidden /> Add folder…</button>
          </li>
        </ul>
      )}
      <MenuItem icon={<ShieldAlert aria-hidden />} title="Full access" detail="Any file on this Mac. Socrates' own data stays off limits." selected={full} warn onClick={() => attempt(() => store.setAccess({ scope: "full" }))} />
      {approvals && (
        <>
          <p className="menu-title">How should Socrates' actions be approved?</p>
          <MenuItem icon={<Hand aria-hidden />} title="Ask first" detail="Reading is free. Every edit and command asks you." selected={access.approvals === "ask"} onClick={() => attempt(() => store.setAccess({ approvals: "ask" }))} />
          <MenuItem icon={<Zap aria-hidden />} title="Work freely" detail="Edits and commands run without asking." selected={access.approvals === "auto"} warn={full} onClick={() => attempt(() => store.setAccess({ approvals: "auto" }))} />
        </>
      )}
      {error && <p className="setup-error" role="alert">{error}</p>}
      {picking && (
        <FolderPicker
          title={picking === "add" ? "Add a folder Socrates may use" : "Choose the project folder"}
          onCancel={() => setPicking(null)}
          onChoose={async (path) => {
            if (picking === "add") await store.setAccess({ folders: [...access.folders, path] });
            else await store.chooseProjectFolder(path);
            setPicking(null);
          }}
        />
      )}
    </>
  );
}
