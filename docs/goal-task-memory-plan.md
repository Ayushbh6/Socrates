# Memory per goal, then per task (agreed 2026-10-18)

**Asked:** "Memory is segregated per goal and then further per task." Socrates writes it itself, in the background, in its own data folder, and reads it while it works. Trial log entry 79.

## What was there

- **Facts about the user** (`memory_saved`, one line each): everywhere or one goal. Ledger only, no file.
- **Work memory** (M4a, entry 59): keyed by the goal's **folder**, `~/.socrates-v2/memory/projects/<folder id>/`. Goals that share a folder share one memory (all three of the user's real goals point at `Documents/Work`); General and goals without a folder have none. Nothing had been written in the user's data (checked 2026-10-18), so nothing moves.

## The agreed design

```
~/.socrates-v2/memory/
  you.md                              facts about the user (mirror of Settings > Memory)
  goals/
    general/                          General: one memory for every day, topics by subject
      MEMORY.md
      topics/<name>.md
    g4-socrates-development/
      MEMORY.md                       goal index: one line per topic
      topics/<name>.md                lessons for the whole goal
      tasks/
        t2-routing-review/
          MEMORY.md                   task index
          topics/<name>.md            lessons for this task only
```

- Every goal has its own memory, whether or not it has a folder and whatever folder it shares. Every task has its own memory inside its goal.
- The ledger stays the source (`work_memory_written`); the files mirror it and follow renames.
- **Reading:** each request shows the current task's index and its goal's index; topics are opened when they bear on the work. `context_retrieve memory` also searches the goal's other tasks (used when the decider says to look first).
- **Writing:** unchanged in shape. After the answer is saved, the decider reads the whole finished turn; at 0.5 or more the same agent, with only the memory tool, writes the notes in the background. The chat never waits. Steps run one at a time per goal.

**Choices agreed with the user:**

1. A lesson goes to the task first, and moves up to the goal when it applies beyond that task (for example the same lesson in another task of the goal).
2. Task memory is not the continuation note: the note says where the work stands; memory holds lasting lessons and decisions.
3. General has one memory folder (not one per day), organised by subject topics like any goal.
4. The decider is asked after every finished conversation, not only after a change or command (phase 2). It stays after the answer, in the background and invisible; the user preferred this to holding the answer.
5. A turn that is redone in another task loses the memory it wrote.

## Phases (one at a time)

1. **Split and files:** store per goal and task, the folder layout above with `you.md`, show the goal's and task's index while working, the writer chooses task or goal and can move a topic up, a queue per goal, redo removes, retire the per-folder version. Eligibility stays "a change or command succeeded", now in any goal.
2. **Save more often:** ask the decider after every finished turn (its question and labelled examples re-tested so it does not save noise).
3. **See it in the app:** Settings > Memory lists memory by goal, then by task.
