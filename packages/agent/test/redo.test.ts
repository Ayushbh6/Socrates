import { describe, expect, it } from "vitest";
import { RedoError } from "../src";
import { taskHistory } from "../src/history";
import { continueTask } from "../../router/test/helpers";
import { call, contextText, final, world } from "./helpers";

const access = (root: string) => () => ({ folders: [root], approvals: "auto" as const, protected: [] });

describe("redo in another task", () => {
  it("asks the question again in the chosen task with the first attempt's facts, never its answer, and sets the first attempt aside", async () => {
    const w = await world({ files: { "server.js": "const port = 30;\n" } });
    const before = w.store.requireTask(w.taskId).continuationNote;
    const other = w.store.createTask(w.goalId, { title: "Port settings" });
    const { socrates, model } = w.socrates([continueTask()], [
      { toolCalls: [call("edit", { path: "server.js", old_text: "30", new_text: "3000" })] },
      { toolCalls: [call("terminal", { command: "echo REDO-$((1+1))" })] },
      final({ full_answer: "WRONG-CONTEXT-ANSWER", continuation_note: "Port changed in the wrong task.", task_complete: { reason: "done" } }),
      final({ full_answer: "Answered where it belongs." }),
      final(),
    ], { access: access(w.root) });
    const first = await socrates.handle("Fix the port.");
    if (first.kind !== "answered") throw new Error("expected an answer");
    const firstTurn = first.parts[0]!.turn;
    expect(w.store.requireTask(w.taskId).status).toBe("completed");

    const redo = await socrates.handle("Fix the port.", { target: { taskId: other.id }, pinned: true, redoOf: firstTurn.id });
    expect(redo).toMatchObject({ kind: "answered", parts: [{ task: { id: other.id }, status: "completed" }] });
    const text = contextText(model.requests.at(-1)!);
    const block = /<REDONE_FROM>\n([\s\S]*?)\n<\/REDONE_FROM>/.exec(text)![1]!;
    expect(block).toContain("Project work · Fix the server");
    expect(block).toContain("finished");
    expect(block).toMatch(/- updated .*server\.js/);
    expect(block).toMatch(/- ran `echo REDO-\$\(\(1\+1\)\)` in .* \(exit 0\)/);
    expect(text).not.toContain("WRONG-CONTEXT-ANSWER");

    // The first task forgets it: its note and status are back, and its history, the router and search leave it out.
    const redoTurn = redo.kind === "answered" ? redo.parts[0]!.turn : null;
    expect(w.store.redoneTo(firstTurn.id)?.id).toBe(redoTurn!.id);
    expect(w.store.redoOf(redoTurn!.id)?.id).toBe(firstTurn.id);
    expect(w.store.requireTask(w.taskId)).toMatchObject({ continuationNote: before, status: "open" });
    expect([...w.store.recentExchanges()].map((e) => e.response)).not.toContain("WRONG-CONTEXT-ANSWER");
    expect(w.store.searchExchanges({ fts: "port", limit: 10 }).map((h) => h.turnId)).not.toContain(firstTurn.id);
    expect(w.store.searchExchanges({ fts: "port", limit: 10, includeRedone: true }).map((h) => h.turnId)).toContain(firstTurn.id);
    await socrates.handle("Continue the server work.", { target: { taskId: w.taskId }, pinned: true });
    const next = w.store.turnsForTask(w.taskId).at(-1)!;
    expect(taskHistory(w.store, next.id).turns.map((t) => t.id)).not.toContain(firstTurn.id);
    expect(contextText(model.requests.at(-1)!)).not.toContain("WRONG-CONTEXT-ANSWER");
  });

  it("is offered only for a finished task turn that is still its task's latest, once, and elsewhere", async () => {
    const w = await world();
    const other = w.store.createTask(w.goalId, { title: "Elsewhere" });
    const { socrates } = w.socrates([continueTask(), continueTask()], [final(), final(), final()]);
    const one = await socrates.handle("First question.");
    const two = await socrates.handle("Second question.");
    const firstTurn = one.kind === "answered" ? one.parts[0]!.turn : null;
    const secondTurn = two.kind === "answered" ? two.parts[0]!.turn : null;
    expect(socrates.redoProblem(firstTurn!.id, other.id)).toBe("Later questions in this task build on this answer.");
    expect(socrates.redoProblem(secondTurn!.id, w.taskId)).toBe("That is the task it was answered in; pick another.");
    expect(socrates.redoProblem(secondTurn!.id, other.id)).toBeNull();
    await socrates.handle("Second question.", { target: { taskId: other.id }, pinned: true, redoOf: secondTurn!.id });
    expect(socrates.redoProblem(secondTurn!.id, other.id)).toBe("That question was already asked again in another task.");
    // With the second set aside, the first is its task's latest again.
    expect(socrates.redoProblem(firstTurn!.id, other.id)).toBeNull();
    await expect(socrates.handle("Second question.", { target: { taskId: other.id }, redoOf: secondTurn!.id })).rejects.toBeInstanceOf(RedoError);
  });

  it("archives a task that held only the redone question, and says when the first attempt changed nothing", async () => {
    const w = await world();
    const made = w.store.createTask(w.goalId, { title: "Made for one question" });
    const { socrates, model } = w.socrates([], [final(), final()]);
    const one = await socrates.handle("What is the port?", { target: { taskId: made.id }, pinned: true });
    const turn = one.kind === "answered" ? one.parts[0]!.turn : null;
    await socrates.handle("What is the port?", { target: { taskId: w.taskId }, pinned: true, redoOf: turn!.id });
    expect(w.store.requireTask(made.id).archivedAt).not.toBeNull();
    expect(contextText(model.requests.at(-1)!)).toContain("It changed no files and ran no commands.");
  });
});
