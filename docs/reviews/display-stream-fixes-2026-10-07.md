# Search overlay and repeated answer stream

## Confirmed causes

The work row's inline `row-detail` label shared a class with the globally loaded Database row drawer. Opening a search group turned “in Work” into a fixed 576-pixel-wide, full-height panel. Chrome reproduced it at 1470 × 745; sticky notes remained above it because of their stacking order.

The recorded resume-inspection run returned an invalid final object: two anchor roles exceeded 60 characters and all three anchors omitted `reason`. Its repair was a real second model request. Both requests contained exactly the same 5,233-character visible answer; the ledger contained one accepted answer, but both calls streamed that answer to the page.

## Changes

- Namespace the Database drawer as `db-row-detail`, leaving work-location labels inline and retaining the drawer's existing appearance.
- Keep repair response text off the public draft stream. Retain provider streaming, complete call records, timing, usage and thinking; save the validated result once. Stop during repair retains the candidate the user actually saw.
- State the existing anchor role/reason bounds explicitly in the working prompt.
- Cover retries, metadata repair, repair thinking, cancellation and ignored late callbacks in agent tests; cover a live WebSocket client and a reconnecting client, one saved answer and recorded streamed repair timing in server tests.
- Close the live server before its runtime in the existing retention test, eliminating a timer that could query an already closed ledger.

## Browser verification

Used an isolated local Runtime/Fastify/WebSocket fixture with deterministic model responses, synthetic Markdown data and embeddings. No private resume content was sent to any provider. The fixture paused at search, first-answer draft, repair draft and repair completion.

- Before the fix, the repair replaced the first answer with a second truncated answer beginning “Verified: the Work”. After the fix, the full first answer remained throughout repair, including after reload; only the validated corrected answer was saved.
- Flow and Standard search labels: `position: static`, 48 × 18 pixels. No fixed drawer and no document overflow. Verified desktop and 390 × 844 phone rendering.
- Database row inspector: still `position: fixed`, 576 pixels wide and viewport-height, showing every field. Opening and closing it works.
- Stopping during repair at phone width retains the visible candidate with “Stopped.”, `data-live=false`, including after reload.
- Premium styling, paper notes, typography and spacing are retained.

Ignored local evidence: `.socrates/reviews/display-fixes/after-search.png`, `after-phone-search.png`, `after-repair-paused.png`, `after-database-drawer.png`. The disposable fixture and provider-call log are in the same ignored directory.

## Validation

Typecheck and production web build passed. The initial full run encountered six timing/process timeouts under concurrent load; the six affected files passed on a single-worker rerun with a 30-second test allowance. The final full suite passed: **70 files, 774 tests**, with no unhandled errors, using `NODE_OPTIONS=--disable-warning=ExperimentalWarning pnpm exec vitest run --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000`.

Restarted the idle V2 app with the normal launcher and refreshed Chrome's session. Both existing user messages and answers, two goals, two tasks and two turns remain intact. V1 data and `main` were not modified. The disposable fixture was stopped after verification; the V2 app remains listening on port 4200.
