# Image recall across context switches — 16 October 2026

Baseline: `cd9795a`, `socrates-v2`. Evaluation only; no application changes, commit, push or live restart. Candidate for later registration beside the goal eval, pending user review.

**Original images were recovered in every run. Ambiguity handling failed in all three two-image runs, and correct image answers sometimes concealed a wrong task or an unsupported history claim.**

## Results

Each row has three independent, fully generated conversations. Q1 supplies the website image; Q2–Q9 discuss maths. The ambiguous case adds an exam image at Q5. Both images contain a button and a reference code.

| Return request | Expected behavior | Observed |
|---|---|---|
| Q10 names the German website | Resume original task, reopen image, read details | **3/3 passed** |
| Q10 says “the image”; only one exists | Resolve website, resume original task, reopen image | **3/3 passed** |
| Q10 says “the image”; website and exam images exist | Ask which image before choosing | **0/3 passed** — all silently chose website |
| Q11 explicitly selects website after the ambiguous request | Resume website task and reopen its image | **2/3 correct task; 3/3 correct image and details** |

All nine Q10 turns actually read the original website file, delivered its pixels to DeepSeek, and answered the button label and code correctly. This proves image availability, **not** correct handling of ambiguous intent. All three Q11 turns also reopened the original.

## Failures worth addressing

| Evidence | What happened |
|---|---|
| `ambiguous-1/2/3`, Q10 | No clarification despite two images. In `ambiguous-1`, the router saw both attachment references and all nine earlier turns, yet called the vague request an “explicit” website return. |
| `ambiguous-2`, Q11 | Router reason named the website, but its selected `older_1` label meant maths. A repair fixed the invalid task label without fixing the goal. The worker recovered the image through `all_goals` search **while answering in the maths task**. |
| `explicit-2`, Q5→Q6 | An extra maths task had been created. “For that equation…” went to that task; its worker context omitted Q5’s `4x + 8 = 24`. The answer instead explained older `3x + 5 = 20`. |
| `ambiguous-1`, Q11 | A `current_goal` search found no exam sheet in the website goal. The worker then wrongly claimed no exam sheet had passed between them, although Q5 contained one. Scoped absence became a claim about the whole conversation. |

Independent continuity review: **8/9** Q6 answers retained the latest equation; **9/9** Q8 answers solved their own Q7 practice equation. Extra reminders were not counted as failures. These selected cases are not a general production accuracy estimate.

## What was tested

- Production `Runtime`, unconstrained Flow routing, fresh ledgers/memories/indexes. Only two existing goal/task metadata records were seeded; all conversation answers were real model output.
- Official DeepSeek API, `deepseek-flash`, high effort. Its model list identified **DeepSeek-V4.1-Flash** and image support; responses reported `deepseek-flash`. Existing GPT-6 Luna router and Perplexity decider remained in use.
- Neutral `image.png` names and independent random codes initially present only in pixels. Q1 answers subsequently transcribed those codes in **all nine runs**; therefore answer correctness alone is not pixel-recall evidence. Successful exact-path reads and matching image payload hashes supply that evidence.
- Repetition 3 closed and reopened the runtime after Q9: **3/3** retained task binding and image access at Q10. This tests runtime/data persistence, not browser mode changes or compaction rollover.
- All approvals were declined in the isolated sandbox. Failed directory listing/copy attempts did not prevent direct attachment reads. No user conversation or repository was used as test data.

An additional **cold-start pilot** kept all ten turns in General; Q10 still reopened the image. It cannot count as a cross-goal test and is reported separately. Its initial claim that attachments could not be read followed a blocked directory listing; the worker corrected that claim after a successful direct read.

Not tested: images outside the router history window, many competing projects/images, browser Standard/Flow switching, or image retrieval after compaction. Q10 explicitly requested reopening, so these results do not establish spontaneous image inspection on a weaker follow-up.

Durable evidence: [results and transcripts](/Users/aparajitbhattacharya/.codex/visualizations/2026/10/16/01a1423a-703b-7603-ac27-2965e6d85bda/image-context-eval/results.json), [protocol](/Users/aparajitbhattacharya/.codex/visualizations/2026/10/16/01a1423a-703b-7603-ac27-2965e6d85bda/image-context-eval/protocol.json), [independent adjudications](/Users/aparajitbhattacharya/.codex/visualizations/2026/10/16/01a1423a-703b-7603-ac27-2965e6d85bda/image-context-eval/adjudications.json). The candidate and sanitized raw evidence are retained there; disposable homes and credentials are removed after export. No full application test rerun is claimed for this evaluation-only work.
