# Socrates web app

The web app is Socrates' face: a page served by the local server (`server.md`) and driven through its HTTP API and live connection. Conversation records come from the ledger. The page also holds temporary streamed drafts and unsent text; layout choice and note positions are remembered in this browser.

It is built in two changes:

- **W1, flow mode:** the welcome page, onboarding, the flow canvas (the orb, the question and its answer, the task and goal notes), the question sidebar with lanes, the composer (Send, Queue, Send in a new lane, stop, approvals mode), the access menu, approval cards, and `pnpm socrates`.
- **W2, standard mode:** the familiar harness layout (goals on the left, the full scrolling conversation, lane panels beside it), the switch between the two modes, the complete tool-output viewer, and settings.

## Running it

`pnpm socrates` builds the app (`apps/web`, Vite and React) into `apps/web/dist`, starts the server, and opens the printed link in the default browser. The server serves `dist` behind the same session as the API, so the page, its scripts and its fonts never load without it; a browser without the session gets a page saying how to open Socrates. Nothing loads from the network: fonts and icons are bundled, and the page works under the server's `default-src 'self'` policy. `pnpm server` alone serves an existing build, or a note to run `pnpm socrates`.

## Look

Socrates 0.1's colours and type: cream (`#f9f8f4`), teal (`#159f9f`), the dotted canvas, Geist, and the serif gradient name. The canvas is open and calm: no borders or dividers anywhere. Floating controls sit at the top, the composer is the only footer, and depth comes from soft shadows and blur. Movement respects the system's reduced-motion setting.

## Welcome and onboarding

Three pages, by the address after `#`: `#/welcome` (also anything unknown), `#/onboarding` and `#/chat`.

- **`#/welcome`** is the name, the motto and one button. Someone who has not been through onboarding sees **Get started**, which opens `#/onboarding`. Someone who has sees **Chat with Socrates** (with "Welcome back, <name>." when they gave a name), which opens `#/chat`. If setup went missing again (a key was removed), it says what is missing and offers **Fix the setup**.
- **`#/onboarding`** is one calm column of three numbered steps and a button. **1. What should Socrates call you?** (optional): the name is kept in the profile setting; the welcome page greets by it and the agent is told it (`<USER>`, `agent-harness.md`, "Working-agent context"). **2. Add an API key**: a row per provider (Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek) with a field and **Save**; a saved key shows a check and "Saved. Paste a new one to replace it", and its value is never shown again. One key is enough. **3. Where may Socrates work?** (optional): the folders Socrates may use. The first folder added becomes the project folder, where new work starts; later ones only join the list, and each can be removed. Folders are only a head start: the header's access menu adds, removes and changes them at any time, even in the middle of a chat, and a folder added there counts from the very next message (`server.md`, "Access"). **Start chatting** is enabled once Socrates is ready (a key is set); it saves the name, marks the profile onboarded, and opens `#/chat`.
- **`#/chat`** needs onboarding: someone who never finished it, or whose setup is missing again, is sent to `#/onboarding` (replacing the address, so Back does not loop). A short restart after a settings change keeps the canvas; only missing setup counts.

## Flow mode

One question and its answer at a time, on an open canvas.

- **The orb.** Socrates' presence: a slow, drifting planet in the middle of the canvas. A new question floats above it, cut off after six lines with **Show more**, while the orb breathes ("Thinking"). When work starts (the first draft of the reply, narration line or tool call), the orb shrinks and glides to where the answer begins, and stays there: teal while working, amber while an approval waits, faded when stopped. A slight parallax moves the planet and the dots against the pointer.
- **The answer.** The goal and task it was routed to, the work behind it ("Work and answer"), approval cards, and the answer in Markdown. It is written as it is generated ("Streaming").
- **Notes.** Two sticky notes beside the conversation: the current task (its title, status and continuation note) and its goal (objective, note, open and done tasks). They follow the question on the canvas. Drag them anywhere, or move them with the arrow keys; their places are remembered in this browser. On a phone they step aside.
- **Sidebar.** The ☰ opens it over the canvas: the conversations (main and each lane, with what it is doing; an idle lane can be closed) and the questions of the conversation on the canvas, newest first by day. Choosing an earlier question shows it; **Return to the latest** comes back.
- **Header.** On the right, the switch between Flow and Standard and the way to settings. On the left, the ☰ and the access chip: **My folders: …** or **Full access** (orange). Its menu sets the project folder new work starts in (which also joins the folders), adds or removes folders, and chooses the scope (`server.md`, "Access"). The folder picker browses this Mac's folders or takes a typed path (`~` is the home folder).

## Work and answer

What Socrates did and what it says look different, in both modes. The work comes first, quiet and foldable; the answer follows in ordinary text.

- **The work** is, in order: the model's narration, and between two lines of narration one group of everything it did there, as Codex and Claude Code show it: each request's thinking and each tool call, in order. Handoffs, warnings and approval decisions stand on their own. A group is one line naming what its calls did, such as **Read 2 files, ran 1 command**, or how long it thought when it only thought (**Thought for 6s**); a group of one thing is that thing's own line.
- **Each call is one quiet row** with an icon for its kind (file, search, edit, terminal, memory, capability, other) and what it did in plain words, which the server writes (`server.md`, "Live activity"): **Read `src/app.ts`**, **Searched for `onText` in src**, **Edited `settings.tsx` +5 −2**, **Ran `npm test` · exit 1 · 2.1s**, **Typed `shop` in configure and pressed Enter**, **Pressed Down ×3, Enter in vite**, **Waited for `dev` to print "ready"**. A long command ends in an ellipsis rather than widening the page. While a call runs, its verb is in the present ("Running") and shimmers, with how long it has run; a command shows its newest six lines of output under it as it prints (`server.md`, "Live drafts"). A row opens to an edit's diff in colour, a command's output (its end, where the outcome is), matches as `path:line`, or a failure's message and correction, with **Open the full output** ("Tool output").
- **Thinking** that is arriving shows its newest lines in small muted italics, older lines fading upward, under a shimmering **Thinking**; once its request is saved it becomes one **Thought for Ns** row (timed from the work before it) that opens to all of it, shown up to its first `20,000` characters; a longer one offers **Show all of it**, which opens the whole thought in a viewer like the tool output's.
- **Waiting** is never silent. From the moment a message is sent until something arrives, and whenever nothing streams or runs, a shimmering line says what Socrates waits on, with a seconds count: **Reading your message** until it is routed, then **Thinking**. In flow mode it replaces the orb's own label; in standard mode the thread's line under the newest question only says when an approval is waiting or a message is being sent.
- **While Socrates works** the work is the page: everything above shows as it happens and the newest group is open. **Once the answer starts**, or for an earlier question, the work folds into one line, such as "Worked for 16s · thought · read 2 files · ran 1 command", which opens it again. The clock stops at the last step of the work.
- Rows have no panels and there are no lines; only output, diffs and live command output sit on a soft tint.

## Streaming

Text appears while the model writes it. The server sends the readable part of the reply so far as a `draft` (`server.md`, "Live drafts"): the line before tool calls, or the answer, which comes from the final message's `full_answer` so none of its hidden fields shows. Both modes use the same pieces:

- **One draft per turn.** A draft is kept on its question's exchange and replaced by each newer one; one from an earlier request than the one showing is ignored (a retry or repair is a later request). The saved narration, answer or question, or the end of the turn, replaces it. Stopping a turn while its answer is being written keeps that answer as far as it was written, in the same place, with **Stopped.** under it; it stays after a reload, and asking Socrates to go on continues from it. The first draft moves the orb out of the middle, so the answer grows from where the orb lands. A draft never changes where the page resumes the live connection, because it is not an event.
- **One element for the draft and its answer.** The draft and the saved answer that replaces it are the same piece of text on the page, so nothing flickers or jumps at the swap.
- **Even flow.** Models send text in bursts, so each frame shows a share of the text still waiting (at least one character), measured by the time since the last frame, so slow frames or a hidden tab never leave the text behind, never splitting a Unicode code point, and carries on after the saved answer replaces the draft. Catch-up time depends on the burst's size. A soft point marks the end of text still being written. Finished history is shown whole; with reduced motion, text is shown as it arrives, including when that setting changes while the answer is open.
- **Following.** The area stays at the end of the text while the reader is there and leaves a reader who scrolled up, or clicked in the conversation to open something, alone until they return to the end; a new question brings it back to the end. Opening a lane or resizing the panel keeps following active. Loading an older page preserves the reading position. Flow follows the canvas, and every thread and lane panel of standard mode follows its own.
- **Joining late.** A page that opens or reloads mid-reply is sent the current drafts after its state and replay, and carries on from there.

## Standard mode

The familiar harness layout, for following everything at once. The switch in either header changes mode; the choice is remembered in this browser, and both modes show the same live conversations.

- **Goals** on the left: every goal with its tasks (open, completed or superseded) and how many are done. The goal of the main conversation's newest routed question is open, with its objective and note, and its current task shows its continuation note. The general conversation is not a goal and is not listed.
- **Main** in the middle: every question with its answer, oldest first, with **Load earlier questions** at the top. It follows new work while the reader is at the bottom, and a new question always brings it to the end. Each answer's work says when Socrates is reading, thinking or working ("Work and answer"), and a line under the newest question says when it waits for an approval; **Stop** in the panel's head cancels. Its composer is the same as flow mode's.
- **Lanes** on the right, one panel each, stacked: the lane's task and state (working, waiting for you, idle), its whole conversation, and its own small composer that sends to that lane. Stop a working lane or close an idle one from its head. A message sent to a new lane shows in a "New lane" panel until the server names its lane.
- On narrower screens the panels stack and the page scrolls.

## Tool output

Every tool call opens to its live preview; **Open the full output** shows the complete recorded output (`GET /api/evidence`) in a dialog: a file change as its diff with additions and removals coloured, a structured result as tidy JSON, and anything else as recorded, with long lines wrapped or not. It says when the output was cut at 200,000 characters or when a command printed more than Socrates keeps.

## Settings

The gear in either header opens settings:

- **Models:** the chat, routing and compaction models (compaction is the call that summarizes an old part of a long task; automatic is the chat model, and choosing a provider fills in its strong default model): automatic (the first provider with a key, and the chat provider's router model) or a provider with its default model filled in (`GET /api/providers`), which can be edited, with the provider's models suggested while typing (`GET /api/models`). A chat model keeps its thinking level only while it stays the same model. It says which models are in use and whether they were picked from the keys.
- **API keys:** each key Socrates knows, whether it is set, and a field to set or replace it, or remove it. Keys are never shown.
- **Memory search:** the embedding provider (Ollama on this Mac by default), model and address, and whether memory search is ready and how much it holds.
- **Time zone:** a time zone, or follow the Mac.
- **Where Socrates works:** the project folder, my folders or full access, and ask first or work freely: the same controls as the header and composer.

Model, key, memory and time-zone changes restart Socrates, so they wait until it is idle and say so otherwise; the page stays where it is during the restart. Access changes apply at once.

Settings, the folder picker and full tool output contain keyboard focus, close only the topmost dialog on Escape, and restore focus on close. Choosing a typed folder validates that path directly; navigating first with Enter is optional.

## Images

Drop images on the composer, paste a screenshot into it, or choose them with the image button: at most `10` per message. Each is made small enough to send in the browser (at most `2,000` pixels on its longest side and under `5` MB; a PNG stays a PNG when it fits, otherwise it becomes a JPEG), stored by the server, and shown as a thumbnail that can be removed before sending. Sending waits until every image is stored; a message may be only images, with no text, and Send is enabled as soon as one is attached. When the chat model cannot see images, the composer says so: Socrates will know only their names and sizes. A sent question shows its images above it, in both modes and in history; each opens full size. A question that is only images shows just them, and the sidebar lists it as "An image" or "3 images".

## Composer

- **Enter** sends to the conversation on the canvas. While main works, a message to main waits in the queue instead; a lane queues its own messages. **Shift+Enter** is a new line.
- The menu beside Send offers **Send**, **Queue** (runs as soon as Socrates is free) and **Send in a new lane** (works beside main; at most four lanes run at once). A message sent to a new lane brings its lane onto the canvas.
- Queued messages sit above the composer; each can be removed or moved into a new lane.
- **Stop** cancels the work of the conversation on the canvas.
- The approvals chip chooses **Ask first** (reading is free; every edit and command asks) or **Work freely**. It turns orange with full access.
- **Model and thinking** sit beside Send, as in other chat apps: "deepseek-flash ⌄  Low ⌄" (not in a lane's compact composer).
  - The model menu lists the chat models of every provider with a key (`GET /api/models`), the one in use first and checked, with a search box over names and ids; a provider lists at most `40` at a time, and one with no match is left out while searching. A typed id without spaces that no list has can be used with any of those providers. Choosing a model saves it as the chat model, at Socrates' default thinking level, and restarts Socrates, so while anything is working the models are greyed out and the menu says to wait. The menu links to Settings for the routing model and keys.
  - The thinking menu shows only the levels the chat model accepts (`server.md`, "Settings"), strongest first, with Socrates' default marked and the one in use checked. A choice applies to the next model request, even while Socrates works, and every open page shows it. A model without levels has no thinking menu.
- Unsent text belongs to its conversation and survives a mode switch or reconnect. Sending waits for a ready connection. A rejected queue submission keeps its text on the page and restores it to an empty composer; if another draft is already being written, that draft is preserved.

## Approvals

An approval appears in the answer of the conversation that asked, at the point where the work stopped: what will happen, a preview of the change when there is one, and **Refuse** or **Approve**. Every open page sees it; the first answer counts.

## Conversations

The page builds each conversation from history pages and the live connection, with one pure model (`apps/web/src/lib/model.ts`):

- On load it reads the status, settings, goals and the first history page of main and each open lane. It resumes the live connection from just before the oldest unfinished message, so the replay rebuilds that message with its narration and tool calls; finished messages come from history. A history item carries its message's sequence number for this.
- Live activities join the message they belong to by turn; a turn handed from main to a lane starts its own exchange in that lane, with main's message.
- A message this page sent shows at once and is matched to its saved message; a message for a new lane joins the lane the server names, in either order.
- A lost connection reconnects and catches up from the newest event the page applied; one too far behind reloads from history.
- History includes a snapshot cursor, turn IDs and ordered narration, tool previews and decisions. On a replay reset, delivery pauses while that snapshot loads, then a fresh connection requests activity and the current drafts. Events already represented by each snapshot are ignored. An unfinished turn older than the replay window uses the snapshot directly.
- Changes to settings, keys or access from another tab reach every page.
