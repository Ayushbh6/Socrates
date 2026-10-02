# Tools stage: review fixes

The review of the tools stage at `3c4716a` reported four P1 and ten P2 findings, plus capability scaffolding gaps. Every finding is fixed, covered by a regression test in `packages/tools/test/review-regressions.test.ts` (and `packages/shared/test/tokens.test.ts` for the tokenizer), and the architecture is updated where the behaviour is specified. The reviewer's own reproduction script was re-run against the fixes: all seventeen cases now behave correctly.

## Findings

| # | Finding | Fix |
|---|---|---|
| P1-1 | Cancelled calls could still mutate files or leave services running | The runner refuses a cancelled call before it starts and after an approval it waited for; `edit` and `apply_patch` check again just before writing; a cancelled background launch or readiness wait stops the process |
| P1-2 | `apply_patch` overwrote a user edit made during its commit | One mutation lock per workspace shared by all runners; each file is rechecked immediately before it is touched; new files are linked into place (never overwrite); rollback never overwrites a file that changed again and names it |
| P1-3 | Background descendants escaped supervisor cleanup | When a command's shell exits, processes left in its process group are stopped (SIGTERM, then SIGKILL); shutdown and process exit also kill lingering groups |
| P1-4 | A symlink alias bypassed `.git` protection | Paths resolve to their real target before every policy check; observations use the canonical path, so aliases cannot split a stale-edit record |
| P2-5 | `replace_all` applied the first match's indentation everywhere | Indentation shift computed per occurrence; a non-uniform shift fails with `old_text_indentation_mismatch` |
| P2-6 | Positive globs reincluded ignored files | Globs filter ripgrep's ignore-respecting file list (picomatch) instead of overriding ignores; `--no-require-git` applies `.gitignore` outside git repositories |
| P2-7 | Date filters ran after the 500-row cutoff | Q&A date bounds (in the user's time zone, DST-correct) are in the SQL query; ledger search applies all filters while collecting; a capped set says so |
| P2-8 | Ledger search missed derived facts | Task index includes derived files, commands, tests, capabilities and the workspace; refreshed when facts arrive; exact search covers facts, workspace and anchors |
| P2-9 | Large foreground output lost its beginning while reporting no loss | Foreground commands retain sixteen million characters; any loss is reported with `output_lost` and the dropped count |
| P2-10 | `inspect` exceeded 50 KiB | One limiter bounds every `context_retrieve` result (lines, bytes, tokens) with explicit omissions; goal anchors scale with the view |
| P2-11 | Tokenizer chunking split surrogate pairs | Chunks end on code points; truncation always returns an exact prefix or suffix; counts measured against the canonical encoder (exact without long runs, only over-counted on them) |
| P2-12 | Terminal `read` skipped the middle of an oversized line | Long lines are paged through in pieces; `truncated` reflects remaining output |
| P2-13 | Exact search missed identical non-ASCII text | Exact matching folds both sides the same way in JavaScript (NFC + lowercase) |
| P2-14 | Test outcomes vanished when a run became a session | The test outcome is derived from the session's exit event and recorded for the launching task, exactly once |

## Capability scaffolding

| Gap | Fix |
|---|---|
| Activated MCP tools returned `unknown_tool` | Calls to an active public name go through the same runner (validation, corrective errors with the server's full error kept as `failure_detail`, bounded results, evidence, capability facts) via `CapabilityCatalog.callMcpTool` |
| A new runner lost active definitions | `CapabilityRuntime` rehydrates active MCP tools from the catalog, records a changed schema as a replacement, and leaves out tools it cannot reach |
| Skill bodies were not reusable | `activeSkills(goalId)` returns active Skill instructions revalidated by content digest, reporting changed ones as stale |
| Public names could collide | Names that had to be rewritten, contain `__`, or are too long get a hash of the exact identity |

A real MCP client and real Skill sources remain the capabilities stage.

## Verification

- `pnpm typecheck`: passed.
- `pnpm test`: 194 passed in 12 files (two consecutive runs; no leftover processes).
- `git diff --check`: passed.
