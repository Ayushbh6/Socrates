import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { reapLeftovers } from "./process-registry";
import { commandEnvironment, TerminalSupervisor, type SupervisorOptions } from "./terminals";

const SavedTab = z.object({
  id: z.string().regex(/^term-\d+$/), root: z.string(), startedAt: z.string().datetime(),
  spec: z.object({
    command: z.string(), shell: z.string().optional(), cwd: z.string(), cwdRel: z.string(),
    timeoutMs: z.number().nullable(), background: z.boolean(), name: z.string().nullable(),
    ready: z.object({ pattern: z.string().nullable(), port: z.number().nullable(), timeoutMs: z.number() }).nullable(),
    pty: z.object({ cols: z.number(), rows: z.number() }).nullable().optional(), origin: z.string().nullable().optional(),
  }),
});

/** Host-owned sessions. Model rebuilds borrow this manager; only host shutdown closes it. */
export class TerminalManager {
  private readonly supervisors = new Map<string, TerminalSupervisor>();
  private restoring = false;
  private closing: Promise<void> | null = null;
  constructor(private readonly options: SupervisorOptions = {}, private readonly file?: string, private readonly log: (text: string) => void = () => {}) {
    if (options.registry) {
      const stopped = reapLeftovers(options.registry);
      if (stopped) log(`Stopped ${stopped} terminal process group(s) left by the previous server.`);
    }
    if (file && existsSync(file)) {
      this.restoring = true;
      try {
        const tabs = z.array(SavedTab).parse(JSON.parse(readFileSync(file, "utf8")));
        const seen = new Set<string>();
        for (const tab of tabs) {
          if (seen.has(tab.id)) continue;
          seen.add(tab.id);
          this.forWorkspace(tab.root).restore(tab.id, { ...tab.spec, env: commandEnvironment() }, tab.startedAt);
        }
      } catch { log("Saved terminal tabs could not be restored."); }
      finally { this.restoring = false; }
    }
  }
  forWorkspace(root: string): TerminalSupervisor {
    let supervisor = this.supervisors.get(root);
    if (!supervisor) {
      supervisor = new TerminalSupervisor({ ...this.options, ...(this.file ? { recentExited: Number.POSITIVE_INFINITY, retainTabs: true } : {}), onChange: () => this.save() });
      this.supervisors.set(root, supervisor);
    }
    return supervisor;
  }
  sessions() {
    return [...this.supervisors.entries()].flatMap(([root, supervisor]) => supervisor.list().map(session => ({ root, supervisor, session })));
  }
  save(): void {
    if (!this.file || this.restoring) return;
    // Environment variables and output are deliberately not persisted. Restarts get a fresh, filtered environment.
    const tabs = this.sessions().map(({ root, session }) => {
      const { env: _env, ...spec } = session.spec;
      return { id: session.id, root, startedAt: session.startedAt.toISOString(), spec };
    });
    try {
      writeFileSync(`${this.file}.tmp`, JSON.stringify(tabs), { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
    } catch { this.log("Terminal tabs could not be saved."); }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      try { await Promise.all([...this.supervisors.values()].map(s => s.shutdown())); }
      finally { this.save(); this.supervisors.clear(); }
    })();
    return this.closing;
  }
}
