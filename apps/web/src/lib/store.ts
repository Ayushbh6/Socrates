import { useSyncExternalStore } from "react";
import { type SettingsPatch, api } from "./api";
import { IMAGES_MAX, prepareImage } from "./images";
import { LiveConnection } from "./live";
import { type Model, type ModelEvent, emptyModel, reduce, replayFrom } from "./model";
import type { Access, AttachmentView, Command, Effort, GoalView, ServerMessage, Settings, Status } from "./types";

export interface AppState {
  model: Model;
  status: Status | null;
  settings: Settings | null;
  goals: GoalView[];
  /** Whether the live connection is up. */
  connected: boolean;
  /** Where each conversation's older history continues, or null at its start. */
  older: Record<string, number | null>;
  /** A problem loading Socrates, for the user. */
  error: string | null;
  /** Unsent text belongs to its conversation and survives a mode switch or reconnect. */
  drafts: Record<string, string>;
  /** Images waiting to go with each conversation's next message. */
  images: Record<string, PendingImage[]>;
}

/** An image in the composer: being stored, ready to send, or refused. */
export interface PendingImage {
  key: string;
  name: string;
  status: "uploading" | "ready" | "failed";
  attachment?: AttachmentView;
  error?: string;
}

/** What the server needs of each attached image: its id and its name. */
const named = (attachments: AttachmentView[]) => (attachments.length ? { attachments: attachments.map(({ id, name }) => ({ id, name })) } : {});

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** The page's one source of truth: history, the live connection, and the server's settings. */
export class Store {
  private state: AppState = { model: emptyModel(), status: null, settings: null, goals: [], connected: false, older: {}, error: null, drafts: {}, images: {} };
  private readonly listeners = new Set<() => void>();
  private resume: number | null = null;
  private goalsTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering: Promise<void> | null = null;
  private readonly loadingOlder = new Set<string>();
  private statusRequest = 0;
  private readonly pendingQueue = new Map<string, { text: string; attachments: AttachmentView[] }>();
  private readonly live = new LiveConnection({
    message: (message) => this.receive(message),
    connected: (connected) => this.set({ connected }),
    after: () => {
      const after = this.resume ?? this.state.model.seq;
      this.resume = null;
      return after;
    },
  });

  get = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setDraft(conversation: string, text: string): void {
    this.set({ drafts: { ...this.state.drafts, [conversation]: text } });
  }

  /** Status, settings, goals and recent history, then the live connection from where history ends. */
  async start(): Promise<void> {
    try {
      await this.load();
      this.live.start();
    } catch (error) {
      this.set({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  async refreshStatus(): Promise<void> {
    const request = ++this.statusRequest;
    const [status, settings] = await Promise.all([api.status(), api.settings()]);
    if (request === this.statusRequest) this.set({ status, settings });
  }

  /** Send to main or a lane, with any attached images; returns the message's id, or null when the connection is down. */
  send(text: string, to: string, attachments: AttachmentView[] = []): string | null {
    const id = newId();
    if (!this.command({ type: "send", id, text, to, ...named(attachments) })) return null;
    this.dispatch({ type: "sent", id, text, to, at: new Date().toISOString(), attachments });
    return id;
  }

  sendToNewLane(text: string, attachments: AttachmentView[] = []): string | null {
    return this.send(text, "new_lane", attachments);
  }

  queue(text: string, attachments: AttachmentView[] = []): boolean {
    const id = newId();
    this.pendingQueue.set(id, { text, attachments });
    if (this.command({ type: "queue", id, text, ...named(attachments) })) return true;
    this.pendingQueue.delete(id);
    return false;
  }

  /**
   * Attach images to a conversation's next message (architecture/web.md,
   * "Images"): each is made small enough to send, then stored by the server.
   * At most ten wait at once; the rest are refused with a notice.
   */
  addImages(conversation: string, files: File[]): void {
    const room = IMAGES_MAX - (this.state.images[conversation]?.length ?? 0);
    if (files.length > room) this.notice(`At most ${IMAGES_MAX} images can go with one message.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = newId();
      this.setImages(conversation, (list) => [...list, { key, name: file.name || "image", status: "uploading" }]);
      void prepareImage(file)
        .then((image) => api.upload(image, file.name || "image"))
        .then(
          (attachment) => this.setImages(conversation, (list) => list.map((i) => (i.key === key ? { ...i, status: "ready", attachment } : i))),
          (error) => this.setImages(conversation, (list) => list.map((i) => (i.key === key ? { ...i, status: "failed", error: error instanceof Error ? error.message : String(error) } : i))),
        );
    }
  }

  removeImage(conversation: string, key: string): void {
    this.setImages(conversation, (list) => list.filter((i) => i.key !== key));
  }

  clearImages(conversation: string): void {
    this.setImages(conversation, () => []);
  }

  private setImages(conversation: string, change: (list: PendingImage[]) => PendingImage[]): void {
    this.set({ images: { ...this.state.images, [conversation]: change(this.state.images[conversation] ?? []) } });
  }

  cancel(conversation: string): void {
    this.command({ type: "cancel", conversation });
  }

  approve(approval: string, granted: boolean): void {
    this.command({ type: "approve", approval, granted });
  }

  removeQueued(id: string): void {
    this.command({ type: "queue_remove", id });
  }

  queuedToLane(id: string): void {
    this.command({ type: "queue_to_lane", id });
  }

  closeLane(lane: string): void {
    this.command({ type: "close_lane", lane });
  }

  dismiss(id: number): void {
    this.dispatch({ type: "dismiss", id });
  }

  /** A change that restarts Socrates (models, memory search, time zone); refused while it works. */
  async saveSettings(patch: SettingsPatch): Promise<void> {
    this.set({ settings: await api.setSettings(patch) });
    await this.refreshStatus();
  }

  /** Finish onboarding: keep the name, if given, and never ask again. */
  async finishOnboarding(name: string): Promise<void> {
    await this.saveSettings({ profile: { name: name.trim() || null, onboarded: true } });
  }

  /** Make this the chat model; Socrates restarts with it at its default thinking level, so only when idle. */
  async chooseModel(provider: string, model: string): Promise<void> {
    await this.saveSettings({ chat: { provider, model } });
  }

  /** The chat model's thinking level; it applies to the next request, even while Socrates works. */
  async setEffort(effort: Effort): Promise<void> {
    const chat = this.state.status?.models.chat;
    if (!chat) return;
    await this.saveSettings({ chat: { provider: chat.provider, model: chat.model, effort } });
  }

  /** Set or, with null, remove a key; Socrates restarts with it. */
  async saveKey(name: string, value: string | null): Promise<void> {
    if (value === null) await api.removeKey(name);
    else await api.setKey(name, value);
    await this.refreshStatus();
  }

  async setAccess(access: Partial<Access>): Promise<void> {
    this.set({ settings: await api.setAccess(access) });
  }

  /** Make a folder the one new work starts in; it becomes one of the folders Socrates may use. */
  async chooseProjectFolder(path: string): Promise<void> {
    const workspace = await api.addWorkspace(path);
    const settings = await api.setWorkingFolder(workspace.id);
    this.set({ settings, status: await api.status() });
  }

  async loadOlder(conversation: string): Promise<void> {
    const before = this.state.older[conversation];
    if (!before || this.loadingOlder.has(conversation)) return;
    this.loadingOlder.add(conversation);
    try {
      const page = await api.history(conversation, before);
      this.dispatch({ type: "history", conversation, items: page.items, older: true });
      this.set({ older: { ...this.state.older, [conversation]: page.next } });
    } catch (error) {
      this.notice(error);
    } finally {
      this.loadingOlder.delete(conversation);
    }
  }

  private async load(snapshot = false): Promise<void> {
    const [status, settings, goals] = await Promise.all([api.status(), api.settings(), api.goals()]);
    const conversations = ["main", ...status.lanes.map((l) => l.id)];
    const pages = await Promise.all(conversations.map((c) => api.history(c)));
    let model: Model = emptyModel();
    const replay = replayFrom(pages.map((p) => p.items), status.seq);
    // A very old working turn cannot be rebuilt within the server's replay window.
    const useSnapshot = snapshot || status.seq - replay > 5_000;
    const resume = useSnapshot ? Math.min(...pages.map((p) => p.seq ?? status.seq)) : replay;
    conversations.forEach((conversation, i) => {
      // Messages after the resume point are rebuilt, with their steps, by the replay.
      const items = useSnapshot ? pages[i]!.items : pages[i]!.items.filter((item) => item.seq <= resume);
      model = reduce(model, { type: "history", conversation, items });
    });
    this.resume = resume;
    this.set({
      status,
      settings,
      goals,
      model: { ...model, seq: resume },
      older: Object.fromEntries(conversations.map((c, i) => [c, pages[i]!.next])),
      error: null,
    });
  }

  private receive(message: ServerMessage): void {
    if (message.type === "reset") {
      // Pause delivery while rebuilding, then say hello again for activity and current drafts.
      if (!this.recovering) {
        this.live.stop();
        this.recovering = this.load(true)
          .then(() => this.live.start())
          .catch((error) => this.set({ error: String(error) }))
          .finally(() => { this.recovering = null; });
      }
      return;
    }
    if (message.type === "error" && message.id && message.code === "main_busy") {
      // Main became busy as this was sent: it waits in the queue instead.
      const sent = Object.values(this.state.model.conversations).flat().find((e) => e.sendId === message.id);
      this.dispatch({ type: "unsent", id: message.id });
      if (sent && !this.queue(sent.message, sent.attachments)) this.rejectedQueue(message.id, sent.message, "Socrates is reconnecting. Try again in a moment.", sent.attachments);
      return;
    }
    if (message.type === "state") {
      for (const queued of message.queue) this.pendingQueue.delete(queued.id);
    }
    if (message.type === "accepted" || message.type === "result") this.pendingQueue.delete(message.id);
    if (message.type === "error") {
      const queued = message.id ? this.pendingQueue.get(message.id) : undefined;
      if (queued !== undefined && message.id) {
        this.pendingQueue.delete(message.id);
        this.rejectedQueue(message.id, queued.text, message.message, queued.attachments);
        return;
      }
      const known = message.id && [...this.state.model.pending, ...Object.values(this.state.model.conversations).flat()].some(e => e.sendId === message.id);
      if (!known) this.notice(message.message);
    }
    if (message.type === "state" && this.state.status) {
      const changed = message.settings && JSON.stringify(message.settings) !== JSON.stringify(this.state.settings);
      if (changed) this.set({ settings: message.settings! });
      if (changed || message.ready !== this.state.model.live?.ready) void this.refreshStatus().catch((error) => this.notice(error));
    }
    // Another tab may have changed where Socrates works.
    if (message.type === "state" && this.state.settings && JSON.stringify(message.access) !== JSON.stringify(this.state.settings.access)) this.set({ settings: { ...this.state.settings, access: message.access } });
    this.dispatch({ type: "server", message });
    if (message.type === "activity" && ["ledger", "routed", "finished", "lane"].includes(message.kind)) this.refreshGoals();
  }

  private refreshGoals(): void {
    if (this.goalsTimer) return;
    this.goalsTimer = setTimeout(() => {
      this.goalsTimer = null;
      void api.goals().then((goals) => this.set({ goals }), () => {});
    }, 300);
  }

  private command(command: Command): boolean {
    const sent = this.live.send(command);
    if (!sent) this.dispatch({ type: "server", message: { type: "result", id: "", conversation: "main", result: { kind: "notice", text: "", notices: ["Socrates is reconnecting. Try again in a moment."] } } });
    return sent;
  }

  private notice(error: unknown): void {
    this.dispatch({ type: "server", message: { type: "result", id: "", conversation: "main", result: { kind: "notice", text: "", notices: [error instanceof Error ? error.message : String(error)] } } });
  }

  private rejectedQueue(id: string, text: string, message: string, attachments: AttachmentView[] = []): void {
    if (!this.state.drafts.main) this.setDraft("main", text);
    // Its images go back to the composer too, unless others already wait there.
    if (attachments.length && !this.state.images.main?.length) this.setImages("main", () => attachments.map((attachment) => ({ key: newId(), name: attachment.name, status: "ready", attachment })));
    // Preserve it on the page even if the reader has already started another draft.
    this.dispatch({ type: "sent", id, text, to: "main", at: new Date().toISOString(), attachments });
    this.dispatch({ type: "server", message: { type: "error", id, code: "queue_failed", message } });
  }

  private dispatch(event: ModelEvent): void {
    this.set({ model: reduce(this.state.model, event) });
  }

  private set(change: Partial<AppState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}

export const store = new Store();

export function useApp(): AppState {
  return useSyncExternalStore(store.subscribe, store.get);
}
