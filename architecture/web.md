# Socrates web app

The web app is Socrates' face: a page served by the local server (`server.md`) and driven only through its HTTP API and live connection. Everything it shows comes from the ledger; it keeps no state of its own beyond where the user placed the notes.

It is built in two changes:

- **W1, flow mode:** the welcome page and first-run setup, the flow canvas (the orb, the question and its answer, the task and goal notes), the question sidebar with lanes, the composer (Send, Queue, Send in a new lane, stop, approvals mode), the access menu, approval cards, and `pnpm socrates`.
- **W2, standard mode:** the familiar harness layout (goals on the left, the full scrolling conversation, lane panels beside it), the complete tool-output viewer, and the settings screens.

## Running it

`pnpm socrates` builds the app (`apps/web`, Vite and React) into `apps/web/dist`, starts the server, and opens the printed link in the default browser. The server serves `dist` behind the same session as the API, so the page, its scripts and its fonts never load without it; a browser without the session gets a page saying how to open Socrates. Nothing loads from the network: fonts and icons are bundled, and the page works under the server's `default-src 'self'` policy. `pnpm server` alone serves an existing build, or a note to run `pnpm socrates`.

## Look

Socrates 0.1's colours and type: cream (`#f9f8f4`), teal (`#159f9f`), the dotted canvas, Geist, and the serif gradient name. The canvas is open and calm: no borders or dividers anywhere. Floating controls sit at the top, the composer is the only footer, and depth comes from soft shadows and blur. Movement respects the system's reduced-motion setting.

## Welcome

The name, the motto, and one button: **Chat with Socrates**. Before Socrates can work, the same page shows a short setup instead: a provider key (stored by the server, never shown again) and an optional project folder.

## Flow mode

One question and its answer at a time, on an open canvas.

- **The orb.** Socrates' presence: a slow, drifting planet in the middle of the canvas. A new question floats above it, cut off after six lines with **Show more**, while the orb breathes ("Thinking"). When work starts (the first narration line or tool call), the orb shrinks and glides to where the answer begins, and stays there: teal while working, amber while an approval waits, faded when stopped. A slight parallax moves the planet and the dots against the pointer. Answers arrive whole and fade in; the harness does not stream tokens yet.
- **The answer.** The goal and task it was routed to, the agent's narration, each tool call as one line (open it for the live preview, or the complete recorded output), approval decisions, and the answer in Markdown.
- **Notes.** Two sticky notes beside the conversation: the current task (its title, status and continuation note) and its goal (objective, note, open and done tasks). They follow the question on the canvas. Drag them anywhere, or move them with the arrow keys; their places are remembered in this browser. On a phone they step aside.
- **Sidebar.** The ☰ opens it over the canvas: the conversations (main and each lane, with what it is doing; an idle lane can be closed) and the questions of the conversation on the canvas, newest first by day. Choosing an earlier question shows it; **Return to the latest** comes back.
- **Header.** The ☰ and the access chip: **My folders: …** or **Full access** (orange). Its menu sets the project folder new work starts in (which also joins the folders), adds or removes folders, and chooses the scope (`server.md`, "Access"). The folder picker browses this Mac's folders or takes a typed path (`~` is the home folder).

## Composer

- **Enter** sends to the conversation on the canvas. While main works, a message to main waits in the queue instead; a lane queues its own messages. **Shift+Enter** is a new line.
- The menu beside Send offers **Send**, **Queue** (runs as soon as Socrates is free) and **Send in a new lane** (works beside main; at most four lanes run at once). A message sent to a new lane brings its lane onto the canvas.
- Queued messages sit above the composer; each can be removed or moved into a new lane.
- **Stop** cancels the work of the conversation on the canvas.
- The approvals chip chooses **Ask first** (reading is free; every edit and command asks) or **Work freely**. It turns orange with full access.
- The chat model is shown beside Send.

## Approvals

An approval appears in the answer of the conversation that asked, at the point where the work stopped: what will happen, a preview of the change when there is one, and **Refuse** or **Approve**. Every open page sees it; the first answer counts.

## Conversations

The page builds each conversation from history pages and the live connection, with one pure model (`apps/web/src/lib/model.ts`):

- On load it reads the status, settings, goals and the first history page of main and each open lane. It resumes the live connection from just before the oldest unfinished message, so the replay rebuilds that message with its narration and tool calls; finished messages come from history. A history item carries its message's sequence number for this.
- Live activities join the message they belong to by turn; a turn handed from main to a lane starts its own exchange in that lane, with main's message.
- A message this page sent shows at once and is matched to its saved message; a message for a new lane joins the lane the server names, in either order.
- A lost connection reconnects and catches up from the newest event the page applied; one too far behind reloads from history.
- Changes to settings, keys or access from another tab reach every page.
