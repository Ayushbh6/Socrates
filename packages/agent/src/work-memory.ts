import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { callLine } from "@socrates/retrieval";
import { countTokens } from "@socrates/shared";
import { quoteEvidence, type Evidence, type Goal, type LedgerStore, type WorkMemoryEntry } from "@socrates/store";
import { WORK_MEMORY_INDEX_MAX_TOKENS, WORK_TOPIC_MAX_CHARS, type WorkspaceRoot } from "@socrates/tools";
import type { MemorySettings } from "./memory";
export { WORK_MEMORY_INDEX_MAX_TOKENS } from "@socrates/tools";

/**
 * Work memory (agent-harness.md, "Work memory"): how things are done in one
 * project. An index, one line per topic with the turns it came from, shown
 * to the agent in every request of the project (`<WORK_MEMORY>`), and short
 * topics, opened with `context_retrieve inspect topic:<name>`. It is kept by
 * Socrates, never in the user's repository: the ledger holds every write
 * (`work_memory_written`), and Socrates' data folder holds the same index and
 * topics as files, `<data>/memory/projects/<project id>/`. After verified work
 * the decider may say it is worth recording; the agent then writes the notes
 * in a step of its own, after the answer is saved, with a memory-only tool.
 */

/** At or above this chance that a finished turn established something worth writing down, the agent is asked to record it. */
export const WORK_AT = 0.5;
/** The step may make this many model requests. */
export const WORK_FOLLOW_UP_MAX_STEPS = 8;

/** A project, as work memory knows it: an id that stays the same for the same repository or folder. */
export interface WorkProject {
  id: string;
  /** The workspace folder the turn ran in. */
  root: string;
  /** What the id is made from: Git's shared folder for a repository, so its worktrees share memory; else the folder itself. */
  identity: string;
  kind: "git" | "folder";
}

const projects = new Map<string, WorkProject | null>();

/** The project of a workspace folder, or null when the folder cannot be read. Cached per folder. */
export function resolveWorkProject(root: string): WorkProject | null {
  if (projects.has(root)) return projects.get(root)!;
  let project: WorkProject | null = null;
  try {
    const real = realpathSync(root);
    let identity = `folder:${real}`;
    let kind: WorkProject["kind"] = "folder";
    let named = real;
    try {
      const git = (args: string[]) => execFileSync("git", args, { cwd: real, timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      // Only a repository's own top folder is the repository; a folder inside one is a project of its own.
      if (realpathSync(git(["rev-parse", "--show-toplevel"])) === real) {
        const common = realpathSync(path.resolve(real, git(["rev-parse", "--git-common-dir"])));
        identity = `git:${common}`;
        kind = "git";
        // Every worktree is named after the main repository's folder, so all of them get one id.
        named = path.basename(common) === ".git" ? path.dirname(common) : common;
      }
    } catch { /* Not a repository, or no git: the folder is the project. */ }
    const slug = path.basename(named).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "project";
    project = { id: `${slug}-${createHash("sha256").update(identity).digest("hex").slice(0, 10)}`, root: real, identity, kind };
  } catch { /* An unreadable folder has no work memory. */ }
  projects.set(root, project);
  return project;
}

/** The project a turn's work memory belongs to: a goal's own bound folder. The General conversation and a goal without a folder have none. */
export function workMemoryProject(goal: Goal, workspace: WorkspaceRoot | null): WorkProject | null {
  if (goal.general || !goal.workspaceId || !workspace) return null;
  return resolveWorkProject(workspace.root);
}

/**
 * `<WORK_MEMORY>`: the project's index, in the stable first part of the
 * request, so it changes only when the index does. Held to
 * WORK_MEMORY_INDEX_MAX_TOKENS: past it the oldest lines (the index lists the
 * newest first) are left out and a last line says so, so the agent tidies it.
 */
export function workMemoryBlock(store: LedgerStore, project: WorkProject | null, settings: MemorySettings | null | undefined): string | null {
  if (!project || (settings && !settings.use)) return null;
  const index = store.workMemoryIndex(project.id)?.text.trim();
  if (!index) return null;
  const lines = index.split("\n");
  const header = `# PROJECT_MEMORY\nproject_ref: ${project.id}`;
  const shown: string[] = [];
  let used = countTokens(header) + 60;
  for (const line of lines) {
    const name = line.match(/\btopic[: ]+([a-z0-9-]+)/i)?.[1];
    const record = name ? `## TOPIC\ntopic_ref: topic:${name}\ndescription:\n${quoteEvidence(line)}` : `index_note:\n${quoteEvidence(line)}`;
    const cost = countTokens(record) + 2;
    if (used + cost > WORK_MEMORY_INDEX_MAX_TOKENS) break;
    shown.push(record); used += cost;
  }
  const left = lines.length - shown.length;
  if (left > 0) shown.push(`(${left} older line${left === 1 ? "" : "s"} not shown: the index is over its budget of ${WORK_MEMORY_INDEX_MAX_TOKENS} tokens; merge related lines or drop the stalest when you next update it)`);
  return `${header}\n\n${shown.join("\n\n")}`;
}

const CHANGES = new Set(["edit", "apply_patch", "terminal"]);

/**
 * Whether a finished turn verified something worth asking about: at least
 * one change or command that succeeded (an edit or patch that applied, a
 * command that exited 0). A turn whose changes all failed is not asked.
 */
export function didRealWork(calls: Evidence[]): boolean {
  return calls.some((c) => {
    if (!CHANGES.has(c.tool) || c.status !== "ok") return false;
    if (c.tool !== "terminal") return true;
    const result = c.result?.result as { exit_code?: unknown; status?: unknown } | null | undefined;
    return result?.exit_code === 0 && result.status === "completed";
  });
}

const REQUEST_CHARS = 800;
const ANSWER_CHARS = 800;
const CALL_LINES_MAX = 24;
const cut = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/**
 * What the decider reads about a finished turn: the request, the tool calls
 * in order (a failed one marked), and the answer, each cut short. Long runs of
 * calls keep their first and last lines.
 */
export function workState(input: { request: string; calls: Evidence[]; answer: string }): string {
  const lines = input.calls.map((c) => `- ${callLine(c.tool, c.input)}${c.status === "error" ? " ✗" : ""}`);
  const shown = lines.length > CALL_LINES_MAX ? [...lines.slice(0, 10), `- … ${lines.length - CALL_LINES_MAX} more calls`, ...lines.slice(-(CALL_LINES_MAX - 10))] : lines;
  return `The user asked:\n${cut(input.request.trim(), REQUEST_CHARS)}\n\nWhat the assistant did (tool calls, in order):\n${shown.join("\n")}\n\nThe assistant's answer:\n${cut(input.answer.trim(), ANSWER_CHARS)}`;
}

/**
 * The writing guide, given after the answer only when the decider says the
 * work is worth recording (docs/memory.md, M3b): zero cost on every other
 * turn. The step has only the `work_memory` tool and `context_retrieve`.
 */
export function workMemorySkill(turnNumber: number): string {
  return `<WORK_MEMORY_SKILL>
Your answer is saved. The work you just finished looks reusable in this project; record what a later turn should know. Socrates keeps these notes outside the project: use only the work_memory tool, and do not repeat your answer.

1. Decide. Record only what this work verified (its checks passed): a repeatable procedure (the steps of a kind of change that will come up again here) or a lesson (a surprise or mistake, and the fix). Not a one-off edit, not a guess, not what the code or README already says plainly. If nothing qualifies, reply "Nothing to record." and stop.
2. Topic: one per procedure or lesson, a short kebab-case name. work_memory read first: if a topic already covers it, read it and rewrite it with write_topic, do not add a second one. Write a title line; "Steps" (numbered, imperative, naming the files and commands); "Pitfalls" (symptom → fix) when there are any; "Evidence: turns N, M" (this turn is turn ${turnNumber}; add the earlier turns it came from). At most about 300 words (${WORK_TOPIC_MAX_CHARS} characters).
3. Index: write_index with the whole index, one line per topic, newest first: "- <what to do, in a few words> → topic <name> · turns N, M". Keep it under about 40 lines; when it is full, merge related lines or drop the stalest before adding one. No steps in the index.
4. Finish with one short sentence naming the topics you wrote.
</WORK_MEMORY_SKILL>`;
}

/**
 * The project's notes as files in Socrates' data folder: `<dir>/<project
 * id>/MEMORY.md`, `topics/<name>.md` and `project.json`. Written from the
 * ledger after every write and at startup, so they always show what the
 * ledger holds; an edit made to them by hand is replaced on the next write.
 */
export class WorkMemoryFiles {
  constructor(readonly dir: string) {}

  /** Write one entry (and the project's description) after it was recorded. */
  write(project: { id: string; root: string; identity?: string; kind?: string }, entry: WorkMemoryEntry): void {
    const folder = path.join(this.dir, project.id);
    this.save(path.join(folder, "project.json"), `${JSON.stringify({ id: project.id, root: project.root, ...(project.identity ? { identity: project.identity, kind: project.kind } : {}) }, null, 2)}\n`);
    this.save(entry.name === null ? path.join(folder, "MEMORY.md") : path.join(folder, "topics", `${entry.name}.md`), `${entry.text.trim()}\n`);
  }

  /** Every project's index and topics, as the ledger holds them; files that already match are left alone. */
  rebuild(store: LedgerStore): number {
    let written = 0;
    for (const { projectId, root } of store.listWorkMemoryProjects()) {
      const resolved = resolveWorkProject(root);
      const project = resolved?.id === projectId ? resolved : { id: projectId, root };
      for (const entry of [store.workMemoryIndex(projectId), ...store.listWorkTopics(projectId)]) {
        if (!entry) continue;
        const file = entry.name === null ? path.join(this.dir, projectId, "MEMORY.md") : path.join(this.dir, projectId, "topics", `${entry.name}.md`);
        let current: string | null = null;
        try { current = readFileSync(file, "utf8"); } catch {}
        if (current === `${entry.text.trim()}\n`) continue;
        this.write(project, entry);
        written++;
      }
    }
    return written;
  }

  private save(file: string, text: string): void {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }
}

/**
 * Work-memory steps run after their turn, one at a time per project, so two
 * turns of a project never write its notes at once; turns of other projects
 * do not wait. `idle` resolves when every step queued so far has ended.
 */
export class WorkMemorySteps {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();

  schedule(projectId: string, step: () => Promise<void>): void {
    const previous = this.chains.get(projectId) ?? Promise.resolve();
    const next = previous.then(step, step).catch(() => {});
    this.chains.set(projectId, next);
    this.pending.add(next);
    void next.finally(() => {
      this.pending.delete(next);
      if (this.chains.get(projectId) === next) this.chains.delete(projectId);
    });
  }

  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}
