import { noteLength, type EventPayloads } from "@socrates/contracts";
import type { LedgerStore } from "@socrates/store";
import { validateFinalAnswer } from "./final";

/** Append-only correction: exact saved answer plus a length-only rejection proves the candidate. */
export function repairHistoricalNotes(store: LedgerStore): number {
  let corrected = 0;
  for (const warning of store.listEvents({ type: "agent_warning" })) {
    const p = warning.payload as EventPayloads["agent_warning"];
    if (p.kind !== "final_answer_invalid" || !/^continuation_note is \d+ tokens; shorten it to at most 100\.$/.test(p.detail) || !warning.turn_id) continue;
    const turn = store.requireTurn(warning.turn_id);
    if (!turn.taskId || !turn.responseEventId || store.listEvents({ turnId: turn.id, type: "note_outcome" }).length) continue;
    const exact = (store.getEvent(turn.responseEventId)!.payload as EventPayloads["assistant_response"]).text;
    const candidate = store.listEvents({ turnId: turn.id, type: "agent_message" }).map(e => validateFinalAnswer((e.payload as EventPayloads["agent_message"]).response.text)).find(v => v.ok && !v.noteIssues.length && v.value.full_answer === exact);
    if (!candidate?.ok) continue;
    const task = store.requireTask(turn.taskId);
    const latest = store.turnsForTask(task.id).filter(t => t.status !== "in_progress").at(-1);
    // Do not replace a later note or a user's subsequent correction.
    if (latest?.id !== turn.id || !/^Ended without a valid final answer after \d+ tool calls?\.$/.test(task.continuationNote ?? "")) continue;
    store.transaction(() => {
      store.reviseTask(task.id, { continuationNote: candidate.value.continuation_note });
      store.appendEvent("note_outcome", { field: "continuation_note", outcome: "repaired", length: noteLength(candidate.value.continuation_note), reason: "Historical length-only rejection corrected from the original recorded final answer; no work rerun.", attempts: 0, source_turn: turn.id, correction: true }, { goal_id: turn.goalId, task_id: task.id, turn_id: turn.id, chat_id: turn.chatId });
    });
    corrected++;
  }
  // The user identified this exact unsupported Sunday summary. Flag it, never invent a replacement.
  const unsupported = store.getTurn("turn_8cfedcc1574d4d02a320ccf729e0809a");
  if (unsupported?.taskId && !store.listEvents({ turnId: unsupported.id, type: "agent_warning" }).some(e => (e.payload as EventPayloads["agent_warning"]).kind === "note_review")) {
    store.recordWarning({ goal_id: unsupported.goalId, task_id: unsupported.taskId, turn_id: unsupported.id, chat_id: unsupported.chatId }, { kind: "note_review", detail: "Historical summary requires review: it claimed an unfinished Sunday session without supporting recorded evidence. Read the Friday request and Saturday successful terminal test; no replacement facts have been generated." });
  }
  return corrected;
}
