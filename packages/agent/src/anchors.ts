import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { AnchorProposal, type EventPayloads, type EventRefs } from "@socrates/contracts";
import type { Anchor, Goal, LedgerStore, Turn } from "@socrates/store";
import type { WorkspaceRoot } from "@socrates/tools";

export const MAX_GOAL_ANCHORS = 8;
const TEMPORARY_PATH = /(^|\/)(node_modules|dist|build|out|coverage|tmp|temp|\.git|\.socrates|\.cache|\.next|target|__pycache__)(\/|$)|\.(log|tmp|lock|map)$/i;

/** Trusted application input from an explicit user selection; never model output. */
export interface AnchorDecision {
  goalId: string;
  path: string;
  role: string;
  decision: "approve" | "reject" | "supersede";
}
export interface AnchorChange { path: string; role: string; status: Anchor["status"] }
type Candidate = AnchorProposal & { hash: string; conflicts: string[] };

/** Apply policy synchronously inside the valid turn's completion transaction. */
export function applyAnchors(input: {
  store: LedgerStore; goal: Goal; workspace: WorkspaceRoot | null; turn: Turn;
  proposals: AnchorProposal[]; decisions: AnchorDecision[]; refs: EventRefs;
}): { question: string | null; changes: AnchorChange[] } {
  const { store, goal, workspace, turn, refs } = input;
  const changes: AnchorChange[] = [];
  const warn = (p: { path: string; role: string }, why: string) => store.recordWarning(refs, { kind: "anchor_rejected", detail: `${p.path} (${p.role}): ${why}` });
  if (goal.general || !workspace) {
    for (const p of input.proposals) warn(p, "this work has no workspace");
    return { question: null, changes };
  }
  const file = (p: { path: string; role: string }): { path: string; hash: string } | null => {
    try {
      const resolved = workspace.resolve(p.path);
      const stat = statSync(resolved.abs);
      if (!stat.isFile()) throw new Error("not a file");
      if (TEMPORARY_PATH.test(resolved.rel)) { warn(p, "temporary or generated files are not anchors"); return null; }
      if (stat.size > 20 * 1024 * 1024) { warn(p, "file is too large for an anchor"); return null; }
      return { path: resolved.rel, hash: createHash("sha256").update(readFileSync(resolved.abs)).digest("hex").slice(0, 32) };
    } catch { warn(p, "not an existing file of the workspace"); return null; }
  };
  const revise = (p: { path: string; role: string; reason: string }, status: Anchor["status"]) => {
    store.upsertAnchor({ goalId: goal.id, path: p.path, role: p.role, summary: p.reason, status }, refs);
    changes.push({ path: p.path, role: p.role, status });
  };
  const decide = (p: { path: string; role: string; hash: string }, decision: "approved" | "rejected" | "ignored", questionId?: string) =>
    store.appendEvent("anchor_decided", { path: p.path, role: p.role, hash: p.hash, decision, ...(questionId ? { question_id: questionId } : {}) }, refs);
  const user = store.getEvent(turn.userEventId)!;
  const text = (user.payload as EventPayloads["user_message"]).text.trim();
  const trusted = input.decisions.filter(d => d.goalId === goal.id);
  const candidates: (AnchorProposal & { approved?: boolean; expectedHash?: string; expectedConflicts?: string[] })[] = [...input.proposals];
  const direct = directInstruction(text);
  if (direct && /\b(?:canonical|anchor)\b/i.test(text)) {
    const parsed = AnchorProposal.safeParse({ ...direct, reason: "Selected explicitly by the user." });
    if (parsed.success) candidates.push({ ...parsed.data, approved: true });
  }
  const history = store.listEvents({ goalId: goal.id });
  const question = history.filter(e => e.type === "anchor_question").at(-1);
  if (question && question.seq < user.seq && !history.some(e => e.type === "anchor_decided" && (e.payload as EventPayloads["anchor_decided"]).question_id === question.id)) {
    // Bare yes/no applies only to the immediately preceding user exchange.
    // Intervening requests, including router clarification, expire the question.
    const lastAnswer = store.listEvents({ type: "assistant_response" }).filter(e => e.seq < user.seq).at(-1);
    const immediate = lastAnswer?.turn_id === question.turn_id && store.listEvents({ type: "user_message" }).filter(e => e.seq > question.seq && e.seq <= user.seq).length === 1;
    const yes = immediate && /^(?:yes|yes,? please|approve|approved|confirm|confirmed|go ahead)[.!]?$/i.test(text);
    const no = immediate && /^(?:no|no thanks|reject|rejected|decline)[.!]?$/i.test(text);
    for (const p of (question.payload as EventPayloads["anchor_question"]).proposals) {
      decide(p, yes ? "approved" : no ? "rejected" : "ignored", question.id);
      if (yes) candidates.push({ ...p, approved: true, expectedHash: p.hash, expectedConflicts: p.conflicts });
    }
  }
  // Approval of an existing provisional anchor does not require another proposal.
  for (const a of store.listAnchors(goal.id)) {
    if (explicitInstruction(text, a.path, a.role)) candidates.push({ path: a.path, role: a.role, reason: a.summary, approved: true });
  }
  for (const d of trusted) {
    const parsed = AnchorProposal.safeParse({ path: d.path, role: d.role, reason: "Selected explicitly by the user." });
    if (!parsed.success) { warn(d, "invalid user anchor selection"); continue; }
    if (d.decision === "approve") { candidates.push({ ...parsed.data, approved: true }); continue; }
    const existing = store.listAnchors(goal.id).find(a => a.path === d.path && a.role === d.role);
    if (existing && (d.decision === "supersede" || existing.status === "provisional")) revise({ ...existing, reason: existing.summary }, "superseded");
    const observed = file(d);
    if (observed) decide({ ...d, ...observed }, "rejected");
  }

  const pending: Candidate[] = [];
  const unique = new Map<string, typeof candidates[number]>();
  for (const p of candidates) unique.set(`${p.path}\0${p.role}`, p);
  for (const proposed of unique.values()) {
    const observed = file(proposed);
    if (!observed) continue;
    const p = { ...proposed, ...observed };
    const approved = p.approved || explicitInstruction(text, proposed.path, p.role);
    const anchors = store.listAnchors(goal.id);
    const same = anchors.find(a => a.path === p.path && a.role === p.role);
    const conflicts = anchors.filter(a => a !== same && (a.path === p.path || a.role === p.role));
    if (p.expectedHash && (p.expectedHash !== p.hash || JSON.stringify([...p.expectedConflicts!].sort()) !== JSON.stringify(conflicts.map(a => a.id).sort()))) {
      warn(p, "the file or its competing authority changed after the question; approval was not applied");
      continue;
    }
    if (trusted.some(d => d.path === proposed.path && d.role === p.role && d.decision !== "approve")) continue;
    const latest = store.listEvents({ goalId: goal.id, type: "anchor_decided" }).filter(e => {
      const d = e.payload as EventPayloads["anchor_decided"];
      return d.path === p.path && d.role === p.role && d.hash === p.hash;
    }).at(-1)?.payload as EventPayloads["anchor_decided"] | undefined;
    if (!approved && latest && latest.decision !== "approved") continue;
    if (same) {
      if (approved && same.status !== "active") { revise(p, "active"); decide(p, "approved"); }
      continue;
    }
    if (anchors.length - conflicts.length >= MAX_GOAL_ANCHORS) { warn(p, `the goal already has ${MAX_GOAL_ANCHORS} anchors`); continue; }
    if (conflicts.length && !approved) {
      if (pending.some(other => other.path === p.path || other.role === p.role)) { warn(p, "another proposal competes for this authority; select the preferred file explicitly"); continue; }
      pending.push({ path: p.path, role: p.role, reason: p.reason, hash: p.hash, conflicts: conflicts.map(a => a.id) });
      continue;
    }
    if (approved) {
      for (const old of conflicts) revise({ ...old, reason: old.summary }, "superseded");
      decide(p, "approved");
    }
    revise(p, approved ? "active" : "provisional");
  }

  // Repeated successful use means reads of the current bytes on two distinct
  // completed turns after the provisional revision (this valid turn included).
  for (const anchor of store.listAnchors(goal.id).filter(a => a.status === "provisional")) {
    const observed = file(anchor);
    if (!observed) continue;
    const created = store.listEvents({ goalId: goal.id, type: "anchor_revised" }).filter(e => (e.payload as EventPayloads["anchor_revised"]).anchor_id === anchor.id).at(-1)!;
    const turns = new Set(store.listEvents({ goalId: goal.id, type: "tool_completed" }).filter(e => {
      const p = e.payload as EventPayloads["tool_completed"];
      return e.seq > created.seq && e.turn_id && (e.turn_id === turn.id || store.getTurn(e.turn_id)?.status === "completed") && p.tool === "read" && p.status === "ok" && p.observed.some(o => o.path === anchor.path && o.hash === observed.hash);
    }).map(e => e.turn_id));
    if (turns.size >= 2) revise({ ...anchor, reason: anchor.summary }, "active");
  }
  if (!pending.length) return { question: null, changes };
  store.appendEvent("anchor_question", { proposals: pending }, refs);
  const choices = pending.map(p => `${p.path} as ${p.role.replaceAll("_", " ")}`).join("; ");
  return { question: `Should I replace the existing project references with ${choices}? Reply yes to approve all, or no to keep the current references.`, changes };
}

/** Conservative direct declarations; arbitrary prose is never authorization.
 * Applications may supply an exact goal/path/role decision for other wording. */
function explicitInstruction(text: string, path: string, role: string): boolean {
  const direct = directInstruction(text);
  return direct !== null && direct.path === path && direct.role === role.replaceAll(" ", "_").toLowerCase();
}

function directInstruction(text: string): { path: string; role: string } | null {
  const match = /^(?:I\s+)?(?:approve|confirm|make|use)\s+(.+)\s+as\s+(?:the\s+)?(?:active\s+)?(?:canonical\s+)?(.+?)[.!]?$/i.exec(text);
  if (!match) return null;
  let named = match[1]!;
  if (/^[`"']/.test(named) && named.at(-1) === named[0]) named = named.slice(1, -1);
  return { path: named, role: match[2]!.replaceAll(" ", "_").toLowerCase() };
}
