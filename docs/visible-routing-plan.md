# Routing you can see: the plan (2026-11-08)

Today routing is a hidden pause. While it runs, the page shows stage labels ("Finding the goal and task…"); afterwards it shows only where the message went. The router's thinking is thrown away, and its reason is shown only in Inspect, and only when routing failed. The user wants routing to read as the first step of one piece of work, the way a human assistant takes a second to place what you said: Socrates thinks about where the message belongs, says so, then works.

This plan keeps two model calls (router, then worker) and shows them as one trail. Merging them into one call would put every goal into the worker's context, cost more and blur its focus on one task.

## What we have (checked 2026-11-08)

- **Thinking.** The router asks for readable thinking but discards it (`onReasoning: () => {}` in `packages/router/src/router.ts`), and router calls are not streamed. With the default router, Luna at low thinking, there is nothing to show anyway: its 12 recorded routing calls carry no readable reasoning, about 110–130 output tokens each, about 2.5 s. DeepSeek with thinking on returns readable thinking, but routes about 2× slower (entry 90).
- **Reason.** Every decision has a one-sentence `reason`, saved on `routing_completed`. It is written for the system, not the user ("The user explicitly returns to Socrates and asks for a read-only status update…"). The page never receives it: the `routed` activity carries only goal and task.
- **Searches.** When the router searches earlier work (`ledger_query`, at most 3), the page shows "Looking through earlier tasks…" but not what was searched for.
- **Candidates.** The ≤3 older goals are found from the current message alone (plus the original request when answering a routing question). A message that refers back ("and for the other project…") may not bring that goal into the shortlist, though the router sees the recent conversation and can search.

## What it will look like

```
You: "also, how is the headings list going?"
  ● Finding where this belongs…  1.4s            ← live; opens to the thinking (R2)
      "This asks about the running Socrates task, so it's a status question…"

  … once placed, folded into one row:
  ✓ Socrates → Multitasking · 2.1s
      A status question about the headings list; answered beside the work.   ← the reason (R1)
  ◦ Worked for 8s · read 2 files
  Answer…
```

## Phases

- **R1. Say why.** The reason shows under the place on the routing row, in Flow and in lanes, live and after a reload (it is already saved; the `routed` activity and history parts carry it). The router is asked to write it for the user: one short plain sentence on why the message belongs there, no "the user". Searches show what they looked for ("Looked through earlier tasks: headings list"), live only like the other stages. A routing question already shows its question. Standard mode, whose chat is chosen, has no routing and is unchanged. The reason wording is a router prompt change, so it is measured before and after with `pnpm eval:router-compare` (`ROUTER_RUNS=3`, `ROUTER_EFFORT=low`) and `pnpm eval:multitask`; it ships only if routing does not get worse. Both routers are measured: Luna (low) and DeepSeek Flash with thinking on. DeepSeek matched Luna in 3 live multitask runs (entry 90), but it has not been run on the wider routing fixtures yet.
- **R2. Show the thinking live.** The router call is streamed and its readable thinking goes to the page as a live draft under the routing line, like the worker's thinking, and is kept with the decision so a reload still shows it (capped). It appears only when the model gives readable thinking. First a probe (a few cents): does OpenRouter return a reasoning summary for Luna if asked? If yes, Luna shows it. If not, thinking shows only with a DeepSeek router (thinking on), and the choice becomes yours: Luna, fast with the reason only, or DeepSeek, about 2× slower with its thinking visible.
- **R3. Find goals from what came before.** Candidate search also uses the previous message, so "and for the other project…" finds the project named earlier. Measured with `pnpm eval:router-compare` before and after; ships only if no worse.

Each phase is its own release: typecheck, tests, docs (`architecture/web.md` "Routing line", `architecture/Goal-router.md`), trial-log entry, commit, push, restart.

## Which router

Both stay usable. Some models never return readable thinking (Luna at low, so far), and a model that does may still skip it on a short decision, so the page never waits for thinking: with none, the row shows the stages and then the reason. Luna: about 2.5 s, reason only (unless the R2 probe finds summaries). DeepSeek Flash, thinking on: about 2× slower, reason plus live thinking. You choose the router in Settings > Routing.

## Status

R1 shipped (trial log entry 91).

## Not in this plan

Merging the router into the worker; raising the router's thinking level (Settings already has it; a higher level costs seconds on every message); changing what the router decides.

## Budget

OpenRouter (Luna, plus the R2 probe): about $1 for R1 and R3 measurements (two 3-run comparisons each side). DeepSeek: about $0.30 for its R1 and R2 measurements. Both stay inside the round's caps (OpenRouter $0.25 and DeepSeek $0.18 spent so far).
