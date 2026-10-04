import { useSyncExternalStore } from "react";
import { api } from "./api";
import { LiveConnection } from "./live";
import { type Model, type ModelEvent, emptyModel, reduce, replayFrom } from "./model";
import type { Access, Command, GoalView, ServerMessage, Settings, Status } from "./types";

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
}

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** The page's one source of truth: history, the live connection, and the server's settings. */
export class Store {
  private state: AppState = { model: emptyModel(), status: null, settings: null, goals: [], connected: false, older: {}, error: null, drafts: {} };
  private readonly listeners = new Set<() => void>();
  private resume: number | null = null;
  private goalsTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering: Promise<void> | null = null;
  private readonly loadingOlder = new Set<string>();
  private statusRequest = 0;
  private readonly pendingQueue = new Map<string, string>();
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

  /** Send to main or a lane; returns the message's id, or null when the connection is down. */
  send(text: string, to: string): string | null {
    const id = newId();
    if (!this.command({ type: "send", id, text, to })) return null;
    this.dispatch({ type: "sent", id, text, to, at: new Date().toISOString() });
    return id;
  }

  sendToNewLane(text: string): string | null {
    return this.send(text, "new_lane");
  }

  queue(text: string): boolean {
    const id = newId();
    this.pendingQueue.set(id, text);
    if (this.command({ type: "queue", id, text })) return true;
    this.pendingQueue.delete(id);
    return false;
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
  async saveSettings(patch: Partial<Omit<Settings, "access" | "workingFolder">>): Promise<void> {
    this.set({ settings: await api.setSettings(patch) });
    await this.refreshStatus();
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
      if (sent && !this.queue(sent.message)) this.rejectedQueue(message.id, sent.message, "Socrates is reconnecting. Try again in a moment.");
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
        this.rejectedQueue(message.id, queued, message.message);
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

  private rejectedQueue(id: string, text: string, message: string): void {
    if (!this.state.drafts.main) this.setDraft("main", text);
    // Preserve it on the page even if the reader has already started another draft.
    this.dispatch({ type: "sent", id, text, to: "main", at: new Date().toISOString() });
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
