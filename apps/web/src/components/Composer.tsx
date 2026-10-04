import { AlertTriangle, ArrowUp, Check, ChevronDown, Hand, ImagePlus, ListPlus, LoaderCircle, Square, Split, X, Zap } from "lucide-react";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { IMAGES_MAX, IMAGE_TYPES } from "../lib/images";
import { conversationBusy, sendTarget } from "../lib/model";
import { type AppState, type PendingImage, store } from "../lib/store";
import { type AttachmentView, MAX_RUNNING_LANES } from "../lib/types";
import { Popover } from "./Popover";

/** The message box: Send, Queue while main works, or Send in a new lane (architecture/web.md, "Composer"). */
export function Composer({ app, conversation, laneNumber, onNewLane, onModel, onSent, variant = "float", compact = false, autoFocus = true }: {
  app: AppState;
  conversation: string;
  laneNumber: number | null;
  onNewLane: (text: string, attachments: AttachmentView[]) => string | null;
  /** The model label opens the settings. */
  onModel?: () => void;
  onSent?: () => void;
  /** Floating over the flow canvas, or inside a standard-mode panel. */
  variant?: "float" | "panel";
  /** A lane panel's composer: no approvals chip or model label. */
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const text = app.drafts[conversation] ?? "";
  const setText = (value: string) => store.setDraft(conversation, value);
  const [menu, setMenu] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const live = app.model.live;
  const busy = conversationBusy(live, conversation);
  const target = sendTarget(conversation, live?.busy ?? false);
  const runningLanes = live?.lanes.filter((l) => l.running).length ?? 0;
  const images = app.images[conversation] ?? [];
  const attachments = images.flatMap((i) => (i.status === "ready" && i.attachment ? [i.attachment] : []));
  const uploading = images.some((i) => i.status === "uploading");
  const empty = !text.trim();
  // Images wait for their upload, and go only with a message that says something.
  const unavailable = !app.connected || !live?.ready || uploading;
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const attach = (files: File[]) => {
    const images = files.filter((f) => IMAGE_TYPES.includes(f.type));
    if (images.length) store.addImages(conversation, images);
  };
  const drop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    attach([...e.dataTransfer.files]);
  };
  const paste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => IMAGE_TYPES.includes(f.type));
    if (!files.length) return;
    // A pasted screenshot is attached; pasted text still goes into the message.
    if (!e.clipboardData.getData("text")) e.preventDefault();
    attach(files);
  };

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);
  useEffect(() => {
    if (autoFocus) area.current?.focus();
  }, [conversation, autoFocus]);

  const submit = (how: "send" | "queue" | "lane" = target) => {
    if (empty || unavailable || (how === "lane" && runningLanes >= MAX_RUNNING_LANES)) return;
    const sent = how === "lane" ? onNewLane(text, attachments) : how === "queue" ? store.queue(text, attachments) : store.send(text, conversation, attachments);
    if (!sent) return;
    onSent?.();
    setText("");
    store.clearImages(conversation);
    setMenu(false);
  };
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="composer-dock" data-variant={variant} data-compact={compact}>
      {conversation === "main" && live && live.queue.length > 0 && (
        <ul className="queue" aria-label="Queued messages">
          {live.queue.map((q) => (
            <li key={q.id}>
              <span>{q.text}{q.attachments?.length ? <small> · {q.attachments.length} image{q.attachments.length === 1 ? "" : "s"}</small> : null}</span>
              <button type="button" className="icon-button" title="Send in a new lane instead" aria-label="Send in a new lane instead" disabled={runningLanes >= MAX_RUNNING_LANES} onClick={() => store.queuedToLane(q.id)}><Split aria-hidden /></button>
              <button type="button" className="icon-button" title="Remove" aria-label="Remove from the queue" onClick={() => store.removeQueued(q.id)}><X aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}
      <div
        className="composer"
        data-dragging={dragging}
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={drop}
      >
        {images.length > 0 && <Thumbnails images={images} onRemove={(key) => store.removeImage(conversation, key)} />}
        {images.length > 0 && app.status?.models.chat?.vision === false && (
          <p className="composer-note"><AlertTriangle aria-hidden /> {app.status.models.chat.model} can't see images: Socrates will know only their names and sizes.</p>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keys}
          onPaste={paste}
          placeholder={images.length && empty ? "Say what to do with the images…" : laneNumber ? `Message lane ${laneNumber}…` : busy ? "Socrates is working. Your message will wait in the queue…" : "Ask Socrates…"}
          aria-label="Message"
        />
        <div className="composer-row">
          <button type="button" className="icon-button attach-button" onClick={() => picker.current?.click()} disabled={images.length >= IMAGES_MAX} aria-label="Attach images" title={images.length >= IMAGES_MAX ? `At most ${IMAGES_MAX} images` : "Attach images (or drop or paste them)"}>
            <ImagePlus aria-hidden />
          </button>
          <input ref={picker} type="file" accept={IMAGE_TYPES.join(",")} multiple hidden onChange={(e) => { attach([...(e.target.files ?? [])]); e.target.value = ""; }} />
          {!compact && <ApprovalsChip app={app} />}
          <span className="composer-space" />
          {!compact && app.status?.models.chat && (
            <button type="button" className="composer-model" title="The chat model: change it in settings" onClick={onModel}>{app.status.models.chat.model}</button>
          )}
          {busy && (
            <button type="button" className="stop-button" onClick={() => store.cancel(conversation)} aria-label="Stop">
              <Square aria-hidden />
            </button>
          )}
          <div className="send-group">
            <button type="button" className="send-button" disabled={empty || unavailable} onClick={() => submit()} aria-label={target === "queue" ? "Queue" : "Send"} title={target === "queue" ? "Queue: runs when Socrates is free" : "Send"}>
              {target === "queue" ? <ListPlus aria-hidden /> : <ArrowUp aria-hidden />}
            </button>
            <button type="button" className="send-more" onClick={() => setMenu(!menu)} aria-label="More ways to send" aria-expanded={menu}>
              <ChevronDown aria-hidden />
            </button>
            {menu && (
              <Popover onClose={() => setMenu(false)} className="send-menu" align="right" above>
                <MenuItem icon={<ArrowUp aria-hidden />} title="Send" detail={conversation === "main" ? "To the main conversation" : `To lane ${laneNumber}`} disabled={empty || unavailable || target === "queue"} onClick={() => submit("send")} />
                <MenuItem icon={<ListPlus aria-hidden />} title="Queue" detail="Runs as soon as Socrates is free" disabled={empty || unavailable || conversation !== "main" || !live?.busy} onClick={() => submit("queue")} />
                <MenuItem icon={<Split aria-hidden />} title="Send in a new lane" detail={runningLanes >= MAX_RUNNING_LANES ? `${MAX_RUNNING_LANES} lanes are already working` : "Works beside the main conversation"} disabled={empty || unavailable || runningLanes >= MAX_RUNNING_LANES} onClick={() => submit("lane")} />
              </Popover>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MenuItem({ icon, title, detail, disabled, onClick, selected, warn }: { icon: ReactNode; title: string; detail: string; disabled?: boolean; onClick: () => void; selected?: boolean; warn?: boolean }) {
  return (
    <button type="button" className="menu-item" data-warn={warn} disabled={disabled} onClick={onClick} role="menuitem">
      <span className="menu-icon">{icon}</span>
      <span className="menu-text"><strong>{title}</strong><small>{detail}</small></span>
      {selected && <Check aria-hidden className="menu-check" />}
    </button>
  );
}

/** "Ask first" or "Work freely": whether edits and commands wait for the user. */
function ApprovalsChip({ app }: { app: AppState }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const access = app.settings?.access;
  if (!access) return null;
  const free = access.approvals === "auto";
  const choose = async (approvals: "ask" | "auto") => {
    setError(null);
    try {
      await store.setAccess({ approvals });
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="chip-anchor">
      <button type="button" className="chip" data-warn={free && access.scope === "full"} onClick={() => setOpen(!open)} aria-expanded={open}>
        {free ? <Zap aria-hidden /> : <Hand aria-hidden />} {free ? "Work freely" : "Ask first"}
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)} className="chip-menu" align="left" above>
          <p className="menu-title">How should Socrates' actions be approved?</p>
          <MenuItem icon={<Hand aria-hidden />} title="Ask first" detail="Reading is free. Every edit and command asks you." selected={!free} onClick={() => choose("ask")} />
          <MenuItem icon={<Zap aria-hidden />} title="Work freely" detail="Edits and commands run without asking." selected={free} warn={access.scope === "full"} onClick={() => choose("auto")} />
          {error && <p className="setup-error" role="alert">{error}</p>}
        </Popover>
      )}
    </div>
  );
}

export { MenuItem };

/** The images waiting to go with the message, each removable before it is sent. */
function Thumbnails({ images, onRemove }: { images: PendingImage[]; onRemove: (key: string) => void }) {
  return (
    <ul className="thumbnails" aria-label="Attached images">
      {images.map((image) => (
        <li key={image.key} className="thumbnail" data-status={image.status} title={image.error ?? image.name}>
          {image.attachment ? <img src={`/api/attachments/${image.attachment.id}`} alt={image.name} /> : image.status === "uploading" ? <LoaderCircle aria-label="Attaching" className="spin" /> : <AlertTriangle aria-label={image.error ?? "Could not attach"} />}
          <button type="button" className="thumbnail-remove" onClick={() => onRemove(image.key)} aria-label={`Remove ${image.name}`}><X aria-hidden /></button>
        </li>
      ))}
    </ul>
  );
}

