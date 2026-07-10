# Skill-learning evaluation

This evaluation treats the Global Memory Agent and Skill Writer as one learning system. It verifies a chronological loop: behavioral-pattern discovery, user-approved skill creation, downstream Socrates discovery/use, later evidence, meaningful skill maturation, and improved held-out behavior.

Private source conversations and generated provider transcripts stay under `evals/skill-learning/private/` and `evals/skill-learning/results/`; both are gitignored. Tracked files contain schemas, sanitized aggregate results, the pre-enhancement baseline, and reproducible scripts only.

## Dataset

`pnpm eval:skill-learning:export` reads only explicitly selected local Codex tasks. The exporter keeps visible user messages and final assistant answers, strips the home path and credential-shaped strings, and excludes system/developer messages, hidden reasoning, tool arguments, and tool outputs.

`pnpm eval:skill-learning:curate` applies the reviewed source-turn selection and writes the chronological golden dataset.

The golden set separates discovery evidence, maturation evidence, negative repeated-topic controls, and synthetic held-out requests. Synthetic records are labeled and are never represented as natural history.

## Live run

`pnpm eval:skill-learning -- --live=true --dataset=evals/skill-learning/private/golden-dataset.json --budget-usd=<hard-cap>`

The harness uses a temporary Socrates home, database, workspace, and retrieval index. It uses provider id `deepseek` and the official DeepSeek API only. It stops before starting a configuration whose projected cost would cross the hard cap and records actual normalized provider usage after each call.

After a full run has already proven creation plus first held-out use, the smallest continuation is:

`pnpm eval:skill-learning -- --live=true --maturation-only=true --full-only=true --pair=pro-high+flash-off --budget-usd=<remaining-cap> --dataset=evals/skill-learning/private/golden-dataset.json`

This seeds the previously proven v1 skill plus its journal/proposal/Writer history in isolated temporary state, then runs only Memory update discovery, approved Writer maturation, meaningful-diff validation, and held-out v2 use. Validate that deterministic seed without provider calls using `--live=true --seed-check=true --budget-usd=0.00`.

The root command rebuilds shared, contracts, providers, and core packages before loading the server-side harness so a run cannot silently evaluate stale compiled prompts. A completed result can be deterministically rescored without a provider call using `--rescore-result=<result-json>`; this only applies the checked-in response-concept matcher and records both literal and matched concepts in that result.
