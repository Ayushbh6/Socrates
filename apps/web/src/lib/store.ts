import { useSyncExternalStore } from "react";
import { type SettingsPatch, api } from "./api";
import { approvalExchange } from "./approvals";
import { IMAGES_MAX, prepareImage } from "./images";
import { LiveConnection } from "./live";
import { type Exchange, type Model, type ModelEvent, emptyModel, reduce, replayFrom } from "./model";
import type { Access, ArchivedView, AttachmentView, ChatChoice, Command, Effort, GoalView, KeepChoice, LedgerStatus, PendingApproval, ServerMessage, Settings, Status, TerminalView } from "./types";

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
  /** What is archived, once its list has been opened. */
  archived: ArchivedView | null;
  /** The terminal sessions the agent started (null until the server first lists them). */
  terminals: TerminalView[] | null;
}

/** A terminal on the page: what the session shows when opened (again, after a reconnect), then what it prints. */
export interface TerminalWatcher {
  replay(data: string, size: { cols: number; rows: number } | null): void;
  output(data: string): void;
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
  private state: AppState = { model: emptyModel(), status: null, settings: null, goals: [], connected: false, older: {}, error: null, drafts: {}, images: {}, archived: null, terminals: null };
  private readonly listeners = new Set<() => void>();
  private resume: number | null = null;
  private goalsTimer: ReturnType<typeof setTimeout> | null = null;
  private recovering: Promise<void> | null = null;
  private readonly loadingOlder = new Map<string, Promise<void>>();
  private statusRequest = 0;
  private readonly pendingQueue = new Map<string, { text: string; attachments: AttachmentView[] }>();
  /** The chat each standard-mode message was sent to, so one that finds main busy is queued for the same chat. */
  private readonly sentChats = new Map<string, ChatChoice>();
  /** The terminal sessions open on this page; their output never goes through the app's state. */
  private readonly terminalWatchers = new Map<string, TerminalWatcher>();
  private readonly restartListeners = new Set<(from: string, to: string) => void>();
  private readonly live = new LiveConnection({
    message: (message) => this.receive(message),
    connected: (connected) => {
      this.set({ connected });
      // A new connection shows nothing until each open terminal asks again.
      if (connected) for (const session of this.terminalWatchers.keys()) this.live.send({ type: "terminal_open", session });
    },
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

  /**
   * Send to main or a lane, with any attached images: in standard mode to its
   * chosen chat, in flow mode kept in a chosen task when `keep` is given.
   * Returns the message's id, or null when the connection is down.
   */
  send(text: string, to: string, attachments: AttachmentView[] = [], chat?: ChatChoice, keep?: KeepChoice): string | null {
    const id = newId();
    if (!this.command({ type: "send", id, text, to, ...named(attachments), ...(chat ? { chat } : {}), ...(keep ? { keep } : {}) })) return null;
    if (chat) this.sentChats.set(id, chat);
    this.dispatch({ type: "sent", id, text, to, at: new Date().toISOString(), attachments });
    return id;
  }

  /**
   * Ask a finished or stopped question again in another task: a chosen chat,
   * or today's general conversation. It shows as a new message at once; the
   * server sets the first attempt aside. Returns its id, or null when the
   * connection is down.
   */
  redo(exchange: Exchange, to: { chat: ChatChoice } | { general: true }): string | null {
    const turn = exchange.turns[0];
    if (!turn) return null;
    const id = newId();
    if (!this.command({ type: "redo", id, turn, ...to })) return null;
    if ("chat" in to) this.sentChats.set(id, to.chat);
    this.dispatch({ type: "sent", id, text: exchange.message, to: "main", at: new Date().toISOString(), attachments: exchange.attachments });
    return id;
  }

  sendToNewLane(text: string, attachments: AttachmentView[] = []): string | null {
    return this.send(text, "new_lane", attachments);
  }

  /** Queue a message; returns its id (kept when a sent message is queued instead), or null when the connection is down. */
  queue(text: string, attachments: AttachmentView[] = [], chat?: ChatChoice, keep?: KeepChoice, id = newId()): string | null {
    this.pendingQueue.set(id, { text, attachments });
    if (this.command({ type: "queue", id, text, ...named(attachments), ...(chat ? { chat } : {}), ...(keep ? { keep } : {}) })) return id;
    this.pendingQueue.delete(id);
    return null;
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

  /** Show a terminal session in the panel; returns what closes it. */
  watchTerminal(session: string, watcher: TerminalWatcher): () => void {
    this.terminalWatchers.set(session, watcher);
    this.live.send({ type: "terminal_open", session });
    return () => {
      if (this.terminalWatchers.get(session) !== watcher) return;
      this.terminalWatchers.delete(session);
      this.live.send({ type: "terminal_shut", session });
    };
  }

  /** What the user types into a terminal, or a paste. */
  terminalInput(session: string, data: string): void {
    this.live.send({ type: "terminal_input", session, data });
  }

  resizeTerminal(session: string, cols: number, rows: number): void {
    this.live.send({ type: "terminal_resize", session, cols, rows });
  }

  terminal(action: "terminal_stop" | "terminal_restart" | "terminal_dismiss", session: string): void {
    this.command({ type: action, session });
  }

  /** A session the user restarted has a new id; the panel follows it. */
  onTerminalRestarted(listener: (from: string, to: string) => void): () => void {
    this.restartListeners.add(listener);
    return () => this.restartListeners.delete(listener);
  }

  /** Stop what works in a conversation; with `chat`, only the message working in that standard-mode chat. */
  cancel(conversation: string, chat?: ChatChoice): void {
    this.command({ type: "cancel", conversation, ...(chat ? { chat } : {}) });
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

  loadOlder(conversation: string): Promise<void> {
    const loading = this.loadingOlder.get(conversation);
    if (loading) return loading;
    const before = this.state.older[conversation];
    if (!before) return Promise.resolve();
    const work = api.history(conversation, before).then((page) => {
      this.dispatch({ type: "history", conversation, items: page.items, older: true });
      this.set({ older: { ...this.state.older, [conversation]: page.next } });
    }).catch((error) => this.notice(error)).finally(() => { this.loadingOlder.delete(conversation); });
    this.loadingOlder.set(conversation, work);
    return work;
  }

  /** Find the original question, fetching older pages when needed. A settled approval never opens stale work. */
  async resolveApproval(approval: PendingApproval): Promise<Exchange | null> {
    const waiting = () => this.state.model.live?.approvals.some((a) => a.id === approval.id);
    while (waiting()) {
      const found = approvalExchange(this.state.model, approval);
      if (found) return found;
      const before = this.state.older[approval.conversation];
      if (before === undefined) {
        try {
          const page = await api.history(approval.conversation);
          this.dispatch({ type: "history", conversation: approval.conversation, items: page.items, older: true });
          this.set({ older: { ...this.state.older, [approval.conversation]: page.next } });
        } catch (error) { this.notice(error); return null; }
      } else {
        if (!before) break;
        await this.loadOlder(approval.conversation);
        if (before === this.state.older[approval.conversation]) return null;
      }
    }
    if (waiting()) this.notice("The approval's question could not be loaded. Try again in a moment.");
    return null;
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
    switch (message.type) {
      case "terminals":
        return this.set({ terminals: message.terminals });
      case "terminal_replay":
        return this.terminalWatchers.get(message.session)?.replay(message.data, message.cols && message.rows ? { cols: message.cols, rows: message.rows } : null);
      case "terminal_output":
        return this.terminalWatchers.get(message.session)?.output(message.data);
      case "terminal_restarted":
        for (const listener of this.restartListeners) listener(message.session, message.next);
        return;
    }
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
    if (message.type === "error" && message.id && (message.code === "main_busy" || message.code === "chat_busy")) {
      // Main (or the chat) became busy as this was sent: it waits in the queue instead.
      const sent = Object.values(this.state.model.conversations).flat().find((e) => e.sendId === message.id);
      this.dispatch({ type: "unsent", id: message.id });
      const chat = this.sentChats.get(message.id);
      this.sentChats.delete(message.id);
      if (sent && !this.queue(sent.message, sent.attachments, chat, undefined, message.id)) this.rejectedQueue(message.id, sent.message, "Socrates is reconnecting. Try again in a moment.", sent.attachments);
      return;
    }
    if (message.type === "state") {
      for (const queued of message.queue) this.pendingQueue.delete(queued.id);
    }
    if (message.type === "accepted" || message.type === "result") this.pendingQueue.delete(message.id);
    if ((message.type === "accepted" || message.type === "result" || message.type === "error") && message.id) this.sentChats.delete(message.id);
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

  /** Rename, archive and restore (standard mode's sidebar, flow mode's notes): done on the server, then the lists are read again. */
  async renameGoal(goal: number, title: string): Promise<void> {
    await api.renameGoal(goal, title);
    await this.reloadGoals();
  }

  async renameChat(goal: number, task: number, title: string): Promise<void> {
    await api.renameChat(goal, task, title);
    await this.reloadGoals();
  }

  async archive(what: { goal: number; task?: number }): Promise<void> {
    await (what.task === undefined ? api.archiveGoal(what.goal) : api.archiveChat(what.goal, what.task));
    await this.reloadGoals();
  }

  async restore(what: { goal: number; task?: number }): Promise<void> {
    await (what.task === undefined ? api.restoreGoal(what.goal) : api.restoreChat(what.goal, what.task));
    await this.reloadGoals();
  }

  /** Undo a memory from under an answer; the change arrives as activity on that answer. A refusal is shown as a notice. */
  async forgetMemory(number: number): Promise<void> {
    try {
      await api.forgetMemory(number);
    } catch (error) {
      this.notice(error);
    }
  }

  /** Set a goal's or task's status as the user chooses; a refusal is shown as a notice. */
  async setStatus(what: { goal: number; task?: number }, status: LedgerStatus): Promise<void> {
    try {
      await (what.task === undefined ? api.setGoalStatus(what.goal, status) : api.setTaskStatus(what.goal, what.task, status));
      await this.reloadGoals();
    } catch (error) {
      this.notice(error);
    }
  }

  private async reloadGoals(): Promise<void> {
    const [goals, archived] = await Promise.all([api.goals(), api.archived()]);
    this.set({ goals, archived });
  }

  /** The archive, read when its list is opened. */
  async loadArchived(): Promise<void> {
    this.set({ archived: await api.archived() });
  }

  /** Standard mode's New goal: made on the server, then listed. */
  async createGoal(title: string): Promise<GoalView> {
    const goal = await api.createGoal(title);
    this.set({ goals: await api.goals() });
    return goal;
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
