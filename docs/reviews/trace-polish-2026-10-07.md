# Trace card polish

Visual thesis: calm paper surfaces, generous spacing and legible technical detail, preserving the existing Socrates palette and typography.

Content plan: call title and model, aligned metrics, token bar, then expandable context, thinking and tool results. Recorded content stays intact.

Interaction: retain native disclosures and their arrows, add a short colour transition to their hover state, and disable that transition for reduced motion. Error messages remain explicit without coloured card edges.

## Changes

- Removed the coloured inset shadows from router, agent and failed-call cards. All trace cards use the same quiet elevation.
- Increased desktop card padding from roughly 14–18 pixels to 24 pixels vertically and 32 pixels horizontally; phone horizontal padding is 20 pixels. Increased spacing between cards and inside disclosure rows and code blocks.
- Refined title/model hierarchy, improved muted-text contrast, and increased code font size and line spacing.
- Aligned the seven call metrics in a grid. Container queries use seven columns on wide cards, four on medium cards, and two on narrow cards.
- Scoped the card and detail treatments to the timeline. Chart, Database, drawer and chat layouts retain their existing styles.

## Verification

Checked the two saved traces in the live app, light and dark mode, at 1470-, 820- and 390-pixel widths. Card edges have no left border or inset shadow. Metric columns align across agent steps; neither cards, values nor disclosure titles clip. Opened and closed an agent context disclosure. The longer trace's 15 calls also fit without clipping.

Compared every displayed call metric and the recorded prose/code text before and after: both are identical. No model call, routing change or data reset was needed. Build, typecheck, all 69 web tests and `git diff --check` passed. The V2 server remains live on port 4200 with its existing session.

Ignored local screenshots: `.socrates/reviews/trace-polish/router-light.png`, `agents-light.png`, `agents-dark.png`, `phone-light.png`, `tablet-light.png`.

## `goal_label`

Checked `packages/router/src/prompt.ts` and `packages/router/src/validate.ts`. This is a selector for an existing goal: `current`, an `older_N` label, or a ledger-confirmed `gN` selector. It is distinct from a goal's title. A `create_new` decision requires `goal_label: null` and a separate `new_goal_title`; the harness creates and numbers the goal afterwards. Both of the user's recorded questions made new goals, so their null values are expected.
