# T1, M4a and G1 implementation review — 12 October 2026

**Verdict: changes requested.** The agreed architecture is substantially implemented, but six reproducible correctness gaps remain in output retrieval, incomplete-output disclosure and managed-memory recall/control. These need focused fixes rather than a redesign.

Reviewed `socrates-v2` through `0f4228f`, against baseline `4b64bc3`. A fresh fetch confirmed the local branch matched `origin/socrates-v2`. Read the current `AGENTS.md`, the complete agreed `docs/terminal-output-and-memory.md`, trial-log entries 56–60, implementation commits `7e319be`, `e0bf74f`, `53ad040`, their tests/evals, and the supplied final agent response. Earlier General-continuity work is the baseline, not a newly audited implementation in this report.

## Findings

### 1. [P2] Saved-output search silently misses the suffix of very long lines

**Location:** `packages/tools/src/output-archive.ts:242–249`.

`eachLine` splits very large lines into chunks. The search accumulator stops accepting chunks once its existing length exceeds 4,000 characters, but later reports the whole line as scanned. Consequently a literal match in a later chunk returns no hits without a partial-search warning.

**Reproduced:** archive `"x".repeat(4 * 1024 * 1024) + "HIDDEN-REVIEW-MARKER\n"`. Confirm the marker exists in `output.log`. Searching for it returns `{ hits: [], more: false, scanned_lines: 1 }`.

This affects large JSON, generated/minified content and other single-line command output. Searching saved evidence can falsely tell the agent the evidence does not exist.

**Fix:** separate search coverage from excerpt size. Search every chunk, handle matches crossing chunk boundaries, and return bounded match-centred excerpts. Define equivalent coverage or explicit limits for regex searches. Add a regression with a match after the first chunk and another spanning a chunk boundary.

### 2. [P2] Paging skips the unread remainder of an oversized line

**Location:** `packages/tools/src/output-archive.ts:210–218`.

When the first line exceeds a page budget, `readLines` truncates it and returns `next_line = line + 1`. Following that cursor skips the rest of the line. The API provides no within-line continuation offset.

**Reproduced:** archive `"x".repeat(100000) + "MIDDLE-REVIEW-MARKER\nEND\n"`, then read from line 1 with a 500-token budget. The first page omits the marker and returns line 2; the second page contains only `END`. Repeating the line-1 request returns the same prefix. Search excerpts also take the start of the line, so they are not a general substitute for reading its omitted contents.

**Fix:** add a bounded continuation cursor within a line, or another explicit way to address its remaining text. Do not advertise the next line as the continuation until the current one has been consumed. The existing long-line test asserts advancement to line 2; it needs to verify recoverability, not just bounded output.

### 3. [P2] The evidence viewer hides archive capture gaps

**Location:** `apps/server/src/app.ts:339–360`; rendering in `apps/web/src/components/EvidenceViewer.tsx:47–50`.

The evidence endpoint reads the saved text but drops archive metadata such as `complete` and `gap`. Its `truncated` flag only describes the viewer's 200,000-character display limit; `outputLost` only reads the older result flag. A partly saved archive can therefore look complete in Inspect.

**Reproduced:** create a short retained archive with `gap = "cap"`, and a tool result explicitly recording `output_saved: "partly: saving stopped at the size limit for one output"`. `/api/evidence` returns the retained prefix with both `truncated: false` and `outputLost: false`. The current viewer consequently renders neither warning.

**Fix:** expose capture completeness and its reason separately from display truncation, and render the warning even for short retained output. Cover size-cap and interrupted-capture cases. This concerns the existing evidence viewer; it does not require the deferred T2 viewer.

### 4. [P2] Turning memory saving off during the background decider still permits writes

**Location:** `packages/agent/src/socrates.ts:896–905`.

The save setting is checked before awaiting `gate.readWork`. After that await, only cancellation is checked. The writer callback also does not check the current setting. A user can disable saving while the decider is running and still have a new durable memory written afterwards.

**Reproduced:** hold the work-decider promise, finish the visible answer, set the memory setting to `save: false`, then resolve the decider with 0.9. The restricted follow-up still saves the scripted `lesson` topic.

**Fix:** recheck after asynchronous decisions and immediately before each write; skip or cancel active work-memory jobs when saving is disabled. Test both an in-flight decider and an in-flight writer response. Previously completed writes should remain unchanged.

### 5. [P2] Background memory writes do not refresh the semantic index

**Location:** `packages/agent/src/socrates.ts:904–908`; existing turn-level sync at line 572.

The only semantic-sync request in this class runs as the foreground handle finishes. The asynchronous writer can persist its topics later without scheduling another sync. If that first sync finishes before the write, new topics stay absent from semantic retrieval until a later unrelated sync, such as the end of another turn.

**Reproduced:** hold the background decider and use a semantic-sync observer that snapshots stored topics. Finishing the foreground turn schedules one sync with no topics. Release the decider and await the writer: the topic exists in the ledger, but no further sync is requested.

The index block, direct topic reads and lexical search can still work. The defect specifically affects semantic discovery, including paraphrases and topics no longer listed in the index.

**Fix:** schedule semantic sync after durable work-memory writes, including writes made before a later failure. The existing scheduler can coalesce requests. Add a test where the initial sync completes before the background write and the next turn recalls the new topic by meaning.

### 6. [P2] Other projects can crowd the current project's topics out of semantic recall

**Location:** `packages/tools/src/tools/context-retrieve.ts:491–495`.

Topic search retrieves the best 20 semantic hits across all projects, then filters them to the current project. Twenty stronger matches elsewhere can discard a relevant local topic before project scoping is applied. With no keyword overlap, retrieval returns no topic even though a suitable local semantic match exists.

**Reproduced:** seed a current-project topic using `automobile repair`, query `car maintenance`, and supply a semantic result pool of 20 other-project hits. The captured query filters contain only kind, limit and similarity threshold; the current project's topic is absent from the result. This is a recall-starvation defect, not a demonstrated cross-project disclosure.

**Fix:** apply project scoping before ranking and limiting, using source IDs or a project filter. Add a regression with more than 20 competing other-project topics and a relevant local topic without lexical overlap.

## What matches the agreed plan

| Area | Assessment |
| --- | --- |
| T1 storage | Per-run output IDs, app-owned files, bounded previews, origin labels, restart cursor checks, retention and older-event compatibility are implemented. Retrieval and loss disclosure need the fixes above. |
| M4a storage | Ledger-backed index/topics, app-home mirrors, Git worktree identity and separation from user-owned repository notes are implemented. General remains outside project work memory. |
| M4a writer | The answer is saved before a restricted background writer runs; writes are serialized per project and their outcomes recorded. Settings and semantic-index timing need correction. |
| G1 | Equivalent-route normalization, the strict creation guards, grounding instructions, routing fixtures and Inspect counters are present. No additional concrete G1 code defect was established in this review. |

The final plan deliberately narrowed the original draft. T2's dedicated viewer/export/pinning/stream provenance/disk-pressure work and M4b's restart-safe jobs, Settings revision management and efficacy measurement are deferred, not missing acceptance criteria. The recorded choice to page through `terminal_control read output` rather than new `context_retrieve` parameters is also intentional.

## Verification performed for this review

- `pnpm typecheck`: passed.
- `pnpm test -- --maxWorkers=1 --testTimeout=15000`: **974 passed, 1 skipped**, 106 passing files and one skipped file.
- `pnpm --filter @socrates/web build`: passed.
- Five additional disposable deterministic checks reproduced the six findings above; the settings/sync check covers two findings. These checks assert the defective current behavior, so their passing is evidence of reproduction, not evidence of a fix.
- Opened the built app in a separate synthetic instance on port 4357. Verified the Long terminal output and Router retries panels rendered, with fixture counts of one long output and three routed messages/one repair/one normalization. No browser console errors were returned. This was a desktop synthetic-state UI check, not a live-model replay or exhaustive responsive audit.
- No live user ledger, credentials or production configuration were changed. Temporary tests, server, data and browser tab were cleaned up after verification.

## Limits of the historical live evaluations

The trial logs and supplied agent response are consistent, but their model runs were not independently repeated during this review.

- **T1:** the log reports correct answers at both preview sizes, but also admits the model reran commands or decoded fixture source. Answer accuracy does not establish that saved-output retrieval was used correctly. Strengthen the eval to assert retrieval, prohibit duplicate side effects, and use evidence the model cannot obtain from the fixture source.
- **M4a:** the retained report describes successful topic creation, reuse and a later topic read. Some script success criteria are weaker than those observations: optional later writes and index visibility do not independently prove topic inspection or semantic recall. Add explicit assertions for those behaviors.
- **G1:** reported router results improved from 51/72 to 59/72, with repairs falling from seven to four; identical runs vary by about six decisions. The three-copy historical replay reported follow-up misroutes improving from 1/3 to 0/3 and repairs from 5/6 to 1/6. These small samples support improvement, not elimination.
- The router still sometimes answers General-history questions in prose, requiring a repair; Q5–Q10 project-flow misses remain. One time-description error remained in the new replay. The Amsterdam inference did not recur in either old or new replay, so that specific fix is unproven. The other agent disclosed these limits rather than claiming perfect results.

## Recommended closure

Fix output search/paging and capture-gap disclosure first, then the memory setting race, post-write indexing and pre-ranking project scope. Keep these distinct from deferred feature work. Add the described regressions, rerun the existing suite/build, and strengthen the isolated live evals before claiming end-to-end reliability. No model replacement or broad architecture rewrite is justified by these six defects alone.

This review adds no implementation changes.
