# W1/W2 and T1–T3: review and closure

Reviewed on 2026-10-04 in the Documents Socrates checkout, on `socrates-v2`, starting at `5c01207`. Baseline: 577 passing tests and clean typechecks. Scope includes W1 `76f65eb`, W2 `ddac796`, T1 `9fff4e9`, T2 `b939f5b`, and T3 `5c01207`, against `architecture/web.md`, `architecture/server.md`, and the agent/provider contracts.

**W1, W2 and T1–T3 are closed for their defined scope.** This review fixes the implementation gaps below and verifies the providers, agent drafts, server transport, history, and both displays together. Retaining a partial answer on Stop remains the separate T4 proposal. No ledger migration or history rewrite is required.

## Gaps fixed

| Gap | Result |
|---|---|
| Late model callbacks could revive a stopped, failed or completed draft. | Each agent request closes its callback; the hub rejects inactive runs/turns. The page retains settled request watermarks and ignores stale, shorter and completed-turn drafts. |
| A state message advanced the resume cursor before replay had been applied. | Only activities advance that cursor. Disconnecting during replay can no longer skip the remaining events. |
| A replay reset reloaded history while live delivery continued, overwriting current activity/drafts. An old unfinished message could repeatedly exceed the replay window. | Recovery pauses the connection, reads a snapshot and reconnects from its cursor. History carries turn IDs, ordered narration/tool previews/decisions and per-item snapshot boundaries. Already represented events are ignored; the current drafts are requested again. |
| A handed-off turn had no lane exchange for its first draft and could lose its task label. | Its handoff activity identifies the lane and exact goal/task; the lane exchange exists before the draft arrives. Main is no longer shown working on a part already handed away. |
| Loading an older history page enabled following and jumped to the bottom. | Only a new latest question enables following. Prepending history preserves the reading position; duplicate loads are coalesced and failures are reported with retry available. |
| Opening a lane changed the main panel width; browser scroll anchoring was mistaken for the reader scrolling up. | Following distinguishes reader input from layout scroll events. Main and every lane remain at the end during layout changes, while wheel, keyboard and touch scrolling up stop following. |
| Flow reused prose state between different questions and stayed on history after a new send. | Answer views are keyed by exchange, retaining the draft-to-answer element within a question. A successful send returns to the latest question. |
| Reduced-motion changes were captured only when prose mounted. | A changed system preference applies to the open answer. Reveal documentation describes progressive catch-up rather than promising a fixed 200 ms duration. |
| Enter cleared text when disconnected; mode/conversation switches lost unsent text. Rejected queue commands could disappear silently. | Drafts belong to their conversation, survive mode switches/reconnects, and clear only after a ready connection accepts the send. Queue rejection preserves the question and restores an empty composer without overwriting a newer draft. Other command failures are reported. |
| Choosing a pasted folder without Enter selected the previously browsed folder. Navigation requests could arrive out of order. | Choose validates the typed path directly, including `~`; only the latest navigation updates the listing, and pending selection cannot navigate elsewhere. |
| Nested Escape closed both the folder picker and settings; dialog focus escaped into the page. | Only the top dialog handles Escape; focus is contained and restored. The evidence viewer also ignores obsolete fetch results. |
| Other tabs could retain stale model/settings labels when readiness changes raced. | Live state includes the public settings snapshot, and refreshes use the latest request. Key values remain excluded. |
| Gemini could emit thought text as a public draft, fail on an empty content array, lose tool-argument fragments without a stop event, or complete despite a coalesced cancellation. Heartbeat bytes did not refresh the idle timer. | Only model output streams publicly; native thought data stays in replay. Empty content and argument completion are handled, cancellation is checked between events, each received byte chunk refreshes the idle guard, and the reader lock is released. |

## Automated validation

- `pnpm typecheck`: passed for the root and web app.
- `pnpm build:web`: passed.
- `NODE_OPTIONS=--disable-warning=ExperimentalWarning pnpm exec vitest run --maxWorkers=2`: **595/595 tests across 51 files passed**, including **18 new regressions**.
- `git diff --check`: passed.
- Added coverage checks actual cancellation/retry callbacks, settled/stale drafts, handoff association, snapshot/replay recovery, cursor ordering, cross-tab settings, queue rejection/fallback, history output and provider byte streams. Existing server security, approvals, lane lifecycle, process recovery and web serving coverage remains green.

## Real providers

All requests used configured keys in memory and disposable synthetic input. Plain and streamed tool round trips each verify the tool arguments, replay of the provider-native assistant message, the synthetic tool result, final text, and a longer multi-piece stream.

| Endpoint and model | Result |
|---|---|
| Gemini Interactions `gemini-3.8-flash` | Passed plain and streamed tool round trips; longer reply arrived in 3 text pieces. |
| OpenRouter `z-ai/glm-5.3-flash` | Passed plain and streamed tool round trips; longer reply arrived in 25 text pieces. |
| Direct DeepSeek `deepseek-v4-pro` | Passed plain and streamed tool round trips; longer reply arrived in 50 text pieces. |
| Direct DeepSeek `deepseek-flash` | Passed plain and streamed tool round trips; longer reply arrived in 50 text pieces. |
| OpenAI | Attempted; endpoint rejected the configured credentials. Mocked transport tests pass. |
| Anthropic | No configured key; SDK stream transport tests pass. |

The model identifiers were verified against the providers' live model catalogs. References: [OpenRouter GLM 5.3 Flash](https://openrouter.ai/z-ai/glm-5.3-flash), [DeepSeek API](https://api-docs.deepseek.com/api/create-chat-completion/). Credentials were not changed to repair the OpenAI rejection.

## Browser validation

The built app was checked in the in-app browser using separate test homes. Controlled streams made lifecycle and timing cases repeatable; real providers then exercised the full routing/agent/tool path.

- **Real GLM, Flow:** GLM 5.3 Flash handled both routing and chat, created a goal/task in the synthetic workspace, ran glob/read tools, showed narration, and streamed a 2,323-character answer. The answer remained one prose element at completion; the canvas stayed at the bottom. A request that initially lacked a current goal asked a clarification, as expected.
- **Real DeepSeek, Standard:** direct V4 Pro handled routing and chat, read the synthetic file again and completed a 3,421-character answer. The answer and tool evidence were visible with the thread at the bottom.
- **Real DeepSeek Flash, Stop:** direct Flash handled routing and chat. The answer was observed growing at 22 characters, with the thread within 0.5 px of the bottom. Stop removed the draft and displayed `Stopped.`; no partial answer was saved. A later request completed normally using the previously read synthetic record.
- **Real Gemini, Flow:** observed the first draft at 74 characters while the working orb docked, then an 8,237-character completed answer with the orb at about 37 px. Gemini was the real chat provider in this fixture; its router was controlled. Provider-native tool replay was checked independently above.
- **Controlled Standard following:** text grew from 725 characters with the view within 0.5 px of the bottom. After scrolling up, it grew from 1,318 to 1,753 characters while scrollTop remained exactly 38,303.
- **Controlled parallel main/lane:** opening a lane while main streamed left main within 0.5 px of the bottom and the lane at 0 px. Both answers grew independently. Each panel could be stopped independently.
- **Reload/reset mid-answer:** with the server replay window deliberately reduced to two events, a reload during a long answer recovered the snapshot/current draft and displayed one copy. This exercises the reset path as well as joining late.
- **History and Flow:** loading earlier questions preserved a position away from the bottom. Selecting the old GLM answer displayed all 2,323 characters immediately; sending a new question removed the history notice and displayed the new question.
- **Composer:** unsent text survived Flow → Standard → Flow and remained scoped to its conversation.
- **Approval/evidence:** an edit displayed the exact before/after preview, waited for approval, and returned a coloured diff in the full-output dialog. The synthetic file changed only after approval.
- **Settings:** saving a changed model updated the other open page's composer label. Shift+Tab stayed inside settings; Escape from the nested picker left settings open and restored focus.
- **Folders:** a pasted project path followed directly by Choose selected that exact folder without Enter.
- **First run:** an empty test home showed setup. Saving a dummy, nonfunctional credential transitioned to the welcome/chat screen without making a model request.
- **Phone, 390 × 844:** Flow's composer measured 358 px and notes were hidden; Standard's main/lane panels stacked at 366 px. Both pages measured 390 px with no horizontal overflow. The viewport override was reset.
- Browser error/warning logs for the real-provider run were empty.

Screenshots and local synthetic fixtures are retained under the ignored `.socrates/reviews/web-streaming/` directory: `parallel-streams.png`, `real-glm-flow.png`, `real-deepseek-standard.png`, and `real-deepseek-flash-stream.png`. The real-provider runtime used actual provider factories for both routing and chat; only embeddings used a deterministic test implementation. No claim of a live embedding-service check is made.

No real provider key was written to any test home. The first-run home contains only the explicit dummy credential. Test servers were stopped, the real-provider ledger was checked for cancellation persistence, and the temporary browser tabs were closed. The closure is committed locally on `socrates-v2`; no push or work on `main` is part of this review.
