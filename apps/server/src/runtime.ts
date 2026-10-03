import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { type LaneState, Socrates, interruptUnfinishedTurns } from "@socrates/agent";
import { InstalledCatalog } from "@socrates/capabilities";
import { type EmbeddingClient, type ModelClient, ModelError } from "@socrates/contracts";
import { PROVIDER_DEFAULTS, type Provider, makeEmbedder, makeModel } from "@socrates/providers";
import { Retrieval } from "@socrates/retrieval";
import type { Clock } from "@socrates/shared";
import { LedgerStore, type Workspace } from "@socrates/store";
import { type ServerConfig, prepareHome } from "./config";
import { readKeys, writeKey } from "./keys";
import { Settings, SettingsPatch, loadSettings, saveSettings } from "./settings";

/** The order in which a chat provider is picked when none is chosen: the first with a key. */
const DETECTION_ORDER: Provider[] = ["anthropic", "openai", "gemini", "openrouter", "deepseek"];

export interface ModelInUse {
  provider: string;
  model: string;
  /** "settings" when chosen; "detected" when picked from the keys present. */
  source: "settings" | "detected";
}

/** Replaceable for tests; production uses the real providers. */
export interface RuntimeDeps {
  makeModel?: (provider: string, model: string, env: Record<string, string | undefined>) => ModelClient;
  makeEmbedder?: (env: Record<string, string | undefined>) => EmbeddingClient;
  clock?: Clock;
  /** The process environment; keys in the data folder override it. */
  env?: Record<string, string | undefined>;
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
  models: { chat: ModelInUse | null; router: ModelInUse | null } = { chat: null, router: null };
  embeddings: { state: "ready" | "unavailable"; detail: string | null } = { state: "unavailable", detail: null };
  private retrieval: Retrieval | null = null;
  private catalog: InstalledCatalog | null = null;

  private constructor(
    readonly config: ServerConfig,
    readonly store: LedgerStore,
    /** Turns found unfinished at startup and interrupted. */
    readonly recovered: number,
    private readonly deps: RuntimeDeps,
    readonly log: (message: string) => void,
  ) {
    this.settings = loadSettings(config.settingsPath);
  }

  static async open(config: ServerConfig, deps: RuntimeDeps = {}): Promise<Runtime> {
    prepareHome(config);
    const log = deps.log ?? fileLog(config.logPath);
    const store = LedgerStore.open({ path: config.dbPath, ...(deps.clock ? { clock: deps.clock } : {}) });
    let runtime: Runtime;
    try {
      const recovered = interruptUnfinishedTurns(store).length;
      if (recovered) log(`interrupted ${recovered} turn(s) left running when Socrates last stopped`);
      runtime = new Runtime(config, store, recovered, deps, log);
    } catch (error) {
      store.close();
      throw error;
    }
    await runtime.start();
    return runtime;
  }

  get timeZone(): string {
    return this.settings.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** True while the main conversation or any lane is working. */
  busy(): boolean {
    return !!this.socrates && (this.socrates.busy || this.socrates.lanes().some((l) => l.running));
  }

  lanes(): LaneState[] {
    return this.socrates?.lanes() ?? this.store.listLanes().map((lane) => ({ ...lane, running: false, waitingForApproval: false }));
  }

  /** The folder new work is bound to, when it still exists. */
  workingFolder(): Workspace | null {
    const id = this.settings.workingFolder;
    const workspace = id ? this.store.getWorkspace(id) : null;
    return workspace?.rootPath && existsSync(workspace.rootPath) ? workspace : null;
  }

  async embeddingStatus(): Promise<{ documents: number } | null> {
    return this.retrieval ? { documents: (await this.retrieval.status()).documents } : null;
  }

  /** Apply a settings change and rebuild Socrates from it. */
  async updateSettings(patch: unknown): Promise<Settings> {
    // Only the fields sent change; the patch schema's defaults must not reset the others.
    const parsed = SettingsPatch.parse(patch) as Record<string, unknown>;
    const sent = Object.fromEntries(Object.keys(patch as object).map((key) => [key, parsed[key]]));
    const next = Settings.parse({ ...this.settings, ...sent });
    if (next.workingFolder && !this.store.getWorkspace(next.workingFolder)) throw new SettingsError("That workspace does not exist.");
    this.assertIdle();
    saveSettings(this.config.settingsPath, next);
    this.settings = next;
    await this.restart();
    return next;
  }

  /** Set or remove one API key and rebuild Socrates with it. */
  async setKey(name: string, value: string | null): Promise<void> {
    this.assertIdle();
    writeKey(this.config.keysPath, name, value);
    await this.restart();
  }

  keyNames(): Set<string> {
    return new Set(Object.keys(readKeys(this.config.keysPath)));
  }

  async close(): Promise<void> {
    await this.stop();
    this.store.close();
  }

  private assertIdle(): void {
    if (this.busy()) throw new RuntimeBusyError("Socrates is working; change settings when it is idle.");
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
      this.catalog = await InstalledCatalog.open({ store: this.store, home: this.config.home, env, log: this.log });
    } catch (error) {
      this.catalog = null;
      this.log(`capabilities unavailable: ${message(error)}`);
    }
    await this.openEmbeddings(env);

    const chat = this.chatChoice(env);
    if (!chat) {
      this.models = { chat: null, router: null };
      this.setup.push(`Add an API key (${DETECTION_ORDER.map((p) => PROVIDER_DEFAULTS[p].keys[0]).join(", ")}) or choose a chat model.`);
      return;
    }
    const router: ModelInUse = this.settings.router
      ? { ...this.settings.router, source: "settings" }
      : { provider: chat.provider, model: PROVIDER_DEFAULTS[chat.provider as Provider].router, source: chat.source };
    this.models = { chat, router };
    const build = this.deps.makeModel ?? makeModel;
    let model: ModelClient;
    let routerModel: ModelClient;
    try {
      model = build(chat.provider, chat.model, env);
      routerModel = build(router.provider, router.model, env);
    } catch (error) {
      this.setup.push(error instanceof ModelError && error.kind === "authentication" ? `${error.message} Add it in settings.` : `The chat model cannot start: ${message(error)}`);
      return;
    }
    this.socrates = new Socrates({
      store: this.store,
      model,
      routerModel,
      timeZone: this.timeZone,
      // Every approval comes from the message that asked (architecture/server.md, "Approvals").
      approve: async () => false,
      resolveWorkspace: () => {
        const folder = this.workingFolder();
        return folder ? { name: folder.name, rootPath: folder.rootPath! } : null;
      },
      ...(this.catalog ? { catalog: this.catalog } : {}),
      ...(this.retrieval ? { semantic: this.retrieval } : {}),
      log: this.log,
    });
  }

  private async openEmbeddings(env: Record<string, string | undefined>): Promise<void> {
    const e = this.settings.embeddings;
    try {
      const embedder = (this.deps.makeEmbedder ?? makeEmbedder)({
        ...env,
        SOCRATES_EMBEDDINGS_PROVIDER: e.provider,
        SOCRATES_EMBEDDINGS_MODEL: e.model ?? undefined,
        SOCRATES_EMBEDDINGS_URL: e.url ?? undefined,
      });
      this.retrieval = await Retrieval.open({ store: this.store, embedder, uri: this.config.indexPath, capabilities: () => this.catalog?.entries() ?? [], log: this.log });
      this.embeddings = { state: "ready", detail: null };
    } catch (error) {
      this.retrieval = null;
      this.embeddings = { state: "unavailable", detail: `${message(error)} Memory search uses keywords only.` };
      this.log(`embeddings unavailable: ${message(error)}`);
    }
  }

  private chatChoice(env: Record<string, string | undefined>): ModelInUse | null {
    if (this.settings.chat) return { ...this.settings.chat, source: "settings" };
    const provider = DETECTION_ORDER.find((p) => PROVIDER_DEFAULTS[p].keys.some((k) => env[k]));
    return provider ? { provider, model: PROVIDER_DEFAULTS[provider].main, source: "detected" } : null;
  }

  /** Socrates closes its catalog and index; without Socrates they are closed here. */
  private async stop(): Promise<void> {
    if (this.socrates) await this.socrates.close();
    else {
      await this.catalog?.close();
      await this.retrieval?.close();
    }
    this.socrates = null;
    this.catalog = null;
    this.retrieval = null;
  }
}

export class SettingsError extends Error {
  override name = "SettingsError";
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Appends timestamped lines to the data folder's log, keeping one previous log of up to 5 MB. */
export function fileLog(file: string): (message: string) => void {
  try {
    if (existsSync(file) && statSync(file).size > 5 * 1024 * 1024) renameSync(file, `${file}.1`);
  } catch {}
  return (line) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {}
  };
}

