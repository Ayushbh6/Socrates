import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { type LaneState, Socrates, interruptUnfinishedTurns } from "@socrates/agent";
import { InstalledCatalog } from "@socrates/capabilities";
import { type CallRecord, type Effort, type EmbeddingClient, type ModelClient, ModelError } from "@socrates/contracts";
import { type EffortLevels, type ListedModel, PROVIDER_DEFAULTS, type Price, type Provider, costOf, detectEfforts, detectVision, listModels, listPrice, makeEmbedder, makeModel, reportedCost, splitModelId, withRecording } from "@socrates/providers";
import { Retrieval } from "@socrates/retrieval";
import { abortable, type Clock, newId } from "@socrates/shared";
import { CallLog, type Goal, LedgerStore, type Turn, type Workspace } from "@socrates/store";
import { type AccessPolicy, canReadAutomatically } from "@socrates/tools";
import { type ServerConfig, prepareHome } from "./config";
import { readKeys, writeKey } from "./keys";
import { lockHome } from "./home-lock";
import { Settings, SettingsPatch, loadSettings, saveSettings } from "./settings";
import { DEFAULT_TITLER, nameChat } from "./titles";
import { workspaceFolder } from "./views";

/** The order in which a chat provider is picked when none is chosen: the first with a key. */
const DETECTION_ORDER: Provider[] = ["anthropic", "openai", "gemini", "openrouter", "deepseek"];

export interface ModelInUse {
  provider: string;
  model: string;
  /** "settings" when chosen; "detected" when picked from the keys present. */
  source: "settings" | "detected";
  /** Whether the model can see images (agent-harness.md, "Images"). */
  vision?: boolean;
  /**
   * The chat model's thinking levels (agent-harness.md, "Thinking levels"):
   * those it accepts, Socrates' default, and the one in use now.
   */
  effort?: EffortLevels & { current: Effort | null };
}

/** How long the call log keeps a call (architecture/observability.md, "Keeping and forgetting"). */
export const CALL_RETENTION_DAYS = 30;

/** Replaceable for tests; production uses the real providers. */
export interface RuntimeDeps {
  makeModel?: (provider: string, model: string, env: Record<string, string | undefined>, options?: { vision?: boolean }) => ModelClient;
  /** Whether a model can see images; production asks the provider's model list where it can. */
  detectVision?: (provider: string, model: string, env: Record<string, string | undefined>) => Promise<boolean>;
  /** A provider's chat models; production asks the provider. */
  listModels?: (provider: string, env: Record<string, string | undefined>) => Promise<ListedModel[]>;
  /** The thinking levels a model accepts; production asks the provider's model list. */
  detectEfforts?: (provider: string, model: string, env: Record<string, string | undefined>) => Promise<EffortLevels>;
  makeEmbedder?: (env: Record<string, string | undefined>) => EmbeddingClient;
  /** A model's list price; production reads OpenRouter's public list. */
  listPrice?: (provider: string, model: string, env: Record<string, string | undefined>) => Promise<Price | null>;
  clock?: Clock;
  /** The process environment; keys in the data folder override it. */
  env?: Record<string, string | undefined>;
  embeddingProbeTimeoutMs?: number;
  /** Allows startup services to be stopped before the HTTP listener exists. */
  signal?: AbortSignal;
  /** Diagnostics; production appends to the data folder's log. */
  log?: (message: string) => void;
}

/** Settings or keys cannot change while Socrates is working. */
export class RuntimeBusyError extends Error {
  override name = "RuntimeBusyError";
}

/**
 * The one running Socrates and everything it is built from (architecture/
 * server.md, "Startup"). It opens the ledger, interrupts turns a stopped
 * process left running, and builds Socrates from the settings and keys.
 * Missing pieces never stop it: without a usable chat model it reports what
 * setup is needed and takes no messages; without embeddings, memory search is
 * keyword only.
 */
export class Runtime {
  socrates: Socrates | null = null;
  settings: Settings;
  /** What the user must still do before Socrates takes messages. */
  setup: string[] = [];
  /** `compactor` is null when compaction uses the chat model; `titler` names standard-mode chats. */
  models: { chat: ModelInUse | null; router: ModelInUse | null; compactor: ModelInUse | null; titler: ModelInUse | null } = { chat: null, router: null, compactor: null, titler: null };
  /** The model that names standard-mode chats; null when it could not start (chats keep their first words). */
  private titler: ModelClient | null = null;
  embeddings: { state: "ready" | "unavailable"; detail: string | null } = { state: "unavailable", detail: null };
  private retrieval: Retrieval | null = null;
  private catalog: InstalledCatalog | null = null;
  private changing = false;
  private changePending: Promise<unknown> | null = null;
  private closing: Promise<void> | null = null;
  private readonly changeListeners = new Set<() => void>();
  /** Calls whose price is still being looked up before they are saved. */
  private readonly savingCalls = new Set<Promise<void>>();
  private readonly prices = new Map<string, { at: number; price: Promise<Price | null> }>();
  /** Socrates' own data and Socrates 0.1's: no tool reads or changes them in any mode. */
  private readonly protectedFolders: string[];

  private constructor(
    readonly config: ServerConfig,
    readonly store: LedgerStore,
    /** Every model call; null when its file could not be opened (Socrates works without it). */
    readonly calls: CallLog | null,
    /** Turns found unfinished at startup and interrupted. */
    readonly recovered: number,
    private readonly deps: RuntimeDeps,
    readonly log: (message: string) => void,
    private readonly unlock: () => void,
    settings: Settings,
  ) {
    this.settings = settings;
    this.protectedFolders = [realpathSync(config.home), path.join(realpathSync(homedir()), ".socrates")];
  }

  static async open(config: ServerConfig, deps: RuntimeDeps = {}): Promise<Runtime> {
    deps.signal?.throwIfAborted();
    prepareHome(config);
    const unlock = lockHome(config.home);
    let store: LedgerStore | undefined;
    let runtime: Runtime | undefined;
    try {
      // Invalid settings never interrupt existing turns or reset their notes.
      const settings = loadSettings(config.settingsPath);
      const sink = deps.log ?? fileLog(config.logPath);
      const secrets = new Set<string>();
      const capture = () => {
        for (const [name, value] of Object.entries({ ...(deps.env ?? process.env), ...readKeys(config.keysPath) })) if (value && /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) secrets.add(value);
      };
      capture();
      const log = (line: string) => {
        // Diagnostics must still redact known secrets if the key file or
        // log destination becomes unreadable during a run.
        try { capture(); } catch {}
        try { sink(redact(line, Object.fromEntries([...secrets].map((value, i) => [`SECRET_${i}`, value])))); } catch {}
      };
      store = LedgerStore.open({ path: config.dbPath, ...(deps.clock ? { clock: deps.clock } : {}) });
      const recovered = interruptUnfinishedTurns(store).length;
      if (recovered) log(`interrupted ${recovered} turn(s) left running when Socrates last stopped`);
      let calls: CallLog | null = null;
      try {
        calls = CallLog.open(config.callsPath);
        const forgotten = calls.prune(new Date((deps.clock?.now() ?? new Date()).getTime() - CALL_RETENTION_DAYS * 86_400_000).toISOString());
        if (forgotten) log(`forgot ${forgotten} model call(s) older than ${CALL_RETENTION_DAYS} days`);
      } catch (error) {
        log(`the call log is unavailable: ${message(error)}`);
        calls?.close();
        calls = null;
      }
      runtime = new Runtime(config, store, calls, recovered, deps, log, unlock, settings);
      await runtime.start();
      return runtime;
    } catch (error) {
      if (runtime) await runtime.close();
      else {
        store?.close();
        unlock();
      }
      throw error;
    }
  }

  get timeZone(): string {
    return this.settings.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** True while work, a configuration rebuild, or shutdown owns the runtime. */
  busy(): boolean {
    return this.changing || this.closing !== null || !!this.socrates && (this.socrates.busy || this.socrates.lanes().some((l) => l.running));
  }

  /** Work may start only after a rebuild finishes and before shutdown begins. */
  get acceptingMessages(): boolean {
    return !this.changing && this.closing === null;
  }

  /** Settings and keys change outside the ledger; live pages must see those changes too. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private announceChange(): void {
    for (const listener of this.changeListeners) {
      try { listener(); } catch (error) { this.log(`runtime listener failed: ${message(error)}`); }
    }
  }

  lanes(): LaneState[] {
    return this.socrates?.lanes() ?? this.store.listLanes().map((lane) => ({ ...lane, running: false, waitingForApproval: false }));
  }

  /** The folder new work is bound to, when it still exists. */
  workingFolder(): Workspace | null {
    const id = this.settings.workingFolder;
    const workspace = id ? this.store.getWorkspace(id) : null;
    if (!workspace?.rootPath) return null;
    try {
      return workspaceFolder(workspace.rootPath, this.config.home) === workspace.rootPath ? workspace : null;
    } catch {
      return null;
    }
  }

  async embeddingStatus(): Promise<{ documents: number } | null> {
    const retrieval = this.retrieval;
    if (!retrieval) return null;
    try {
      const status = await retrieval.status();
      return retrieval === this.retrieval ? { documents: status.documents } : null;
    } catch (error) {
      if (retrieval !== this.retrieval) return null;
      throw error;
    }
  }

  /**
   * Where tools may work and when they ask (architecture/server.md, "Access").
   * Read before every tool call, so a change applies to the next one.
   */
  accessPolicy(): AccessPolicy {
    const { scope, folders, approvals } = this.settings.access;
    const valid = folders.filter(folder => {
      try { return statSync(folder).isDirectory() && realpathSync(folder) === folder; }
      catch { return false; }
    });
    return { folders: scope === "full" ? null : valid, approvals, protected: this.protectedFolders };
  }

  /**
   * The models a provider offers for chat, from its own list (OpenRouter's
   * needs no key). A provider that cannot be asked is a SettingsError whose
   * message never carries a key.
   */
  async providerModels(provider: string): Promise<ListedModel[]> {
    if (!Object.hasOwn(PROVIDER_DEFAULTS, provider)) throw new SettingsError(`Unknown provider "${provider}".`);
    const env = this.env();
    const keys = PROVIDER_DEFAULTS[provider as Provider].keys;
    if (provider !== "openrouter" && !keys.some((k) => env[k])) throw new SettingsError(`Add ${keys[0]} to list its models.`);
    try {
      return await (this.deps.listModels ?? listModels)(provider, env);
    } catch (error) {
      throw new SettingsError(redact(`Could not list ${provider}'s models: ${message(error)}`, env));
    }
  }

  /** The chat model's thinking level now: the user's choice when the model accepts it, else Socrates' default; null leaves it to the provider. */
  effortInUse(): Effort | null {
    const efforts = this.models.chat?.effort;
    if (!efforts?.levels.length) return null;
    const chosen = this.settings.chat?.effort;
    return chosen && efforts.levels.includes(chosen) ? chosen : efforts.default;
  }

  /** Apply a settings change and rebuild Socrates from it; a change of access or of the running chat model's thinking level applies at once. */
  async updateSettings(patch: unknown): Promise<Settings> {
    // Only the fields sent change; the patch schema's defaults must not reset the others.
    const parsed = SettingsPatch.parse(patch) as Record<string, unknown>;
    const sent = Object.fromEntries(Object.keys(patch as object).map((key) => [key, parsed[key]]));
    if (sent.access) sent.access = { ...this.settings.access, ...(sent.access as object) };
    if (sent.profile) sent.profile = { ...this.settings.profile, ...(sent.profile as object) };
    let next = Settings.parse({ ...this.settings, ...sent });
    if ((parsed.access as { folders?: unknown } | undefined)?.folders) {
      next.access.folders = [...new Set(next.access.folders.map((folder) => workspaceFolder(folder, this.config.home)))];
    }
    if (Object.hasOwn(sent, "workingFolder") && next.workingFolder) {
      const workspace = this.store.getWorkspace(next.workingFolder);
      if (!workspace) throw new SettingsError("That workspace does not exist.");
      if (!workspace.rootPath || workspaceFolder(workspace.rootPath, this.config.home) !== workspace.rootPath) throw new SettingsError("That workspace folder is no longer available. Add the folder again.");
      // Choosing the working folder lets Socrates work there.
      if (!next.access.folders.includes(workspace.rootPath)) next.access.folders = [...next.access.folders, workspace.rootPath];
    }
    next = Settings.parse(next);
    // The chat model already running, perhaps with another thinking level: no rebuild.
    const inUse = this.models.chat;
    const sameChat = !!this.socrates && !!next.chat && !!inUse && next.chat.provider === inUse.provider && next.chat.model === inUse.model;
    if (Object.keys(sent).every((key) => key === "access" || key === "profile" || key === "prices" || (key === "chat" && sameChat))) {
      const effort = next.chat?.effort;
      if (sameChat && effort && !inUse!.effort?.levels.includes(effort)) {
        const levels = inUse!.effort?.levels ?? [];
        throw new SettingsError(levels.length ? `${inUse!.model} cannot think at "${effort}"; choose ${levels.join(", ")}.` : `${inUse!.model} has no thinking levels to choose from.`);
      }
      // Access, the profile and thinking levels need no rebuild, so they may change while Socrates works; access and thinking levels apply to the next tool call or model request.
      if (this.changing || this.closing) throw new RuntimeBusyError("Socrates is restarting; change this in a moment.");
      saveSettings(this.config.settingsPath, next);
      this.settings = next;
      if (sameChat) this.models.chat = { ...inUse!, source: "settings", ...(inUse!.effort ? { effort: { ...inUse!.effort, current: this.effortInUse() } } : {}) };
      this.retrieval?.scheduleSync();
      this.announceChange();
      return next;
    }
    return this.change(async () => {
      saveSettings(this.config.settingsPath, next);
      this.settings = next;
      await this.restart();
      return next;
    });
  }

  /** Set or remove one API key and rebuild Socrates with it. */
  /**
   * The goal that holds standard mode's chats outside any goal, shown as
   * "Chats" (architecture/web.md, "Standard mode"). An ordinary goal, so flow
   * mode can continue its chats; made on first use and remembered in the data folder.
   */
  chatsGoal(): Goal {
    const file = path.join(this.config.home, "standard.json");
    let number: number | null = null;
    try { number = (JSON.parse(readFileSync(file, "utf8")) as { chatsGoal?: number }).chatsGoal ?? null; } catch {}
    const known = number ? this.store.getGoalByNumber(number) : null;
    if (known && !known.general) return known;
    const goal = this.store.createGoal({ title: "Chats", objective: "Chats started in standard mode outside any goal." });
    writeFileSync(file, `${JSON.stringify({ chatsGoal: goal.number })}\n`);
    return goal;
  }

  /** The number of the Chats goal, or null before the first chat outside a goal. */
  chatsGoalNumber(): number | null {
    try {
      const number = (JSON.parse(readFileSync(path.join(this.config.home, "standard.json"), "utf8")) as { chatsGoal?: number }).chatsGoal ?? null;
      return number && this.store.getGoalByNumber(number) ? number : null;
    } catch { return null; }
  }

  /**
   * Name a new standard-mode chat from its first question and answer, in the
   * background. The chat keeps its first words when naming fails or the user
   * renamed it meanwhile.
   */
  nameChat(turn: Turn, answer: string): void {
    const model = this.titler;
    if (!model || !turn.taskId || !turn.goalId || this.store.titleSetByUser(turn.taskId)) return;
    const before = this.store.requireTask(turn.taskId).title;
    const asked = (this.store.getEvent(turn.userEventId)?.payload as { text?: string } | undefined)?.text ?? "";
    // OpenRouter models are asked not to think: a name needs no reasoning, and thinking only slows it and invites copying.
    void nameChat(model, { message: asked, answer, ...(this.models.titler?.provider === "openrouter" ? { effort: "off" as const } : {}), trace: { goalId: turn.goalId, taskId: turn.taskId, turnId: turn.id, userEventId: turn.userEventId } })
      .then((title) => {
        const task = this.store.getTask(turn.taskId!);
        // A name the user chose, or one that changed meanwhile, is never replaced.
        if (title && task && task.title === before && title !== before && !this.store.titleSetByUser(task.id)) this.store.reviseTask(task.id, { title });
      })
      .catch((error) => this.log(`naming a chat failed: ${message(error)}`));
  }

  async setKey(name: string, value: string | null): Promise<void> {
    await this.change(async () => {
      writeKey(this.config.keysPath, name, value);
      await this.restart();
    });
  }

  keyNames(): Set<string> {
    const env = this.env();
    return new Set(Object.keys(env).filter((name) => env[name]));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.changePending?.catch(() => {});
      try {
        await this.stop();
      } finally {
        await this.flushCalls();
        try { this.calls?.close(); } catch {}
        try { this.store.close(); } finally { this.unlock(); }
      }
    })();
    this.announceChange();
    return this.closing;
  }

  private assertIdle(): void {
    if (this.busy()) throw new RuntimeBusyError("Socrates is working; change settings when it is idle.");
  }

  /** Claim synchronously, before the first await, including the rebuild itself. */
  private async change<T>(work: () => Promise<T>): Promise<T> {
    this.assertIdle();
    this.changing = true;
    this.announceChange();
    try {
      const pending = work();
      this.changePending = pending;
      return await pending;
    } finally {
      this.changePending = null;
      this.changing = false;
      this.announceChange();
    }
  }

  private async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** The environment models and MCP servers see: the data folder's keys over the process's. */
  private env(): Record<string, string | undefined> {
    return { ...(this.deps.env ?? process.env), ...readKeys(this.config.keysPath) };
  }

  private async start(): Promise<void> {
    const env = this.env();
    this.setup = [];
    try {
      this.catalog = await InstalledCatalog.open({ store: this.store, home: this.config.home, env, log: this.log }, this.deps.signal);
    } catch (error) {
      this.deps.signal?.throwIfAborted();
      this.catalog = null;
      this.log(`capabilities unavailable: ${message(error)}`);
    }
    await this.openEmbeddings(env);
    this.deps.signal?.throwIfAborted();

    const chat = this.chatChoice(env);
    if (!chat) {
      this.models = { chat: null, router: null, compactor: null, titler: null };
      this.titler = null;
      this.setup.push(`Add an API key (${DETECTION_ORDER.map((p) => PROVIDER_DEFAULTS[p].keys[0]).join(", ")}) or choose a chat model.`);
      return;
    }
    const router: ModelInUse = this.settings.router
      ? { ...this.settings.router, source: "settings" }
      : { provider: chat.provider, model: PROVIDER_DEFAULTS[chat.provider as Provider].router, source: chat.source };
    // Only the chat model reads files and attachments, so only it needs to know whether it can see; the router keeps its own thinking level.
    const [vision, efforts] = await Promise.all([
      (this.deps.detectVision ?? detectVision)(chat.provider, chat.model, env),
      (this.deps.detectEfforts ?? detectEfforts)(chat.provider, chat.model, env),
    ]);
    this.deps.signal?.throwIfAborted();
    const compactor: ModelInUse | null = this.settings.compactor ? { ...this.settings.compactor, source: "settings" } : null;
    const titler: ModelInUse = this.settings.titler
      ? { ...this.settings.titler, source: "settings" }
      : PROVIDER_DEFAULTS.openrouter.keys.some((k) => env[k]) ? { ...DEFAULT_TITLER, source: "detected" } : router;
    this.models = { chat: { ...chat, vision, ...(efforts.levels.length ? { effort: { ...efforts, current: null } } : {}) }, router, compactor, titler };
    if (this.models.chat?.effort) this.models.chat.effort.current = this.effortInUse();
    const build = this.deps.makeModel ?? makeModel;
    let model: ModelClient;
    let routerModel: ModelClient;
    let compactorModel: ModelClient | null = null;
    try {
      // Recording sits inside the thinking level, so a call is saved as it was sent.
      const recorded = (client: ModelClient) => withRecording(client, (call) => this.saveCall(call, env));
      model = withEffort(recorded(build(chat.provider, chat.model, env, { vision })), () => this.effortInUse(), () => this.models.chat?.effort?.maxOutputTokens);
      routerModel = recorded(build(router.provider, router.model, env));
      if (compactor) compactorModel = recorded(build(compactor.provider, compactor.model, env));
      // Naming chats is a nicety: a titler that cannot start leaves chats their first words.
      try { this.titler = recorded(build(titler.provider, titler.model, env)); }
      catch (error) { this.titler = null; this.log(`chat names unavailable: ${redact(message(error), env)}`); }
    } catch (error) {
      this.setup.push(redact(error instanceof ModelError && error.kind === "authentication" ? `${error.message} Add it in settings.` : `The chat model cannot start: ${message(error)}`, env));
      return;
    }
    this.socrates = new Socrates({
      store: this.store,
      model,
      routerModel,
      ...(compactorModel ? { compactorModel } : {}),
      timeZone: this.timeZone,
      // Every approval comes from the message that asked (architecture/server.md, "Approvals").
      approve: async () => false,
      access: () => this.accessPolicy(),
      profile: () => this.settings.profile,
      resolveWorkspace: () => {
        const folder = this.workingFolder();
        return folder ? { name: folder.name, rootPath: folder.rootPath! } : null;
      },
      ...(this.catalog ? { catalog: this.catalog } : {}),
      ...(this.retrieval ? { semantic: this.retrieval } : {}),
      attachments: this.config.attachmentsDir,
      // Terminal process groups are listed here, so ones a crash leaves running are stopped at the next start.
      terminals: { registry: path.join(this.config.home, "terminals.json") },
      log: this.log,
    });
  }

  private async openEmbeddings(env: Record<string, string | undefined>): Promise<void> {
    const e = this.settings.embeddings;
    try {
      const client = (this.deps.makeEmbedder ?? makeEmbedder)({
        ...env,
        SOCRATES_EMBEDDINGS_PROVIDER: e.provider,
        SOCRATES_EMBEDDINGS_MODEL: e.model ?? undefined,
        SOCRATES_EMBEDDINGS_URL: e.url ?? undefined,
      });
      // Opening a vector table says nothing about whether its provider works.
      const embedder: EmbeddingClient = {
        id: client.id,
        embed: async (texts, purpose, signal) => {
          const startedAt = new Date();
          const t0 = performance.now();
          try {
            const vectors = await client.embed(texts, purpose, signal);
            signal?.throwIfAborted();
            this.embeddings = { state: "ready", detail: null };
            this.saveEmbedding(client.id, purpose, texts, startedAt, performance.now() - t0, vectors[0]?.length ?? 0, null, env);
            return vectors;
          } catch (error) {
            if (!signal?.aborted) this.embeddings = { state: "unavailable", detail: `${redact(message(error), env)} Memory search uses keywords only.` };
            this.saveEmbedding(client.id, purpose, texts, startedAt, performance.now() - t0, 0, error, env);
            throw error;
          }
        },
      };
      const signal = AbortSignal.any([AbortSignal.timeout(this.deps.embeddingProbeTimeoutMs ?? 3_000), ...(this.deps.signal ? [this.deps.signal] : [])]);
      const vectors = await abortable(embedder.embed(["Socrates memory search"], "query", signal), signal);
      if (vectors.length !== 1 || !vectors[0]?.length || !vectors[0].every(Number.isFinite)) throw new Error("The embedding provider returned an invalid vector.");
      this.retrieval = await Retrieval.open({ store: this.store, embedder, uri: this.config.indexPath, capabilities: () => this.catalog?.entries() ?? [], fileAllowed: abs => canReadAutomatically(this.accessPolicy(), abs), log: this.log });
      this.embeddings = { state: "ready", detail: null };
    } catch (error) {
      this.deps.signal?.throwIfAborted();
      this.retrieval = null;
      this.embeddings = { state: "unavailable", detail: `${redact(message(error), env)} Memory search uses keywords only.` };
      this.log(`embeddings unavailable: ${message(error)}`);
    }
  }

  /**
   * Save a finished call with its price (architecture/observability.md,
   * "Cost"): what the provider reported, else the user's price for the model,
   * else its list price. Saving waits for a price lookup, so it never delays
   * the call; a failure to save never reaches it.
   */
  private saveCall(call: CallRecord, env: Record<string, string | undefined>): void {
    const calls = this.calls;
    if (!calls) return;
    const saving: Promise<void> = (async () => {
      let saved = call;
      try {
        if (call.response) {
          const reported = reportedCost(call.response.meta);
          const price = reported === null ? this.settings.prices[call.model] ?? (await this.priceOf(call.model, env)) : null;
          const cost = reported !== null ? { usd: reported, source: "reported" as const } : price ? { usd: costOf(call.response.usage, price), source: "price" as const } : null;
          saved = { ...call, cost };
        }
      } catch {}
      try { calls.record(saved); } catch (error) { this.log(`could not save a model call: ${message(error)}`); }
    })().finally(() => this.savingCalls.delete(saving));
    this.savingCalls.add(saving);
  }

  /** The price in force for each model that has made calls: the user's own, else its list price, else none. */
  async priceTable(): Promise<{ model: string; source: "settings" | "list" | null; price: Price | null }[]> {
    const env = this.env();
    const models = [...new Set((this.calls?.breakdown() ?? []).filter((r) => r.role !== "embedding").map((r) => r.model))];
    return Promise.all(models.map(async (model) => {
      const own = this.settings.prices[model];
      if (own) return { model, source: "settings" as const, price: own };
      const listed = await this.priceOf(model, env);
      return { model, source: listed ? ("list" as const) : null, price: listed };
    }));
  }

  /** Every call made so far is saved (tests and shutdown wait for it). */
  async flushCalls(): Promise<void> {
    while (this.savingCalls.size) await Promise.allSettled([...this.savingCalls]);
  }

  /** A model's list price, looked up once an hour (a miss is tried again after a minute). */
  private priceOf(id: string, env: Record<string, string | undefined>): Promise<Price | null> {
    const known = this.prices.get(id);
    if (known && Date.now() - known.at < 3_600_000) return known.price;
    const [provider, model] = splitModelId(id);
    const price = (this.deps.listPrice ?? listPrice)(provider, model, env).catch(() => null);
    this.prices.set(id, { at: Date.now(), price });
    void price.then((found) => { if (!found) setTimeout(() => { if (this.prices.get(id)?.price === price) this.prices.delete(id); }, 60_000).unref(); });
    return price;
  }

  /** Embedding calls are logged too, without tokens: what was embedded, how long it took and whether it worked. */
  private saveEmbedding(model: string, purpose: string, texts: string[], startedAt: Date, ms: number, dimensions: number, error: unknown, env: Record<string, string | undefined>): void {
    const preview = texts.slice(0, 5).map((t) => (t.length > 300 ? `${t.slice(0, 300)}…` : t)).join("\n---\n");
    this.saveCall({
      id: newId("call"), startedAt: startedAt.toISOString(), model, servedBy: null, trace: { role: "embedding" }, streamed: false,
      request: { system: purpose, messages: [{ role: "user", content: `${texts.length} text${texts.length === 1 ? "" : "s"}\n${preview}` }], tools: [], toolChoice: "auto", maxOutputTokens: null, temperature: null, effort: null },
      response: error ? null : { text: "", toolCalls: [], reasoning: null, stopReason: "end", usage: { promptTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, meta: { texts: texts.length, dimensions } },
      error: error ? { kind: error instanceof ModelError ? error.kind : "unexpected", status: error instanceof ModelError ? error.status ?? null : null, message: redact(message(error), env) } : null,
      ms: Math.round(ms), firstTokenMs: null, tokensPerSecond: null, cost: null,
    }, env);
  }

  private chatChoice(env: Record<string, string | undefined>): ModelInUse | null {
    if (this.settings.chat) return { provider: this.settings.chat.provider, model: this.settings.chat.model, source: "settings" };
    const provider = DETECTION_ORDER.find((p) => PROVIDER_DEFAULTS[p].keys.some((k) => env[k]));
    return provider ? { provider, model: PROVIDER_DEFAULTS[provider].main, source: "detected" } : null;
  }

  /** Socrates closes its catalog and index; without Socrates they are closed here. */
  private async stop(): Promise<void> {
    const { socrates, catalog, retrieval } = this;
    this.socrates = null;
    this.catalog = null;
    this.retrieval = null;
    // Close all services even if one shutdown fails. Socrates' closes are
    // idempotent; the fallback also covers partial startup or runner failure.
    const outcomes = await Promise.allSettled([
      (async () => { try { await socrates?.close(); } finally { await catalog?.close(); } })(),
      retrieval?.close(),
    ]);
    const failed = outcomes.find((r) => r.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

/**
 * Room to reply at the higher thinking levels: thinking counts toward a
 * reply's output tokens, so at "max" a model can spend 16,000 tokens before it
 * writes a word. Only streamed requests (the working agent's) get it, and
 * never more than the model's own limit.
 */
const OUTPUT_FOR_EFFORT: Partial<Record<Effort, number>> = { high: 32_000, xhigh: 64_000, max: 64_000 };

/** The chat model asked at the thinking level in use when each request is sent, so a new level applies to the next request. */
function withEffort(model: ModelClient, effort: () => Effort | null, maxOutputTokens: () => number | undefined): ModelClient {
  return {
    id: model.id,
    ...(model.vision !== undefined ? { vision: model.vision } : {}),
    complete: (request) => {
      const level = request.effort ?? effort();
      if (!level) return model.complete(request);
      const room = OUTPUT_FOR_EFFORT[level];
      const limit = maxOutputTokens();
      const output = request.onText && room && limit ? Math.min(limit, Math.max(room, request.maxOutputTokens ?? 0)) : undefined;
      return model.complete({ ...request, effort: level, ...(output ? { maxOutputTokens: output } : {}) });
    },
  };
}

export class SettingsError extends Error {
  override name = "SettingsError";
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function redact(line: string, env: Record<string, string | undefined>): string {
  const secrets = Object.entries(env).flatMap(([name, value]) => value && /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) ? [value] : []).sort((a, b) => b.length - a.length);
  for (const value of secrets) line = line.replaceAll(value, "[redacted]");
  return line.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@");
}

/** Appends timestamped lines to the data folder's log, keeping one previous log of up to 5 MB. */
export function fileLog(file: string): (message: string) => void {
  return (line) => {
    try {
      const record = `${new Date().toISOString()} ${line.slice(0, 32_768)}\n`;
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(record) > 5 * 1024 * 1024) renameSync(file, `${file}.1`);
      appendFileSync(file, record, { mode: 0o600 });
    } catch {}
  };
}
