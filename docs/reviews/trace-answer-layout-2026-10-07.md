# Trace answer layout

The trace's Markdown wrapper reused the chat's `answer` class. The globally loaded chat stylesheet defines that class as a two-column grid: a 2.3rem column for the orb and the remaining width for the answer body. The trace has a single child, so its prose occupied the orb column and wrapped nearly every word.

Reproduced on the user's existing folder-description trace in Chrome at 1470 × 745. The prose measured 36.8 pixels wide and 30,817.8 pixels tall, inside a 714.8-pixel content area.

The trace now uses its own `trace-answer` class. Its wrapper renders as a block and the prose fills the card: 714.8 pixels wide and 783.9 pixels tall. The rendered answer text is identical before and after. Paragraphs, inline code and nested lists retain their Markdown formatting.

Verified both existing answers, light and dark mode, desktop (1470 pixels), tablet (820 pixels) and phone (390 pixels). At phone width the prose measures 297.2 pixels, with normal sentence wrapping and no document overflow. Flow retains its two-column orb/body layout; Standard retains full-width prose. No inference requests or runtime-data changes were needed. Rebuilt the web app and reloaded the existing Chrome page; the server remains live on port 4200 with the same session.

Validation: `pnpm typecheck`, `pnpm build:web`, `git diff --check`, and all **69 web tests across nine files** passed. Local screenshots are ignored under `.socrates/reviews/trace-answer-layout/`: `desktop-light.png`, `desktop-dark.png`, `phone-light.png` and `tablet-light.png`.
