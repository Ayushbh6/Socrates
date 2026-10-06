# Trial log

The first full review round of Socrates v2, started 2026-10-05 on branch `socrates-v2` (last commit before the trial: `0ba5013`). The app runs with `pnpm socrates` on port 4200 and keeps its data in `~/.socrates-v2`.

Three kinds of entry: what was asked, what was changed, and what Socrates suggests unprompted.

## Asked

1. **The first-run screen was bad.** It should be a `/welcome` page that sends a new user to `/onboarding`, where they give their name, the API keys they need and, optionally, some project access. Project access must stay freely editable from the header at all times; a folder added in the middle of a chat must be allowed from the next message. Once onboarded, `/welcome` goes straight on to `/chat`.

2. **"The agent does not know my name. That was the whole point."** The name was only used for the greeting; I had listed sending it to the model as a decision for you, when it was the point of asking.

3. **"Add an option to select the model for the compaction call."** The compaction summary is also an LLM call, so it gets its own model choice in the settings.

4. **Two sidebar things.** Each question in the sidebar should show its time and date at the bottom right. And while an earlier question is shown, sending from the composer must still append after the last message, continue the conversation as normal, and take the canvas to the current question.

5. **"The favicon on the URL is empty."** Put the actual Socrates image in the browser tab.

6. **Both sticky notes should expand.** The task note even says "Open" but does nothing when clicked. Decide what each shows when expanded.

7. **Full observability and evals of how the agent works** (the user's top priority, to be tested live): exactly what context each request receives, how the goal router and the working agent behave, and concrete proof that automatic context switching and memory management work, available at any time (a dashboard or similar). Per request: the body sent, total cost, tokens per second, and all metadata the provider returns.

8. **Prompt caching must be proven high.** Hard numbers on cache reads against writes and uncached prompt, per request, per turn and overall, so the efficiency can be checked and regressions seen.

9. **Memory and personalisation, so the agent never forgets.** The agent has `context_retrieve`, but needs a proper memory system too: simple, working, not over-engineered.

10. **The standard-mode UI is not good enough yet, and the move from standard to flow was never designed.** Flow to standard was discussed in depth. Open case: someone starts a goal in standard mode (like a ChatGPT project, with the + button), chats there, then switches to flow. The user's leaning: the goal keeps the name the user gave it (like a project name), and the question-and-answer pairs are grouped into conversations by context. Do not re-split every pair in the project into tasks by similarity: that would be a mess.

## Changed

1. **Onboarding page** (`#/onboarding`): name (optional), a row per provider for the API key (one is enough; saved keys show a check and are never shown again), and optional folders (the first becomes the project folder). **Start chatting** needs a key, saves the name and opens the chat. `#/welcome` shows **Get started** for a new user and **Chat with Socrates** (with "Welcome back, <name>.") afterwards; `#/chat` sends anyone not onboarded to `#/onboarding`. New `profile` setting (`{ name, onboarded }`), applied without a restart.
2. **Folders added or removed in the header count from the next message.** This already worked (the policy is read at every tool call); it now has a test that adds a folder between two messages and removes it again.
3. **The agent knows the user's name.** A `<USER>` block ("The user's name is Ada.") opens the agent's context whenever a name is set; it is read when each message starts, so a name given or changed mid-chat counts from the next message. The system prompt says to use it the way a person would and never to guess one (the agent had guessed "Aparajit Bhattacharya" from a folder path).

4. **Compaction model setting.** Settings > Models has a Compaction row beside Chat and Routing: automatic (the chat model, as before) or a provider and model; choosing a provider fills in its strong default (for DeepSeek, `deepseek-v4-pro`). It is the `compactor` setting, reported in the status as `models.compactor`, and "In use" in the settings says which model compacts.

5. **Time and date in the sidebar.** Questions are grouped under one heading per day (Today, Yesterday, then the date), and each row shows only the time it was asked at the bottom right ("7:35 PM", in the browser's own format). The first version repeated the date on every row; you preferred the day headings.
6. **Sending from an earlier question.** This already worked (sending clears the choice, so the message is appended after the last question and the canvas follows it); I checked it live with DeepSeek Flash, idle and while main was busy, and the choice of what the canvas shows is now one tested function (`viewedExchange`).
7. **Tab icon.** The browser tab shows the Socrates logo (64 px favicon, 512 px icon and a 180 px Apple touch icon, made from the teal profile logo).

## Suggested

Open since before the trial:

- **A stopped turn needs a way back.** When a turn ends at a safeguard (200 steps, 60 minutes or the token limit), the answer says so, but continuing means typing "continue". A **Continue** button under that answer would resume the same task. (The token limit itself was fixed in `0ba5013`: cached prompt tokens now count at a tenth, and the default is 20,000,000.)
- **A browser tool's screenshot folder asks for approval to read** under "My folders". Allow `read` in a folder an MCP server was configured to write to.
- **Relative paths in an MCP server resolve against Socrates' working directory**, which put a screenshot in the repository root during the gold eval. Say so in the MCP documentation and default the server's working directory to the project folder.
- **The first message can wait about 25 seconds on routing** with DeepSeek Flash as the router. The "Reading your message" line makes the wait visible; routing itself is slower than it needs to be.
- **An existing install that already has a key still sees onboarding once**, because the flag starts false. The page shows its keys as saved, so it is one click.
- **Two Anthropic and two Gemini key rows in settings** (`ANTHROPIC_API_KEY` and a second name; `GEMINI_API_KEY` and `GOOGLE_API_KEY`): one row per provider, taking either name, would be clearer.
