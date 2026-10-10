# Socrates Goal Router

## Purpose

Socrates presents one continuous conversation to the user. Internally, it resolves each user request to a workspace and a goal so the working agent receives only the history relevant to the work it is doing.

The user never creates, names, opens, or closes chats — and never selects a project or workspace. They simply keep speaking to Socrates. "Continue the project from yesterday" and "let's continue with the German lesson" are resolved by routing, not by a picker.

The Goal Router has one job:

> Decide which workspace, which goal, and which task own the current user message before the working agent starts.

It does not answer the user, search the repository, update memory, or perform the task. It has exactly two tools, both harness-bounded: `ledger_query`, a read-only capped query over the ledger (see "The ledger") used to resolve temporal and vague references that the pre-rendered context cannot cover; and `ask_user`, the structured clarification tool that ends a routing run with an enumerated question.

## Core terms

- **Workspace**: the repository or directory context in which the working agent runs. Resolved by routing, never selected by the user. One workspace may contain many goals.
- **Flow**: the user's never-ending visible sequence of user requests and Socrates responses. One flow spans all workspaces; structure is carried by tags, not by separate timelines.
- **Goal**: the overarching, durable outcome — the equivalent of a project in a standard harness. A goal may be small ("prepare this website"), year-long ("teach me Python"), or lifelong ("teach me German"). A goal belongs to exactly one workspace — this binding is permanent and is what makes workspace resolution piggyback on goal resolution.
- **Task**: one bounded, meaningful piece of work with a single objective and a recognisable completion point — the equivalent of a chat in a standard harness. A task contains many conversational turns, not one. "Fix the homepage hero on mobile" is a task; "make the heading smaller" is a turn inside it.
- **Chat**: one context session performing a task. Usually one task has one chat. Exceptionally, a long task has a linked chain of continuation chats created by the automatic rollover (see "Task rollover").
- **Turn**: one user message and the work performed in response to it, inside a task.
- **Ledger**: the queryable index of work. One entry per task, kept as a current projection over append-only revisions, carrying identity, timestamps, the continuation note, and pointers to exact evidence. See "The ledger."
- **Continuation note**: a short description of where a task currently stands and what matters next. It is task-local.
- **Exact history**: the original user messages, assistant responses, tool calls, and tool results stored without summarization.

### The product model

```text
Goal = Project
Task = Chat inside that project
Turn = Message inside that chat
```

There is one underlying system with two views:

- **Zen view (Flow mode)**: the user simply types. The router identifies the workspace, goal, and task automatically. No pickers, no project creation.
- **Standard view**: the same goals appear as projects and the same tasks appear as chats. The user can navigate or create them manually; a project created here becomes a new goal, and each chat becomes a task in the flow.

Nothing is duplicated or converted between views — they are two projections of the same data.

### Tenet revision (2026-09-02)

The earlier definition "every user message creates a task" is **rejected**. One task contains many turns. A message creates a new task only when it introduces a new bounded objective; otherwise it is a turn inside the current task. This revision aligns the model with standard harness structure (goal = project, task = chat) while keeping the seamless Zen view.

### Goal versus task

This distinction is mandatory and controls the granularity of routing:

- A **goal** is a durable desired outcome that may contain many pieces of work over days, months, or years.
- A **task** is one bounded, meaningful piece of work with a single objective and a recognisable completion point. It contains many turns.

For example:

```text
Goal: Ongoing German learning

Tasks within that goal:
- Create a 30-day learning plan.
- Complete the Day 1 lesson.
- Review dative prepositions.
- Complete the Day 10 lesson.
```

The router must not create `Day 10 German lesson` as a new goal when `Ongoing German learning` is already a plausible known goal. A new lesson, review, fix, test, file, or implementation step remains inside an existing goal when it advances that goal's durable outcome.

The router creates a new goal only when the desired outcome changes, not merely because the immediate activity, verb, deliverable, or day number changes.

### Task scoping and the continue/create boundary

A task must be well scoped. "Fix Andy Website mobile UX" is too broad for a task — it describes a collection of outcomes and would accumulate unrelated page work, dozens of turns, and repeated compactions. A task represents one bounded outcome; follow-up fixes, testing, and revisions for that outcome remain in the same task.

Continue the existing task when the message:

- advances its existing objective;
- asks for a revision, test, explanation, or correction of its output;
- addresses a blocker discovered while doing it;
- refers naturally to the same bounded result.

Create a new task when the message:

- introduces an independently completable objective;
- moves to a different page, feature, lesson, deliverable, or problem;
- can be completed without completing the current task;
- starts the next meaningful stage after the current task has ended.

```text
Task: Fix homepage hero on mobile

"Make the heading smaller."                 → continue
"Test it on an iPhone-sized viewport."      → continue
"The image still overflows."                 → continue
"Now fix the mobile navigation menu."        → new task
```

Message count must not determine the boundary. A task does not split merely because it reached twenty turns, but good scoping prevents unrelated work from accumulating inside it.

### Trivial and elliptical messages

Most real traffic is short, unanchored, and elliptical. The resolution rules are:

| Message shape | Resolution |
|---|---|
| No anchor at all ("what file was that?", "make it smaller", "test it") | **Current task** — recency is the primary signal |
| Names the current task's subject or artifacts | Current task |
| Explicitly names a different subject ("go back to the hero, it regressed") | That older task (resume) |
| No subject and no plausible task anchor ("who won the UFC fight?") | The `general` task |
| New bounded objective ("now fix the nav menu") | New task |

The **recency default** is the workhorse rule of the task layer: unanchored messages resolve to the current task, and only explicit signals move a message elsewhere. Defaults are cheap; exceptions need evidence. This mirrors the goal-level rule that `create_new` requires a genuinely different outcome.

The **`general` task** is the default home for trivial and conversational messages that have no task anchor. A first message that is trivial ("hi, how are you?") creates the `general` task under a `general` goal. An unrelated aside mid-task ("who won the UFC fight?") goes to the `general` task — it neither pollutes the working task's transcript nor spawns a named task. A thematically attached aside ("so what file is this?" during a file task) stays in the current task.

There is exactly one general goal, holding one general task per day. The router selects it with the reserved goal label `general` (task fields null); the harness binds the message to today's general task, in the user's time zone, creating the goal and the day's task (named by its date, "General · Fri 9 Oct") on first use. A busy day's task rolls over into continuation chats after five compactions like any task (see "Task rollover"); the next day starts a new task. Tasks from before this rule (one undated "General" task) are kept as they are. The general goal is never bound to a workspace; each turn starts in the application's working folder as it is then (agent-harness.md, "Exact per-turn lifecycle"), and its task is never compacted into or mixed with any real task's history.

## Non-negotiable rules

1. Routing happens once, before the working-agent loop. The router makes two decisions in that one run: which goal, and which task inside that goal.
2. There is no second router at the end of the task.
3. The current user message appears exactly once in the router request and is the final input block.
4. History is budgeted by tokens, not by a hardcoded number of Q&A pairs.
5. The router sees complete Q&A pairs wherever possible; a user message is never separated from its answer.
6. The router selects a workspace, a goal, and a task, and for records it creates it proposes their bounded definitions (a goal objective; a task objective and completion criteria). It never writes storage, goal progress, facts, files, capabilities, or task state.
7. Exact history remains in storage even after it is compacted out of the model prompt.
8. Internal goal and task identifiers are never shown to the model or the user. The router receives temporary labels such as `current`, `older_1`, and `latest`, plus the permanent human-facing selectors (`gN`, `gN/tN`) that `ledger_query` returns. Neither is a database identifier; the harness resolves both.
9. The Main Coding Agent returns the continuation note together with its visible answer. No additional state-writing model call runs afterward.
10. **Models propose, the harness disposes.** No LLM ever writes storage directly. Every model-produced field — the router's goal and task selection, the agent's continuation note, the compactor's checkpoint — passes through harness validation before it is persisted.
11. **A goal belongs to exactly one workspace.** The binding is permanent. Workspace resolution piggybacks on goal resolution: resolving the goal resolves the workspace.
12. **The router has exactly two tools, both harness-bounded.** `ledger_query` is read-only over the ledger, capped at three calls per routing decision. `ask_user` ends the routing run with one structured clarification question. Neither can touch files, terminals, or state.
13. **Clarify is always constructive.** The `ask_user` schema requires a non-empty candidates list; the harness rejects a question without candidates. The only permitted empty-candidates clarify is the zero-history start, which uses an explicit schema flag.
14. **Compaction is strictly task-local.** It never summarizes multiple tasks or goals together. Switching tasks is context replacement, not compaction.
15. **The user always has the final say.** The agent may propose task completion; the harness records it; the user can override, reopen, split, merge, or reassign any task at any time.

## Routing outcomes

The router must choose exactly one outcome, and each outcome now carries both a goal decision and a task decision:

The `decision` field names the goal-level outcome; `task_decision` names the task-level outcome inside the selected goal. The permitted combinations are listed under "Router output."

### `continue_current`

The message stays in the current goal. It either continues the current task inside it or, when it introduces a new bounded objective, creates a new task in the current goal.

Changing from review to implementation does not automatically create a new goal or a new task. For example, “review the memory system” followed by “fix the information-loss problem” remains one goal, and “make the heading smaller” after fixing the hero remains one task.

### `resume_existing`

The message clearly returns to a different known goal, or to a different, earlier task inside the current goal. Returning to an older goal either resumes one of its tasks or creates a new task in it.

The user does not need to say “go back.” Natural references to the subject are sufficient. For example, after discussing the agent prompt, “Did that memory compaction fix preserve tool results?” can select the older memory-system goal; after moving to the nav menu, “actually go back to the hero, it regressed” resumes the hero task.

### `create_new`

The message seeks an independent outcome that does not belong to the current or any older goal. The router creates a new goal and its first task. A new bounded objective inside an existing goal is not `create_new`; it is `create_task` under `continue_current` or `resume_existing`.

### `clarify`

Two or more goals or workspaces are plausible and choosing the wrong one would materially change the work. The router ends its run by calling the `ask_user` tool with one short clarification question that **enumerates the candidates it considered**, leading with its best guess:

> "Yesterday you worked on three things — which should we continue with?"
> ⬤ Website X (most recent) ⬤ German lessons ⬤ UFC chat ⬤ None of these

The question is asked as a normal assistant response; no special user-facing mechanism is required beyond the tool's structured rendering. The user's answer re-enters the router as a normal message and resolves trivially because the question itself placed the candidates into recent history. A bare "I don't know" is never a valid clarify: if the referenced period or subject matches nothing, the router says so honestly and then offers the nearest plausible candidates ("I don't see anything from June — in July we worked on X and Y; did you mean one of those, or something else?"). The only permitted empty-candidates clarify is the zero-history start: "I don't have any past sessions on this — shall we start it as new work?" That question is asked once; the user's answer is binding and never re-confirmed.

### `compound`

One message contains multiple work units that cannot honestly be assigned to one task. The router splits the message without rewriting its meaning, assigns each part its own goal decision and task decision (each part thereby also resolving its workspace), and preserves their execution order. Parts may land in different tasks of the same goal or in different goals.

This is for requests such as posting the completed work from one task and then starting a new security review based on that work. It is not used merely because one task contains several implementation steps.

### Workspace resolution

Workspace resolution piggybacks on goal resolution. Because a goal belongs to exactly one workspace (rule 11), selecting the goal selects the workspace. The router never resolves a workspace independently; it resolves goals, and the bindings carry the rest.

The stakes differ between goal errors and workspace errors, and the safety policy follows the stakes:

| Situation | Behavior |
|---|---|
| Message names the subject clearly ("continue the german lesson") | Resolve directly — no question, ever |
| Only one plausible recent workspace | Continue it — no question |
| Multiple plausible + read-only or conversational intent | Prefer the most recent, proceed — a wrong guess costs one correction message |
| Multiple plausible + mutating intent (will touch files) | Clarify before starting — a wrong guess edits the wrong repository |

Two mechanisms make the low-friction cases safe:

**The workspace banner.** Every task's UI shows the resolved workspace and goal as a quiet, always-visible indicator:

```text
── Working in: website-x · Goal: Checkout flow fix ────────── [switch]
```

The user who sees the wrong workspace corrects it with one click or one sentence before any damage occurs. The banner is invisible when right and one glance when wrong.

**The first-mutation gate.** When a workspace was resolved with low confidence (multiple plausible candidates, resolved by the prefer-latest rule) and the task's first mutating tool call (`edit`, `apply_patch`, mutating `terminal`) arrives, the harness pauses for one lightweight confirmation before executing it. Read-only work — searching, reading, answering — never gates. The gate fires at most once per task and never for a workspace the user confirmed or that was unambiguous.

"Current" is global, not per-workspace: the current goal is the most recently worked-on goal across all workspaces. `continue_current` therefore means "continue whatever we were last doing," which matches how users actually talk. It belongs to the main conversation: work running in a parallel lane never changes it, and a lane's own "current" is its task (`agent-harness.md`, "Lanes").

## Exact router input

The router uses a fixed system prompt followed by one turn-specific input. The turn-specific input has this order:

```text
<CURRENT_TIME>
2026-09-01T14:32 local (Tuesday)
</CURRENT_TIME>

<RECENT_ACTIVITY>
Last 48 hours (detail):
2026-09-01 14:02  website-x   Checkout flow fix — tests pass, staging deploy
2026-08-31       personal    German Day 10 — dative prepositions, Day 11 next

Last 7 days (one line each):
2026-08-29  website-x   Payment provider integration
2026-08-27  personal    German Day 9
</RECENT_ACTIVITY>

<RECENT_EXACT_HISTORY>
[goal=current · task=current · workspace=website-x]
USER:
Can you review the checkout flow in Website X?

SOCRATES:
The current checkout path drops the discount code on retry...

[goal=older_1 · task=latest · workspace=personal]
USER:
The agent prompt feels too complicated. Can you review it?

SOCRATES:
Yes. The core prompt currently mixes stable behavior with provider guidance...
</RECENT_EXACT_HISTORY>

<KNOWN_GOALS>
CURRENT
label: current
title: Memory system review
workspace: website-x
note: Reviewed compaction. The remaining concern is preserving large tool results.
tasks:
- current: Preserving large tool results — active
- task_1: Compaction provenance fix — completed

OLDER
label: older_1
title: Agent prompt improvement
workspace: personal
note: Simplify the core prompt and keep provider-specific guidance outside it.
tasks:
- latest: Split provider guidance out of the core prompt — open
</KNOWN_GOALS>

<CURRENT_USER_MESSAGE>
Did that compaction fix preserve tool results?
</CURRENT_USER_MESSAGE>
```

The current message is last so it is never buried between summaries and history. It is not repeated in a separate `latest exchange` field.

### The sections are built independently

#### 1. `<CURRENT_TIME>` and `<RECENT_ACTIVITY>`

The harness injects the current date and time as a fixed header. Time is injected, never fetched: the router needs no clock tool, and temporal references such as "yesterday" or "last week" resolve against the header plus the activity notepad.

The notepad is a **derived view, never stored prose** — a mechanical query over the ledger rendered fresh on every request, never cached across turns. It renders the last 48 hours in detail and the last 7 days as one line per task. It is bounded (~15 lines) and sits in the dynamic suffix, so it never disturbs the cache-stable prefix.

#### 2. `RECENT_EXACT_HISTORY`

This section is purely chronological. Starting immediately before the current user message, the harness walks backward through the flow's exact Q&A trail and takes the newest complete pairs that fit within the history budget. A turn the user asked again in another task is left out (`agent-harness.md`, "Redo in another task"); its redo is in the trail where it was asked.

There is no semantic, vector, BM25, keyword, file, or topic filtering in this section.

Every included Q&A pair is tagged with the goal, task, and workspace to which it was already bound. The tag uses a human-readable title or a temporary label created for this router request, never an internal database identifier. A tag records existing ownership; it does not influence candidate retrieval or make a new routing decision.

One flow spans all workspaces: the section is chronological across workspace switches, because that is how the user experienced it. The tags carry the structure.

#### 3. `KNOWN_GOALS`

This section is assembled separately. It contains:

1. the current goal, always, when one exists, with a small index of its open and recently completed tasks (label, title, status); and
2. up to three older goal candidates found by hybrid retrieval over every saved goal title, goal note, task continuation note, and lightweight anchor manifest. Each older candidate carries a small task index too: its most recently updated task, labelled `latest`, and up to two other open tasks. When fewer than three goals match the message, the remaining slots are filled with the goals most recently active in the last seven days, so vague temporal references ("the project from yesterday") still see them; and
3. the general goal, labelled `general`, unless it is already the current goal.

Hybrid retrieval fuses the keyword and meaning rankings of goals (a goal ranks by its own best match or its best task's) and adds two small boosts (`agent-harness.md`, "Embeddings and hybrid retrieval"); without an embedding index it uses every signal except semantic similarity:

- semantic/vector similarity;
- BM25 or equivalent keyword matching; and
- a small recency boost; and
- a small boost for open, long-running goals whose scope plausibly contains the request.

Candidate retrieval is grounded in the exact current user message and the project's lightweight identity, such as its name and stated purpose. It searches goal titles, goal notes, task continuation notes, and anchor names, roles, and short summaries. It never injects full anchor files into the router request.

This matters for elliptical requests. In a project named `German`, the message `Okay, let's start today's lesson` should retrieve an open goal titled `Ongoing German learning` even when the last German lesson is outside the recent exact-history window. Its continuation note and an anchor summary such as `30-day-plan.md — curriculum and lesson sequence` provide additional evidence.

Appearing in recent exact history may improve a goal's recency signal, but it is neither required nor sufficient for selection. A goal outside the recent-history window can still be retrieved.

Retrieval only creates a shortlist. The Goal Router—not the retrieval system—decides whether the message continues the current goal and task, resumes a candidate, creates a new goal or task, needs clarification, or is compound.

The labels `older_1`, `older_2`, and `older_3` are temporary ranks for this request. A goal created 23 goals ago may still be labelled `older_1`; there is no `older_23` label. Task labels follow the same rule and are interpreted within the selected goal: in the current goal, `current` is the current task and `task_1`, `task_2`, ... are its other listed tasks; in an older goal, `latest` is its most recently updated task and `task_1`, `task_2`, ... are its other listed tasks.

#### 4. `LANES`

Present only when work runs or recently finished in parallel lanes beside the conversation (`agent-harness.md`, "Lanes"); a lane being routed does not see itself. One line per open lane, selecting its earliest unfinished turn before its most recently finished turn so queued handoffs do not hide ongoing work (the host's live turn overrides this ledger-only fallback, including after restart): its number, status (working, waiting for the user's answer, finished or stopped with the time), and its goal and task with `gN` and `gN/tN` selectors. A lane that finished or stopped more than `24` hours ago is left out. The selectors are valid labels without a `ledger_query`.

A message that only asks how a lane's work is going routes to `general`, even when the lane works on the current task, and is answered from `<LANES>` without disturbing the lane. A message that changes or adds to a lane's work routes to that lane's task by its selectors and is handed to the lane. New, separate work is never routed into a lane's task merely because the lane exists.

#### 5. `REMEMBERED`

Present only when the memory gate (`agent-harness.md`, "Memory") expects the message to lean on something the user asked Socrates to remember (recall at least `0.5`). At most `6` saved memories of any goal that match the message by words or meaning, within `250` tokens, one per line as `- [kind · date · limited to goal "Title"] text`; the goal is named only for a memory limited to one goal, and there are no handles. They tell the router what the message is about (a trip, a person, a project), which a bare "my trip" does not; they are not goals or tasks, so it routes only to labels it was given, and a message that depends on one is not unclear: it does not ask what it refers to. Without the gate, or when it expects no recall, the block is absent and the router is unchanged.

#### 6. `CURRENT_USER_MESSAGE`

This is the exact current query. It appears once, after both context sections, and is always the final block read by the router. When the message has images, `CURRENT_ATTACHMENTS` names them just before it (and `REMEMBERED`, when present, comes before that). A message that is only images has no text; in its place the router reads "(No text: the user sent only the images in CURRENT_ATTACHMENTS.)". Such a message continues the conversation: the current task, or `general` when there is none. It is never asked about and never compound, and the stored message stays empty.

### Recent-history token budget

The router-history budget is a fixed `20,000` tokens. Like every budget in Socrates, it is an absolute number under the universal `180,000`-token ceiling defined in `agent-harness.md` ("Token budget and trigger points") and never a percentage of the served model's context window.

The harness builds `RECENT_EXACT_HISTORY` as follows:

1. Start with the completed Q&A pair immediately preceding the current message.
2. Walk backward chronologically.
3. Add only complete pairs while they fit within the budget.
4. Present the selected pairs in normal oldest-to-newest reading order.
5. Never include the current user message inside recent history.
6. If the newest single exchange exceeds the entire budget, include a clearly marked bounded excerpt and retain the complete exchange in storage.

The budget is measured in tokens. The architecture must not encode “last three messages” or another fixed pair count.

## Router output

The router returns strict structured data. It has exactly two tools — `ledger_query` and `ask_user`, described below — and may call `ledger_query` before committing to a decision:

```json
{
  "decision": "continue_current | resume_existing | create_new | compound",
  "goal_label": "current | older_N | gN | null",
  "new_goal_title": "string | null",
  "task_decision": "continue_task | resume_task | create_task | null",
  "task_label": "current | latest | task_N | gN/tN | null",
  "new_task_title": "string | null",
  "new_goal_objective": "string | null",
  "new_task_objective": "string | null",
  "new_task_completion_criteria": "string | null",
  "workspace_confidence": "high | low | null",
  "reopen_task": "boolean | null",
  "parts": "array | null",
  "reason": "one short sentence"
}
```

`clarify` is not a JSON decision: it is expressed by calling the `ask_user` tool, which ends the routing run. The four JSON decisions and the one tool call are the only ways a routing run ends.

Rules:

- **Definitions on creation.** Every `create_task`, in any decision or compound part, carries `new_task_objective` (one line: the bounded outcome) and `new_task_completion_criteria` (one line: how anyone can tell it is done). Every `create_new` also carries `new_goal_objective` (one line: the durable outcome the goal works toward). They are written from the user's intent, never pasted from the message, and are null on every route that creates nothing. The harness rejects a creation without them, bounds them in tokens, and persists them; the exact user message stays only in the event log. Harness fallbacks that create work without a model proposal store a bounded excerpt of the request as the objective and leave the completion criteria null rather than inventing them.
- `continue_current`: `goal_label` must be `current`. `task_decision` is `continue_task` with `task_label: current` for an unanchored or same-subject message, or `create_task` with `new_task_title` and the task definition when the message introduces a new bounded objective inside the current goal.
- `resume_existing`: either `goal_label: current` with `task_decision: resume_task` and a listed task label other than `current`, when the message returns to an earlier task of the current goal; or an older goal (`older_N`, or a `gN` selector returned by `ledger_query`) with `task_decision: resume_task` and one of that goal's task labels (`latest`, `task_N`, or a `gN/tN` selector returned by `ledger_query`), or `create_task` with `new_task_title`. `continue_task` is valid only for the current task of the current goal. A new task in the current goal is canonically `continue_current` with `create_task`; the harness also accepts it under `resume_existing`, because both select the same goal.
- `create_new`: `new_goal_title`, `new_goal_objective`, `task_decision: create_task`, `new_task_title`, and the task definition are populated, and `goal_label` and `task_label` are null; the message starts the new goal's first task. When no existing workspace plausibly owns the request, the harness resolves the workspace: general conversation and Q&A need no workspace; the first mutating action in an unowned request surfaces one lightweight workspace decision, following the same consequential-only questioning policy as anchors.
- `general`: `goal_label: "general"` with all task fields null routes the message to today's general task. The canonical form is `continue_current` when the general goal is current and `resume_existing` otherwise, but the harness accepts either, because both reach today's task; it is never `create_new`, because the harness creates the general goal on first use. General conversation is never bound to a workspace, so its `workspace_confidence` is ignored and never arms the first-mutation gate.
- `clarify`: the router does not return a `clarification_question` field. It calls the `ask_user` tool instead, and its run ends there. See below.
- `compound`: `parts` is populated and the other route-specific fields are null. Every part contains its exact sub-request, order, goal decision, task decision, reason, and dependency list (`depends_on`: the earlier parts it needs, or `[]` when independent; part 1 may omit it because it cannot depend on anything). A part that creates no goal may omit `new_goal_title`. Each part carries its own `workspace_confidence`, because parts may target different workspaces.
- `reopen_task` is explicit when selecting a completed task: `true` resumes work by appending an open revision and clearing `completed_at`, with the same task ID; `false` answers a question about past work without changing completion. It is null for general, new tasks, and top-level compound; each compound part has its own value.
- `workspace_confidence` is `low` whenever two or more workspaces were plausible and the router chose by recency. A `low` value arms the first-mutation gate described under "Workspace resolution."
- `reason` is always written by the Goal Router. It briefly explains why the selected goal and task own the message or why a new goal/task or clarification is required. It is stored for inspection and evaluation; it is not normally shown to the user.

### `ledger_query` — the router's read-only recall tool

The router is not a second agent: it has no file, terminal, or state tools, and it never loops. It has exactly two tools, both harness-bounded.

`ledger_query` resolves temporal and vague references that the pre-rendered context cannot cover:

```json
{
  "from": "2026-08-01 | optional",
  "to": "2026-08-31 | optional",
  "match": "payment | optional",
  "workspace": "string | optional",
  "goal": "string | optional",
  "task": "string | optional",
  "status": "open | completed | superseded | any | optional",
  "limit": "integer, default 10, cap 20"
}
```

Structured filters only — never freeform SQL. The model fills a filter form; the harness executes the query deterministically over the ledger and returns bounded rows in the same shape as notepad lines:

```text
2026-08-12  website-x   g7 Andy Website development · t4 Payment integration — sandbox works, live keys pending
2026-08-05  personal    g3 Ongoing German learning · t8 German Day 8 — subordinate clauses
```

Hard caps, enforced by the harness:

- At most **3 `ledger_query` calls** per routing decision. On reaching the cap, the router proceeds with what it has or returns `clarify`.
- Rows carry only ledger-level facts: date, workspace, permanent goal/task selectors, goal title, task title, task objective/status, and note excerpt. Never workspace content, never exact message bodies.
- The tool is deliberately cross-workspace — resolving "which project?" is its job — but it exposes only the same metadata `KNOWN_GOALS` already exposes.

#### Selecting a goal found by `ledger_query`

A goal or task found through `ledger_query` is directly selectable, even when it was not one of the `KNOWN_GOALS` candidates. The router returns its permanent selector exactly as the row showed it: `goal_label: "g12"` for a goal, and `task_label: "g12/t4"` for one of its tasks.

The harness accepts a `gN` or `gN/tN` selector only if it appeared in a `ledger_query` result during this same routing run. Any other selector—one copied from history, guessed, or remembered from an earlier run—fails validation and triggers the normal repair attempt. This keeps the router's choices bounded to evidence it was actually shown, while removing the dead end where the router finds the right goal but has no valid way to name it.

Example: "Remember what we were working on last month, I have a new idea on it." The message's temporal reference falls outside the 7-day notepad, so the router calls `ledger_query(from: 2026-08-01, to: 2026-08-31)` and reads the rows. If exactly one goal is plausible, it returns `resume_existing` with that row's `gN` selector and either resumes the row's task (`gN/tN`) or creates a new task for the new idea; otherwise it returns a constructive clarify enumerating exactly those rows.

The escalation path composes with the tools: if the router model returns invalid output or misuses a tool, the single retry on the main model inherits the same remaining call budget.

### `ask_user` — the router's structured clarification tool

When the router cannot choose safely, it ends its run by calling `ask_user` instead of returning a decision. The tool call is the clarify outcome:

```json
{
  "question": "Yesterday you worked on three things — which should we continue with?",
  "candidates": [
    { "label": "Website X", "detail": "checkout flow fix, most recent", "suggested": true },
    { "label": "German lessons", "detail": "Day 10, dative prepositions" },
    { "label": "UFC chat", "detail": "fight discussion" }
  ],
  "allow_new": true
}
```

Schema rules, enforced by the harness:

- `candidates` must be non-empty. Each candidate carries a human-readable label, a one-line detail (from the ledger row or goal note), and an optional `suggested` flag marking the router's best guess. The harness rejects a call with an empty list unless `zero_history: true` is set.
- Candidates may carry optional `goal_label` and `task_label` bindings using the same validated labels/selectors as a decision. They are hidden from the rendered question. The harness persists their resolved IDs with the clarification so numeric answers and model-failure recovery select the same candidate after restart or relabelling. Human-only candidates are mechanically bound only when their metadata matches uniquely.
- `zero_history: true` is the one permitted empty-candidates form, used only when the ledger contains no activity at all: "I don't have any past sessions on this — shall we start it as new work?"
- `allow_new` offers "none of these — start something new" as an explicit choice, so the user can reject the entire shortlist without the router guessing again.
- The question is rendered as a normal assistant message; the UI renders candidates as selectable chips. The user's answer — whether a chip, a free-text reply, or "none of these" — re-enters the router as a normal message and resolves trivially because the candidates are now in recent history.
- `ask_user` may be called at most once per routing decision. After the user answers, the router re-runs with the answer in context and must return a decision: the harness withdraws `ask_user` from that run and adds a short routing note saying so. If the answer is still ambiguous, the fallback ladder applies (see "The backend validates this result").
- The question and its user message are stored as a completed exchange that belongs to no goal or task. It receives a `project_turn` number and appears in `RECENT_EXACT_HISTORY` (tagged as a routing clarification) so the answer resolves against the enumerated candidates, but it never enters any task's chat history. When the answer is bound, `turn_bound` references the original request event and clarification turn; the worker handoff includes the exact original action, question and answer. The selected answer remains its own exact user event. Pending clarification is read from persistent turns independently of the history budget, and fallback cannot ask again.

This replaces the free-text `clarification_question` field in the router output schema. The clarify outcome is expressed as a tool call, not a JSON field, which lets the schema enforce the constructive-clarify rule mechanically instead of trusting the model to comply.

Example compound result, for Q10 of the validation sequence below. The current goal is `Socrates development`, its current task is the onboarding alignment, and the GitHub issue task is listed in its task index as `task_2`:

```json
{
  "decision": "compound",
  "goal_label": null,
  "new_goal_title": null,
  "task_decision": null,
  "task_label": null,
  "new_task_title": null,
  "workspace_confidence": null,
  "reason": "The request contains an action on the existing GitHub issue task followed by a distinct dependent security review.",
  "parts": [
    {
      "order": 1,
      "request": "Post the implementation summary and test results on GitHub issue #42.",
      "decision": "resume_existing",
      "goal_label": "current",
      "new_goal_title": null,
      "task_decision": "resume_task",
      "task_label": "task_2",
      "new_task_title": null,
      "workspace_confidence": "high",
      "reason": "Posting the prepared update completes the earlier GitHub issue task.",
      "depends_on": []
    },
    {
      "order": 2,
      "request": "Audit every API endpoint touched by that fix for authentication and authorization problems.",
      "decision": "continue_current",
      "goal_label": "current",
      "new_goal_title": null,
      "task_decision": "create_task",
      "task_label": null,
      "new_task_title": "Security review of issue #42 API changes",
      "new_task_objective": "Audit every endpoint touched by the issue #42 fix for authentication and authorization defects.",
      "new_task_completion_criteria": "Every touched endpoint is reviewed and each finding is evidenced with a fix or an explicit acceptance.",
      "workspace_confidence": "high",
      "reason": "The audit is a new bounded objective within Socrates development that depends on the GitHub fix.",
      "depends_on": [1]
    }
  ]
}
```

The backend validates this result. One repair attempt is allowed for invalid structure. If that also fails:

- with no existing goals, create the first goal;
- with one clearly current goal, continue it;
- otherwise ask the user which subject they mean.

### Router model deployment

The Goal Router is the first phase of every Socrates turn, with its own system prompt and its own two tools; the working agent is the second phase. Which model runs routing is a setting with three values: a small, fast model from the agent's provider (the default), the same model as the agent, or a specific model chosen by the user. The routing contract is identical in every case.

The Goal Router runs on a small, fast model tier by default. The routing task is bounded — pick from at most four candidates plus current, output strict JSON — and a small model handles it well when the input is well-constructed, which is exactly what the pre-rendered sections and `ledger_query` provide. Routing correctness is first-class: a brilliant agent run in the wrong goal produces confidently wrong work, so routing quality is treated as equal to or greater than agent quality.

If the router's output fails validation, or the backend judges the decision low-confidence on an elliptical or compound message, the harness retries once with the main model. This mirrors the compactor's retry-then-fallback pattern.

## Long-running goal routing

A long-running goal remains one goal even when it contains hundreds of tasks and many rounds of context trimming. Goal identity follows the durable outcome, not the size of its history.

Consider a `German` workspace where the current goal is an unrelated file goal but an older open goal is `Ongoing German learning`. The user says:

```text
Okay, let's start today's lesson.
```

Candidate retrieval uses the workspace identity, goal title and note, open-goal status, and the summary of the goal's `30-day-plan.md` anchor. It supplies the learning goal in `KNOWN_GOALS` even if the most recent German lesson is outside `RECENT_EXACT_HISTORY`:

```text
<KNOWN_GOALS>
CURRENT
label: current
title: Build German flashcard exporter
workspace: personal
note: Export script implemented. CSV escaping still needs tests.

OLDER
label: older_1
title: Ongoing German learning
objective: Reach B1 German through daily structured lessons.
note: Covers German lessons and practice toward B1. Day 9 completed dative
      prepositions. Day 10 is next.
anchors:
- 30-day-plan.md — curriculum and lesson sequence
</KNOWN_GOALS>

<CURRENT_USER_MESSAGE>
Okay, let's start today's lesson.
</CURRENT_USER_MESSAGE>
```

The Goal Router itself returns:

```json
{
  "decision": "resume_existing",
  "goal_label": "older_1",
  "new_goal_title": null,
  "task_decision": "create_task",
  "task_label": null,
  "new_task_title": "Complete the Day 10 lesson",
  "new_task_objective": "Work through Day 10 of the 30-day plan: dative prepositions in context.",
  "new_task_completion_criteria": "The Day 10 lesson and its practice exercises are completed and reviewed.",
  "workspace_confidence": "high",
  "parts": null,
  "reason": "Today's lesson is a new task within the ongoing German-learning goal."
}
```

The `reason` is generated by the Goal Router in the same structured result. It is not written by candidate retrieval, the backend, or another agent.

## Decision rules

The router reasons about the outcome, not keyword overlap alone.

- A greeting before a real request does not create a “General conversation” goal; it goes to the `general` task.
- A new verb does not necessarily mean a new goal or a new task: review, fix, test, and verify may be stages of one outcome.
- Mentioning a file used by another goal does not automatically resume that goal.
- A short message such as “fix it” normally continues the current task because its meaning depends on the current exchange.
- A clear reference to an older subject resumes that goal or task even if the current one is unfinished.
- A new lesson, work session, review, fix, test, or deliverable stays in a known goal when it advances that goal's durable outcome; it becomes a new task only when it is independently completable.
- A short or elliptical message such as “let's start today's lesson” must be interpreted against the workspace identity, known goal scopes, continuation notes, and anchor summaries before creating a goal or task.
- If a known goal can reasonably contain the request, prefer that goal. Do not create a narrower goal merely by restating the immediate task. The same preference applies one level down: if the current task can reasonably contain the message, continue it.
- `create_new` requires a genuinely different desired outcome; `create_task` requires a genuinely new bounded objective. Mere uncertainty or weak wording is evidence of neither.
- If one request contains an existing-goal action followed by a genuinely new dependent outcome, return `compound`.
- If the message asks for unrelated deliverables and their order or ownership is unclear, clarify before starting.

## Context assembly after goal and task selection

Router context and working-agent context are separate. The Goal Router receives project-wide evidence to select the owning goal and task. Only after the backend binds the turn to that goal and task does it build the Main Coding Agent's focused context.

The working-agent request has exactly one layout, defined in `agent-harness.md` ("Working-agent context"). It orders blocks from most stable to most volatile for prompt caching: the stable prefix, then goal-stable blocks (`<GOAL>`, `<AVAILABLE_SKILLS>`, `<ACTIVE_CAPABILITIES>`), then chat history, then turn-volatile blocks (`<GOAL_STATE>`, `<CURRENT_TASK>`, optional `<RECENT_ACTIVITY>`, optional `<LANES>`, `<RETRIEVED_HISTORY>`, `<PROJECT_CONTEXT>`, `<CAPABILITY_CANDIDATES>`), and finally `<CURRENT_USER_MESSAGE>`. This section describes how the goal- and task-specific blocks are filled.

For the German example, the selected sections contain:

```text
<GOAL>
title: Ongoing German learning
objective: Reach B1 German through daily structured lessons.
workspace: personal
anchors:
- 30-day-plan.md — curriculum and lesson sequence
</GOAL>

... chat history of the new task (empty on its first turn) ...

<GOAL_STATE>
note: Covers German lessons and practice toward B1. Day 9 completed.
open_tasks:
- t11 Complete the Day 10 lesson — active
</GOAL_STATE>

<CURRENT_TASK>
title: Complete the Day 10 lesson
objective: Work through Day 10 of the 30-day plan (dative prepositions in context).
completion_criteria: The Day 10 lesson and its practice exercises are completed and reviewed.
status: active
note: New task. Day 9 completed dative prepositions.
</CURRENT_TASK>

<PROJECT_CONTEXT>
anchor 30-day-plan.md — goal_plan (124 lines; outline, relevant sections below)
- 30-day plan (line 1)
- Day 1 (line 4)
- … one line per day …
--- 30-day-plan.md › Day 10 (lines 40–43)
## Day 10
Dative prepositions in context: …
</PROJECT_CONTEXT>

<CURRENT_USER_MESSAGE>
Okay, let's start today's lesson.
</CURRENT_USER_MESSAGE>
```

### `GOAL` and `GOAL_STATE`

Goal context is split by how often it changes. `<GOAL>` holds the goal's title, objective, workspace, and anchor manifest, which change rarely and therefore sit before the chat history. `<GOAL_STATE>` holds the goal note and a small index of open tasks, which change from turn to turn and therefore sit after it. Goal context is deliberately concise: the overarching objective, durable user constraints and preferences, anchor manifests, and the open-task index. It does not include other tasks' transcripts.

The goal note is written only through the optional `goal_note` field of the Main Coding Agent's `FinalAnswer`, validated by the harness (see "Final result" in `agent-harness.md`). The Goal Router never writes it.

### `CURRENT_TASK`

The backend supplies the selected task's title, objective, completion criteria, status, and latest continuation note. The note is the short hidden field returned by the Main Coding Agent after the previous turn in this task. It records verified progress, unresolved work, important constraints, and what is likely to matter next. The continuation note is task-local.

### Chat history

Chat history is a mechanical chronological sequence of the turns already bound to the selected task chat, preceded by its active history checkpoint or handover capsule when one exists. It does not include interleaved turns from other tasks or goals and applies no semantic filtering.

It has no separate token cap. Every completed turn of the current task chat is attached in its three-tier shape (N−1 with full tool activity, older turns as Q&A only), presented oldest to newest, until the `160,000`-token compaction trigger fires; size is then managed only by the compaction design in `agent-harness.md`. Exact messages and tool evidence remain in persistent storage even after compaction removes them from the prompt.

### `RECENT_ACTIVITY`

When the turn is bound to the `general` task, the working agent receives the same ledger-derived `<RECENT_ACTIVITY>` notepad the router sees. This is what lets Socrates greet the user with a short recap—"Last time we fixed the checkout flow and finished German Day 10. Want to pick one of those up?"—without any tool call. Turns bound to a real task do not receive it; their goal and task blocks already carry the relevant state.

### `RETRIEVED_HISTORY`

After excluding turns already present in chat history, the backend performs hybrid retrieval over the selected task's older exchanges—those compacted into a checkpoint or held in an earlier chat of the task's continuation chain—and, when specifically relevant to the current request, over the ledger entries of other tasks in the same goal.

Concretely: the current task's exchanges that history no longer shows (covered by the active checkpoint or capsule, or omitted), filtered to the eligible older turn range before ranking or limiting, ranked by the fused keyword and meaning rankings against the current user message plus a small recency boost, at most three; and at most one exchange of another task in the same goal, on a meaning match at the `strong` floor only, because keyword matching across tasks is too noisy. A meaning match on one of a turn's tool calls finds that turn's exchange. Turns of the current message (other compound parts) are never retrieved, and the general goal takes no other task's history. Everything fits `8,000` tokens and is shown oldest first, each labelled `[TURN k — YYYY-MM-DD]` and, for another task, `(retrieved from task gN/tM "Title")`, so that when two exchanges disagree the later one is recognisable as current. Without an embedding index, the block is this task's keyword matches only. The block is omitted when nothing matches.

Hybrid retrieval uses semantic similarity, BM25 or equivalent keyword matching, and recency. It first retrieves compact ledger entries or turn references, then expands only the exact source exchanges or evidence required for the current turn. A summary is never treated as a replacement for its exact source.

This section is therefore different from chat history: chat history is chronological and guaranteed recent; retrieved history is relevance-selected and explicitly excludes what chat history already shows.

A new task begins with clean conversational history. It receives goal context and only specifically relevant evidence from previous tasks. It does not inherit their transcripts. Switching tasks is context replacement, not compaction.

## The ledger

The ledger is the queryable index of everything that happened. It is not a document an LLM writes; it is a SQL-backed projection over the exact event log, and it stores references rather than copying exact content. Each task has one current projection plus append-only revisions that preserve every prior state.

### The goal record

Each goal is one current projection with append-only note revisions. Its title and `objective` (≤ ~40 tokens: the durable outcome, such as "Reach B1 German through daily structured lessons") are proposed by the router when the goal is created and rarely change, so they sit in the goal-stable part of the working context. The goal note (see "Final result" in `agent-harness.md`) records how the goal is going and changes often.

### The task entry

```text
LedgerEntry
  identity
    task_id            backend-assigned
    task_number        permanent ordinal within its goal; rendered as tN
    workspace_id       binding (one task → one workspace, via its goal)
    goal_id            binding (one task → one goal)
    goal_number        permanent global ordinal; rendered as gN
  time
    started_at         harness clock, on task creation
    updated_at         harness clock, on each completed turn
    completed_at       harness clock, on task completion (null while open)
  what
    title              short task title (bounded)
    objective          one line: the bounded outcome
    completion_criteria one line: how the outcome is known to be done (null for harness-fallback tasks)
    status             open | completed | superseded
    continuation_note  verbatim from the Main Coding Agent's latest final result
  pointers
    exchange_refs      → exact user messages + visible responses in the event log
    evidence_refs      → e-* handles for tool calls/results
    anchors_used       → anchor manifests consulted by this task
  derived (harness, mechanical, from the execution log)
    files_changed[]    from edit / apply_patch events
    commands[]         from terminal events
    tests[]            commands classified as test runs + outcomes
    capabilities[]     Skills activated, MCP tools called
```

Rules:

- **Replayable lifecycle events.** Workspace creation includes its canonical ID; chat creation includes its handover reference; turn creation includes its exact user-message linkage; completion includes its response linkage, including shared compound responses. Anchor changes append events atomically. Request ranges reference compound sub-requests without duplicating their exact message bodies. Projection timestamps come from their events. `restoreEvents` rebuilds a new empty store and FTS index without reading the original projections; it rejects incomplete legacy logs atomically rather than inventing missing identities.
- **Append-only revisions, current projection.** Opening a task creates its first ledger revision. Each completed turn appends a new revision and atomically advances the task's current SQL projection; no prior revision is rewritten. A correction is a new turn or task, never a history rewrite.
- **Models propose, the harness disposes.** The harness writes every field. Model-produced content — the router's goal and task binding, the agent's continuation note — passes through harness validation before it is persisted. No LLM ever writes storage directly, so nothing in the ledger can be corrupted by a hallucinating model.
- **Bounded.** Title ≤ ~15 tokens, objective ≤ ~25 tokens, completion criteria ≤ ~35 tokens, note ≤ ~100 tokens, derived lists capped. An entry is roughly 150–285 tokens, which is what makes retrieval arithmetic predictable.
- **Active is derived, not stored.** The active task is the one bound to the most recent turn; every other `open` task is simply unfinished. Switching subjects therefore writes nothing. Completion and reopening are the only status changes, and both append revisions.
- **No content duplication.** The entry holds pointers and one-line facts; the exact text lives only in the event log.
- **Interrupted tasks still get entries.** A task cancelled mid-run is finalized by the harness with whatever note exists, or a mechanical "interrupted after N tool calls" fallback. "What was I in the middle of?" is exactly a notepad question, so a PA's notepad records interrupted work too.
- **Task completion is proposed, recorded, and overridable.** The agent proposes completion in its final result; the harness records it; the user can always reopen the task naturally, and a reopened task continues under the same `task_id`.

### Ledger entries versus history checkpoints

These are different artifacts with different lifecycles, and the vocabulary must not blur them:

| | Ledger entry | History checkpoint (`hc-*`) |
|---|---|---|
| Granularity | One current projection per task, backed by append-only revisions | One per compaction event, spanning many turns of one task |
| Exists because | The task exists | The 160k trigger fired inside that task |
| Written by | Harness (validated model fields) | Compactor LLM (validated by harness) |
| Purpose | Index and retrieval unit | Prompt compaction artifact |
| Read by | Router assembly, `ledger_query`, `context_retrieve`, `RETRIEVED_HISTORY` | Working prompt, `context_retrieve` inspection |

Both cite the same event log; neither duplicates it. A task with no compaction has an entry but no checkpoints; a task with heavy compaction has both, and the checkpoint's `key_evidence` refs resolve into the same evidence the entries point at.

## Task rollover

A genuinely long task — hundreds of turns — would otherwise accumulate many rounds of compaction, and agent accuracy degrades the same way it does in a very long single chat in any harness. The user of a standard harness handles this manually: they request a handover prompt and continue in a new chat. In Zen mode the harness does it automatically and invisibly.

### The rule

A chat holds at most **five compactions**. When the compaction trigger would fire for the **sixth** time in the same chat, the harness performs an automatic rollover instead of compacting (see "Compaction count and rollover" in `agent-harness.md`):

```text
Compaction trigger fires for the sixth time in this chat
→ finish the current safe model step (never mid-tool-execution)
→ generate and validate a full task handover capsule
→ close the current chat
→ create a continuation chat under the same goal and task
→ reset the compaction count
→ continue automatically
```

The Goal Router does nothing. The goal and task are already known; rollover is a deterministic harness operation at a safe boundary. Five compactions is a simple initial rule; it may be tuned later, but no "context health score" is introduced until real usage proves one necessary.

### The handover capsule

The capsule is a sibling of the history checkpoint, not a repurpose of it. A checkpoint is backward-looking ("what happened in these turns"); a handover is forward-looking ("how do I continue this work fresh"). They share validation discipline — harness validates cited turns, unresolved requests are preserved verbatim, evidence refs must resolve — but the schema and prompt differ:

```ts
const TaskHandover = z.object({
  task_objective: z.string(),        // the bounded outcome, restated
  completion_criteria: z.string(),  // how we'll know it's done
  verified_progress: z.string(),
  outstanding_requests: z.array(z.object({
    turn: z.number(),                // project turn where the request was made
    quote: z.string(),              // VERBATIM quote of the unanswered request
  })),
  decisions: z.array(z.string()),
  constraints: z.array(z.string()),
  files_and_tests: z.array(z.string()),
  blockers: z.array(z.string()),
  next_action: z.string(),           // the forward-looking field checkpoints don't have
  key_evidence: z.array(z.object({ ref: z.string(), note: z.string() })),
})
```

The capsule is written by the same model call discipline as a checkpoint: it receives the task (title, objective, completion criteria, continuation note), the prior checkpoint or capsule, the older turns being handed over (everything outside the verbatim window), and the request in flight with its tool activity so far. It is validated like a checkpoint — verbatim outstanding quotes cited to turns of the task up to the current one, resolvable evidence refs, at most `8,000` tokens — and stored under the task's next `hc-N` handle, which checkpoints and capsules share. If the writer fails twice, the harness writes a mechanical capsule from the task record, the prior summary's carried fields, and the derived facts, marks it as mechanical, and records a warning; rollover never blocks the turn. `TaskHandover` also accepts the optional `more_outstanding_turns` field of the checkpoint schema.

A mechanical capsule claims only the prior summary's covered range (or `0/0` without one); newly unprocessed turns remain in a persisted omission range, shown in the prompt and absorbed by the next successful checkpoint, including after restart. Its complete rendered content must fit the configured capsule bound. Outstanding quotes and overflow references stay intact; lower-priority metadata is reduced with an optional `omitted_details` notice pointing to the prior `hc-N` and task for exact recovery. If even the obligation-preserving minimum cannot fit a configured budget, rollover is deferred, existing history stays available, and the normal request ceiling remains the final gate. No oversized capsule is stored.

The capsule is a **system-generated continuation block, never a user message** — the user never wrote it, so it must not masquerade as one. The new chat's context follows the canonical working-agent context in `agent-harness.md`, with the capsule in place of a history checkpoint: the goal context, the capsule, the verbatim history window (the newest ~30k tokens of completed turns, exactly as they were attached), the current user message, and the in-flight turn with its older tool calls linearized and its newest calls intact. Every older exchange remains accessible through `context_retrieve`, and the continuation chat's `continuation_of` link lets the agent reach the previous chat directly.

### Protections

- Never recursively trust summaries as evidence: capsules point back to exact ledger records.
- Preserve unresolved user requests verbatim, under the same bounds as checkpoint `outstanding_requests`.
- Roll over only at safe boundaries — never halfway through tool execution.
- Do not roll over on message count; use actual compaction history.
- The user can always reopen, reassign, split, merge, or correct the task.
- If the objective genuinely expands into independent work, the agent proposes a new task instead of hiding everything inside continuation chats.

### What the user sees

In Zen mode, nothing but a quiet status tag while the capsule is generated:

> Refreshing this long task's context…

In Standard view, the goal shows a linked chain:

```text
Andy Website development
├── Fix homepage hero on mobile
└── Fix homepage hero on mobile — continued
```

The second chat starts with a visible, collapsible card: "Automatically continued from the previous chat after extensive context compression." Both chats retain the same `goal_id` and logical `task_id`, different `chat_id` values, a `continuation_of` link, and an exact `handover_ref`.

### The readers

**Reader 1 — Router assembly (mechanical, no LLM).** Before every router call, the harness queries the ledger and renders: the `<CURRENT_TIME>` header, the `<RECENT_ACTIVITY>` notepad (48h detail, 7-day one-liners), and the `KNOWN_GOALS` candidates via hybrid retrieval over titles, notes, and anchors. The notepad is a query result, never stored prose, rendered fresh per request.

**Reader 2 — The router, via `ledger_query`.** When the message references the past beyond the notepad's windows, the router queries the ledger directly under the caps described under "Router output."

**Reader 3 — The working agent, via `context_retrieve`.** The agent has four bounded actions over the same SQL-backed memory authority: `ledger_search` discovers goals and tasks across `current_goal` or `all_goals`; `search` searches exact Q&A inside `current_task`, `current_goal`, `all_goals`, or an explicit `gN`/`tN`/`gN/tN` target; `inspect` expands one selected record, evidence reference or memory; and `memory` finds what is remembered about the user (`agent-harness.md`, "Memory").

```json
{ "action": "search", "query": "checkout bugs", "target": "current_goal",
  "from": "2026-08-25", "to": "2026-09-01", "top_n": 5 }
```

`ledger_search` returns compact goal/task rows with permanent human-facing selectors and stable pagination. `search` returns exact Q&A previews with short refs, and `inspect` expands them under the normal output bounds. A bare `t4` always means task 4 of the current goal; cross-goal selection requires `gN/tN`. Pure temporal searches need no query text — just a range. The router keeps its narrower, three-call, metadata-only `ledger_query`; the working agent may iteratively search, page, and inspect under the ordinary loop safeguards.

**Reader 4 — Context assembly.** `RETRIEVED_HISTORY` is grounded in the ledger and event log: hybrid retrieval selects the selected task's older turn references (and specifically relevant entries from sibling tasks in the same goal), then expands only the pointed-to exact exchanges. The entry is the retrieval unit; the exchange is the payload.

### `PROJECT_CONTEXT`

This section combines two source classes without confusing them:

1. **Goal anchors** are durable sources that must always be considered for the goal.
2. **Dynamic project sources** are ordinary files or evidence retrieved because they are relevant to this specific task.

An anchor does not mean that the entire file is injected on every turn. The context builder always sees a small anchor manifest containing the path, role, status, and summary, then loads only the relevant sections. For Day 10, it may load the plan outline and Day 10 section rather than all of `30-day-plan.md`.

Dynamic sources are sections of other workspace files, found by meaning in the workspace file index and included only on a strong match with the current request; earlier exchanges and tool evidence arrive through `<RETRIEVED_HISTORY>` instead. Sections are always read from disk as they are now. The exact selection rules and limits are in `agent-harness.md` ("Working-agent context" and "Project files").

## Anchor lifecycle

The Goal Router does not promote files to anchors. The Main Coding Agent may propose anchors in the `anchors` field of its `FinalAnswer`, whose complete schema is defined once in `agent-harness.md` ("Final result"):

```json
"anchors": [
  { "path": "learning/30-day-plan.md", "role": "goal_plan", "reason": "Defines the lesson sequence and expected progress for this goal." }
]
```

The backend validates that the file exists, belongs to the goal, is not temporary or generated output, has a durable future-facing role, does not violate the anchor budget, and does not silently conflict with an existing anchor.

Concretely: the path must resolve to an existing file inside the goal's workspace; paths under dependency, build, cache, repository metadata or temporary folders (`node_modules`, `dist`, `build`, `coverage`, `tmp`, and similar) and log, lock, temporary, and source-map files are rejected; a goal holds at most `8` provisional and active anchors. Changing an anchored file's role or replacing the file occupying a role needs user approval. An autonomous repeat of an existing file-and-role proposal changes nothing. Every rejection is recorded as an operational warning, never shown as an error to the user.

Anchor states are reversible:

```text
provisional → active → superseded
```

The enforcement policy is:

- Explicit user instruction makes the file an active anchor.
- A clearly central, non-conflicting agent proposal becomes provisional without interrupting the user.
- Repeated successful use or explicit user approval promotes it to active.
- Clearly temporary material remains dynamically retrievable.
- Unclear but inconsequential material remains dynamically retrievable; uncertainty alone does not justify a question.
- Socrates asks only when the decision is consequential, such as replacing an existing authority, choosing between competing canonical files, distinguishing a draft from a final source, or carrying sensitive material into future tasks.

Anti-annoyance rules are enforced by the backend rather than left to prompt judgment:

- At most one anchor question may appear in a completed task response.
- Anchor questions appear at the end of work and never interrupt safe progress.
- Multiple conflicts are combined into one question.
- A rejected file-and-role proposal is not asked again unless the file materially changes or the user reopens the decision.
- An ignored question defaults to dynamic retrieval.
- Non-conflicting provisional changes use a quiet, reversible notification rather than a question.

The Agent API returns quiet changes in each part's `anchorChanges`. Trusted application selections use `handle(message, { anchorDecisions: [{ goalId, path, role, decision }] })`, with `approve`, `reject`, or `supersede`; the model never supplies these decisions. For direct text declarations, the harness recognizes a complete sentence such as `I approve PLAN.md as the active canonical goal plan.` or `Use PLAN.md as the canonical goal plan.` Other wording can be resolved through application selections or a specific confirmation; quotations, negations and arbitrary prose do not authorize changes.

Conflicting autonomous proposals produce one combined question appended after the valid final answer. `anchor_question` records the exact files, content hashes and competing anchor IDs. A yes/no response applies only to the immediately following user exchange, when the question's turn supplied the latest visible answer; intervening requests or another part's answer expire it. The proposed file and competing authority are checked again before approval is applied. Rejected or ignored proposals are suppressed for that file/role/hash; a content change or explicit user selection can reopen them. `anchor_decided` and `anchor_revised` preserve this policy across restart and event replay. Explicit removal supersedes a reference without deleting its file.

Repeated successful use is two successful reads of the current file bytes on distinct completed turns after its provisional revision. Multiple reads in one turn and interrupted turns do not count. All automatic promotion and explicit decisions are applied only when accepting a valid, uncancelled final result, in the same transaction as turn completion.

Anchors are goal-scoped context policy, not a new user-facing hierarchy. The product model remains `Workspace → Goals → Tasks → Turns`, with the workspace itself resolved by routing rather than selected by the user.

## Who writes each piece of state

The rule underneath this table is **models propose, the harness disposes**: every model-produced value passes through harness validation before it is persisted, and no LLM ever writes storage directly.

| State | Proposed by | Written by |
|---|---|---|
| Exact user message | — | Harness, immediately on receipt |
| Goal selection | Goal Router | Harness, after validating the label against supplied candidates |
| Task selection (continue / resume / create) | Goal Router, in the same routing result | Harness, after validating the task label |
| New goal objective | Goal Router, only with `create_new` | Harness, after validation and token bounds |
| New task objective and completion criteria | Goal Router, with every `create_task` | Harness, after validation and token bounds |
| Short routing reason | Goal Router | Harness, in the same routing result |
| Workspace binding | Derived from the goal binding | Harness |
| Exact assistant messages | — | Harness |
| Tool calls and tool results | — | Harness |
| Files changed | — | Derived by the harness from tool execution |
| Ledger entry | Continuation note by Main Coding Agent | Harness, created at task open, updated per turn |
| Task completion | Main Coding Agent proposal | Harness records it; user can always override or reopen |
| Active capabilities | Main Coding Agent decisions | Capability runtime, not the router |
| Visible answer | Main Coding Agent | Harness |
| Short continuation note (task-local) | Main Coding Agent, in the same final result | Harness |
| Goal note (goal-level, optional update) | Main Coding Agent, in the same final result | Harness, after validation, as a new goal-record revision |
| Optional anchor proposal | Main Coding Agent, in the same final result | Harness, after validation |
| Anchor status | — | Backend policy, overridden by explicit user direction |
| Handover capsule | Compactor-style LLM call at rollover | Harness, after schema validation |

The Main Coding Agent does not maintain a large `saved_state` object. Its final result contains the visible answer, one short task-local continuation note, an optional goal-note update, an optional task-completion proposal, and only when needed a small list of anchor proposals. The router does not generate facts, files, progress lists, anchor proposals, or active capabilities.

The backend automatically records files, commands, tests, tool results, MCP calls, and Skill activations from the execution log — these become the ledger entry's derived fields.

## Continuation note and compaction

The continuation note is updated by the Main Coding Agent as part of the same final response. It is **task-local**: it describes the current task's progress, not the whole goal:

```json
{
  "full_answer": "I added source references to compacted memory records and the focused tests pass.",
  "continuation_note": "Compaction provenance fix implemented. Recovery now validates source references. Focused memory and compaction tests pass. Next concern is whether any compaction path can still omit source material.",
  "goal_note": null,
  "task_complete": null,
  "anchors": []
}
```

The user sees only `full_answer`. The backend stores every field.

The continuation note does not manage prompt size. History size is managed only by the compaction design in `agent-harness.md` ("Context and compaction"): the three-tier attachment policy shapes each turn, the `160,000`-token trigger fires the history checkpoint and in-turn linearization, and the sixth trigger in a chat performs the rollover above. That section is the single source of truth for compaction; this document does not define a second trimming mechanism.

There is no extra router, summarizer, or state-writer call after the Main Coding Agent. Compaction changes what the next model request sees, not what Socrates stores.

## Per-message lifecycle

```text
User message
    ↓
Persist exact message
    ↓
Harness queries the ledger; renders CURRENT_TIME, RECENT_ACTIVITY, KNOWN_GOALS
    ↓
Goal Router runs (small model, ledger_query + ask_user available)
    ├─ ask_user → question shown → user answers → routing re-runs
    └─ decision: goal + task (continue / resume / create / compound)
    ↓
Bind the turn to the goal and task (and thereby the workspace)
    ↓
For compound: harness announces the split mechanically, then runs parts in order
    ↓
Build the selected task's working context (goal context + task context)
    ↓
Run the coding-agent loop
    ↓
Persist visible answer, task-local continuation note, optional goal note, and tool evidence
    ↓
Harness updates the ledger entry; record task completion if proposed
    ↓
Compaction is task-local; on the sixth trigger in a chat, perform the automatic rollover instead
```

This preserves the product illusion of one seamless conversation while giving every turn a focused backend context.

## Q1-Q12 validation sequence

These natural user messages are the baseline routing test. They are kept as an executable fixture in `packages/router/eval/fixtures.ts`: an oracle replay test proves each expected decision is valid in the exact context the router sees, and `pnpm eval:router` grades a live model on the same messages.

Under the goal/task/chat model, Q2–Q10 are **tasks** — bounded pieces of work inside one durable `Socrates development` goal in the `socrates` workspace. Q2–Q4 are one task, Q5–Q6 another, and so on. Each row tests both decisions the router makes: which goal owns the message, and which task inside it. Q11–Q12 test workspace resolution in a separate scenario.

1. “Hi, how are you?”
2. “Can you review the memory system in Socrates and explain how it currently works?”
3. “What is the biggest architectural weakness in it?”
4. “Fix that and run the relevant tests.”
5. “Does GitHub issue #42 still reproduce against the current code?”
6. “If it does, fix it and draft a concise update for the issue.”
7. “Could that memory fix lose information during compaction?”
8. “How far is our onboarding page from the latest Socrates design in Figma?”
9. “Bring it in line with the design, but keep our existing colour palette.”
10. “Post the implementation summary and test results on GitHub issue #42, then audit every API endpoint touched by that fix for authentication and authorization problems.”
11. “Let's continue the project from yesterday.” (separate scenario, below)
12. “The German one.” (answer to Q11's clarification)

Expected movement:

| Query | Goal decision | Task decision | Selected task |
|---|---|---|---|
| Q1 | `resume_existing` (goal: general) | — | the `general` task |
| Q2 | `create_new` (goal: Socrates development) | `create_task` | Review Socrates memory system |
| Q3 | `continue_current` | `continue_task` | Review Socrates memory system |
| Q4 | `continue_current` | `continue_task` | Review Socrates memory system |
| Q5 | `continue_current` | `create_task` | Investigate GitHub issue #42 |
| Q6 | `continue_current` | `continue_task` | Investigate GitHub issue #42 |
| Q7 | `resume_existing` (goal: current) | `resume_task` | Review Socrates memory system |
| Q8 | `continue_current` | `create_task` | Align onboarding page with Figma |
| Q9 | `continue_current` | `continue_task` | Align onboarding page with Figma |
| Q10 part 1 | `resume_existing` (goal: current) | `resume_task` | Investigate GitHub issue #42 |
| Q10 part 2 | `continue_current` | `create_task`, depends on part 1 | Security review of issue #42 API changes |
| Q11 | `ask_user` (constructive clarify) | — | — |
| Q12 | `resume_existing` (goal: older_1) | `resume_task` (`latest`) | Complete the Day 10 lesson (German) |

### Q1: first message

Router request:

```text
<RECENT_EXACT_HISTORY>
None
</RECENT_EXACT_HISTORY>

<KNOWN_GOALS>
CURRENT
None

GENERAL
label: general
title: General conversation — greetings, small talk, and unrelated quick questions with no task anchor
</KNOWN_GOALS>

<CURRENT_USER_MESSAGE>
Hi, how are you?
</CURRENT_USER_MESSAGE>
```

Result: `resume_existing` with `goal_label: general` — the harness creates the general goal and task on first use.

The Main Coding Agent answers normally and saves a continuation note such as `No technical work is active.` With no prior activity, its `<RECENT_ACTIVITY>` block is empty, so it offers no recap.

### Q2-Q4: one task moving from review to implementation

For Q2, Q1 is recent history and the `general` task is current. The final block is:

```text
<CURRENT_USER_MESSAGE>
Can you review the memory system in Socrates and explain how it currently works?
</CURRENT_USER_MESSAGE>
```

No goal plausibly owns this outcome yet, so the router creates the goal `Socrates development` and its first task, `Review Socrates memory system`. Had the goal already existed, the result would be `resume_existing` with `create_task`.

For Q3, the router sees the exact Q2 pair plus this current-task note:

```text
Reviewed the memory system. Exact exchanges are stored separately from the
short continuation note. Goal selection determines which earlier information
is provided during later work.
```

The final block is:

```text
<CURRENT_USER_MESSAGE>
What is the biggest architectural weakness in it?
</CURRENT_USER_MESSAGE>
```

The router continues the current task because “it” is resolved by the exact Q2 pair.

For Q4, the exact Q3 answer identifies the weakness and the final block is:

```text
<CURRENT_USER_MESSAGE>
Fix that and run the relevant tests.
</CURRENT_USER_MESSAGE>
```

The router continues the same task. Review, fix, and test are stages of one bounded outcome.

### Q5-Q6: GitHub issue task

For Q5, the memory task is current but the final message introduces an independently completable objective inside the same goal:

```text
<CURRENT_USER_MESSAGE>
Does GitHub issue #42 still reproduce against the current code?
</CURRENT_USER_MESSAGE>
```

The router returns `continue_current` with `create_task` for `Investigate GitHub issue #42`. Routing does not load GitHub. Inside the working loop, the agent searches for and activates the necessary GitHub MCP tools.

For Q6, the current task note says the bug reproduced and the latest exact pair identifies issue #42. Therefore:

```text
<CURRENT_USER_MESSAGE>
If it does, fix it and draft a concise update for the issue.
</CURRENT_USER_MESSAGE>
```

continues the GitHub task without requiring the user to repeat its name.

### Q7: natural return to an earlier task

The current task is GitHub issue #42. The memory task appears in the current goal's task index, and its title and note match “memory” and “compaction.”

```text
<RECENT_EXACT_HISTORY>
Newest complete Q&A pairs fitting the 20,000-token router-history budget.
</RECENT_EXACT_HISTORY>

<KNOWN_GOALS>
CURRENT
label: current
title: Socrates development
workspace: socrates
note: Hardening the Socrates harness: memory, compaction, and open GitHub issues.
tasks:
- current: Investigate GitHub issue #42 — open; reconnect fix implemented, issue update drafted
- task_1: Review Socrates memory system — open; provenance fix implemented, focused tests pass
</KNOWN_GOALS>

<CURRENT_USER_MESSAGE>
Could that memory fix lose information during compaction?
</CURRENT_USER_MESSAGE>
```

Result: `resume_existing` with `goal_label: current`, `task_decision: resume_task`, and `task_label: task_1`. The Main Coding Agent then receives the memory task's chat history, not the GitHub task's.

### Q8-Q9: Figma onboarding task

Q8 creates the task `Align onboarding page with Figma` in the current goal. The working agent—not the router—uses `capability_search` and `capability_control` to obtain only the relevant Figma MCP tools.

Q9 continues that task because “it” and “the design” are resolved by the exact Q8 pair. The requirement to preserve the existing colour palette is part of the exact current user message and later continuation note.

### Q10: compound request

The router sees the onboarding task as current and the GitHub issue task in the current goal's task index. The exact current message remains one final block:

```text
<CURRENT_USER_MESSAGE>
Post the implementation summary and test results on GitHub issue #42, then audit every API endpoint touched by that fix for authentication and authorization problems.
</CURRENT_USER_MESSAGE>
```

It returns two ordered parts (the full JSON appears under "Router output"):

1. Resume the GitHub issue task and post the already-prepared summary and test results.
2. Create the task `Security review of issue #42 API changes`, depending on part 1, and pass only the relevant files, verified results, and exact supporting evidence from the GitHub task.

The exact user message is stored once and linked to both tasks; it is not duplicated in storage.

### Q11-Q12: ambiguous temporal reference and constructive clarify

These extend the fixture with the workspace-resolution behavior, in a separate scenario: yesterday the user worked on three goals across two workspaces, most recently Website X.

**Q11** — the user says:

```text
Let's continue the project from yesterday.
```

The notepad shows all three, so the router does not guess on a mutating request. It calls `ask_user`:

```json
{
  "question": "Yesterday you worked on three things — which should we continue with?",
  "candidates": [
    { "label": "Website X", "detail": "checkout flow fix, most recent", "suggested": true },
    { "label": "German lessons", "detail": "Day 10 lesson, dative prepositions — in progress" },
    { "label": "UFC chat", "detail": "fight discussion" }
  ],
  "allow_new": true
}
```

**Q12** — the user answers "The German one." The answer re-enters the router as a normal message; the candidates are now in recent exact history, and the German goal is supplied as `older_1` with its most recent task labelled `latest`, so it resolves trivially:

```json
{
  "decision": "resume_existing",
  "goal_label": "older_1",
  "new_goal_title": null,
  "task_decision": "resume_task",
  "task_label": "latest",
  "new_task_title": null,
  "workspace_confidence": "high",
  "parts": null,
  "reason": "The user selected the German goal from the enumerated candidates; its Day 10 lesson is still in progress."
}
```

The working agent runs in the `personal` workspace with the German goal's context and the Day 10 task's chat history. The banner shows the resolution; because the user explicitly confirmed, the first-mutation gate is disarmed for this task.

Had the user picked the suggested Website X instead, the router would return `continue_current` with `continue_task`, because the most recently worked goal is the current goal.

A variant worth testing: Q12' — the user answers "actually, something new." With `allow_new: true` the router returns `create_new`, and the harness surfaces the one lightweight workspace decision at the first mutating action.

## T1-T10 task-boundary validation sequence

Goal routing (Q1–Q12) decides *which goal* owns a message. Task routing decides *which chat inside that goal* owns it. This is the higher-risk decision — too eager and Standard view fills with micro-chats; too lazy and tasks bloat into the long-task problem. These fixtures live alongside Q1–Q12 in `packages/router/eval/fixtures.ts`.

All T-fixtures assume the current goal is `Andy Website development`:

| # | Message | Expected task routing | Why |
|---|---|---|---|
| T1 | "Fix the homepage hero on mobile" | `create_task` | New bounded objective |
| T2 | "Make the heading smaller" | `continue_task` (T1) | Advances T1's objective |
| T3 | "Test it on an iPhone-sized viewport" | `continue_task` (T1) | Elliptical, recency default |
| T4 | "The image still overflows" | `continue_task` (T1) | Blocker on T1's output |
| T5 | "Now fix the mobile navigation menu" | `create_task` | Different component, independently completable |
| T6 | "What file was that again?" | `continue_task` (T5) | **Recency default** — "that" resolves to the most recent task, not T1 |
| T7 | "Who won the UFC fight last night?" | `general` task | No subject, no task anchor |
| T8 | "Actually go back to the hero, it regressed" | `resume_task` (T1) | Explicit subject overrides recency |
| T9 | "Hi, how are you?" (first message ever) | `general` task | Zero history, trivial start |
| T10 | "Post the summary on issue #42, then audit the touched endpoints" | `compound`, two tasks | Two bounded objectives, dependent |

**T6 is the single most important fixture entry.** Most real traffic is short, elliptical, and unanchored; the recency default is the workhorse rule of the task layer. A router that gets T6 right gets daily usage right.

**T8 tests the override boundary**: how explicit must a reference be to beat recency? "Go back to the hero" clearly qualifies; "the other thing" does not (→ current task or clarify). The exact calibration is an evaluation question, not something to over-specify now.
