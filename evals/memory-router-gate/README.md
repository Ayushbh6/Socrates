# Memory Router Gate Evaluation

This directory contains a deliberately isolated evaluation of whether one semantic pre-turn label could safely suppress the final Memory Router pass.

It is not part of the Socrates application or packaged runtime:

- `golden-dataset.json` contains 30 synthetic, non-personal fixtures.
- `report.md` contains the durable aggregate results and the decision not to ship the gate.
- `../../apps/server/scripts/run-memory-router-gate-eval.ts` is an opt-in runner invoked only through `pnpm eval:memory-router-gate`.
- `results/*.json` contains raw provider output and is ignored by Git.

Production continues to run the final Memory Router at genuine finalization. Do not import the runner or fixtures into server, web, CLI, or runtime code. A future experiment must be explicitly authorized and must preserve the semantic, fail-closed safety boundary documented in the report.
