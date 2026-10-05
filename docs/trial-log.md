# Trial log

The first full review round of Socrates v2, started 2026-10-05 on branch `socrates-v2` (last commit before the trial: `0ba5013`). The app runs with `pnpm socrates` on port 4200 and keeps its data in `~/.socrates-v2`.

Three kinds of entry: what was asked, what was changed, and what Socrates suggests unprompted.

## Asked

1. **The first-run screen was bad.** It should be a `/welcome` page that sends a new user to `/onboarding`, where they give their name, the API keys they need and, optionally, some project access. Project access must stay freely editable from the header at all times; a folder added in the middle of a chat must be allowed from the next message. Once onboarded, `/welcome` goes straight on to `/chat`.

2. **"The agent does not know my name. That was the whole point."** The name was only used for the greeting; I had listed sending it to the model as a decision for you, when it was the point of asking.

## Changed

1. **Onboarding page** (`#/onboarding`): name (optional), a row per provider for the API key (one is enough; saved keys show a check and are never shown again), and optional folders (the first becomes the project folder). **Start chatting** needs a key, saves the name and opens the chat. `#/welcome` shows **Get started** for a new user and **Chat with Socrates** (with "Welcome back, <name>.") afterwards; `#/chat` sends anyone not onboarded to `#/onboarding`. New `profile` setting (`{ name, onboarded }`), applied without a restart.
2. **Folders added or removed in the header count from the next message.** This already worked (the policy is read at every tool call); it now has a test that adds a folder between two messages and removes it again.
3. **The agent knows the user's name.** A `<USER>` block ("The user's name is Ada.") opens the agent's context whenever a name is set; it is read when each message starts, so a name given or changed mid-chat counts from the next message. The system prompt says to use it the way a person would and never to guess one (the agent had guessed "Aparajit Bhattacharya" from a folder path).

## Suggested

Open since before the trial:

- **A stopped turn needs a way back.** When a turn ends at a safeguard (200 steps, 60 minutes or the token limit), the answer says so, but continuing means typing "continue". A **Continue** button under that answer would resume the same task. (The token limit itself was fixed in `0ba5013`: cached prompt tokens now count at a tenth, and the default is 20,000,000.)
- **A browser tool's screenshot folder asks for approval to read** under "My folders". Allow `read` in a folder an MCP server was configured to write to.
- **Relative paths in an MCP server resolve against Socrates' working directory**, which put a screenshot in the repository root during the gold eval. Say so in the MCP documentation and default the server's working directory to the project folder.
- **The first message can wait about 25 seconds on routing** with DeepSeek Flash as the router. The "Reading your message" line makes the wait visible; routing itself is slower than it needs to be.
- **An existing install that already has a key still sees onboarding once**, because the flag starts false. The page shows its keys as saved, so it is one click.
