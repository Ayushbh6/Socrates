# Redo in another task (design, for approval)

Status: proposed 2026-10-09. Not built. When it is, `architecture/` describes it and this file goes.

## The problem

The router sometimes puts a question in the wrong task. The answer it gets there was written with that task's context: its history, summary, goal note, folder and memory. Re-labelling the exchange as another task's would put an answer in that task's history that was never written with that task's context. So a misroute is never *moved*: the question is **asked again in the right task**, and the first attempt is set aside.

The user catches a misroute the way they would anyway: the route ("General conversation / General") and the notes show as soon as the agent starts, so they can press Stop. No approval step is added to routing.

## What the user does

- Every finished or stopped exchange has **Redo in…** on its route line (the "Goal / Task" crumb above the answer), in Flow and in Standard.
- It opens a picker with the same choices as Standard's sidebar: any open chat of any goal, a **new chat** in any goal, today's **General** day, or a new plain chat under **Chats**.
- Picking one asks the same question again there, at once: the same text and the same images. Flow sends it pinned to that task, as "Keep my next message in this task" does. Standard opens that chat and it runs there.
- The original stays where it was, folded to one line, **"Redone in Resume / Rewrite ›"**, which opens it. The new one says **"Redone from General · Fri 9 Oct ›"**.

## When it is offered

Only while the exchange is the **latest one in its task** (it may have been stopped). If later questions in that task came after it, they may have built on its answer, and a redo cannot undo that. There the item is disabled: "Later questions in this task build on this answer". Stopping and redoing at once, the case this is for, always qualifies. A question that is still running cannot be redone; stop it first.

## What the right task's agent sees

- The question, as the newest message of its own task, with that task's full context. It is a new turn, so it costs a new answer.
- One short block, `<REDONE_FROM>`, with **facts only, never the first answer**, so the wrong context's conclusions do not leak in:
  - that the user asked this first in another task and moved it here;
  - whether that attempt finished or was stopped;
  - what it changed that is still true: files edited or created (paths) and commands run (with exit codes), so the agent checks the current state instead of repeating them blindly.

## What the wrong task forgets

The first attempt stays in the event log, which is never edited. A `turn_redone` event marks it, and from then on it is left out of:

- that task's history and its compaction (it is never summarised into the task);
- the router's view of recent exchanges, and `<RECENT_ACTIVITY>`;
- `<RETRIEVED_HISTORY>` and semantic search of exchanges.

`context_retrieve` and `ledger_query` can still find it, marked "redone in …", because it did happen. Files it changed stay changed; only the record is set aside.

## Storage

- New event `turn_redone { turn_id, redo_turn_id }`, appended when the redo is bound. There is no schema change: a turn counts as set aside when such an event names it.
- The redo is a new user message event carrying `redo_of: <turn_id>`, bound to the chosen task like a pinned message.

## Not in this phase

- **Learning from corrections:** the router seeing recent redos when it routes is a separate idea.
- **Redoing an exchange that later ones built on.**
- **Moving a whole task to another goal.**

## Tests to write

- A redo binds to the chosen task and its context has the question and a `<REDONE_FROM>` block with the first attempt's file edits and commands, and not its answer.
- The first task's next turn, its compaction, the router's context and semantic search no longer include the redone exchange; `context_retrieve` still finds it, marked.
- Redo is refused for an exchange that is not its task's latest, and for one still running.
- Page: the folded "Redone in …" line, the "Redone from …" line, and the disabled item with its reason.
