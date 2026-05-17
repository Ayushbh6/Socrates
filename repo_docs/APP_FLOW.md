# Socrates App Flow

This document defines the initial product flow, route structure, and page responsibilities for Socrates.

Socrates is project-first. Users do not start with a floating global chat. They enter a project, use project resources and instructions, then create or resume conversations inside that project.

## Route Summary

```text
/welcome
/onboarding
/projects
/projects/new
/projects/:projectId
/projects/:projectId/chats/:conversationId
```

Avoid this shape:

```text
/projects/:projectId/dashboard/:dashboardId
```

The project itself is the dashboard. A separate dashboard id adds complexity without representing a real entity.

## First-Run Flow

```text
open app
  -> /welcome
  -> check local database
  -> if no onboarded user exists, go to /onboarding
  -> if onboarded user exists, go to /projects
```

The first-run check should use local SQLite state, not browser-only local storage.

## Returning-User Flow

```text
open app
  -> /welcome
  -> check local database
  -> /projects
```

The welcome page can be brief and atmospheric. It should not become a marketing site.

## `/welcome`

Purpose:

- Introduce Socrates.
- Give the app a calm, polished first impression.
- Route the user based on onboarding state.

Visual direction:

- Apple-inspired.
- Minimal.
- Airy.
- High contrast where needed.
- No clutter.
- No dense feature explanation.

Primary action:

```text
Open Workspace
```

Routing:

```text
if users.onboarding_completed = false or no user row exists:
  /onboarding
else:
  /projects
```

## `/onboarding`

Purpose:

- Create the local user profile.
- Ask the user what Socrates should call them.
- Mark onboarding as complete.

Fields:

```text
display_name
```

Submit action:

```text
Next
```

Database effects:

```text
create users row if missing
set users.display_name
set users.onboarding_completed = 1
set users.onboarded_at
```

Routing after submit:

```text
/projects
```

Important:

- This page should not ask for provider keys yet.
- This page should not ask for complex preferences yet.
- Keep it focused on the user's name.

## `/projects`

Purpose:

- Show all projects.
- Let the user create a project.
- Let the user open an existing project.

Primary UI:

- Project list/grid.
- Search projects.
- New project button.

Initial project creation:

```text
Create project -> enter project title -> optional description -> connect a local workspace folder
```

Later options can include:

```text
Clone from GitHub
Import project archive
```

Database reads:

```text
projects
project_workspaces
recent conversation/activity metadata
```

Routing:

```text
click project -> /projects/:projectId
new project -> /projects/new
```

## `/projects/new`

Purpose:

- Create a project container.
- Attach Socrates to a real local workspace folder.
- Create the project metadata in SQLite.
- Create the project-local Socrates scaffold inside the workspace.

Fields:

```text
project title
description
workspace folder
```

Required fields:

```text
project title
workspace folder
```

Optional fields:

```text
description
```

Workspace behavior:

```text
user enters project title
user optionally enters description
user connects any local folder through the backend/native picker or pastes an absolute path
backend verifies the folder exists and is a directory
backend creates <workspace>/.socrates/resources/
```

Folder selection is owned by the local backend/native bridge, not browser-only filesystem APIs. In dev V1 the frontend calls the backend picker directly instead of relying on the Next rewrite because native picker requests can be long-running. The frontend also keeps a manual absolute-path fallback.

V1 invariant:

```text
Every active Socrates project must have exactly one primary local workspace folder.
```

Database effects:

```text
create projects row
create project_workspaces row with is_primary = 1
store project_workspaces.path as the absolute workspace path
emit project.created event
emit project.workspace.attached event
```

Filesystem effects:

```text
create <workspace>/.socrates/
create <workspace>/.socrates/resources/
```

Socrates should not edit the workspace root `.gitignore` in V1. Users can ignore `.socrates/` themselves if they want. A future version may offer an explicit opt-in action for that.

Routing after creation:

```text
/projects/:projectId
```

## `/projects/:projectId`

This is the project dashboard.

Purpose:

- Show project context.
- Show project resources.
- Show project instructions.
- Show past conversations.
- Start a new chat.

Primary areas:

```text
project header
centered start new chat action
conversation list
resource panel
instructions panel
workspace status
```

Project header:

- Show the project title.
- Show the optional project description only as a bounded preview.
- Store the full description in SQLite, but do not render unbounded text on the dashboard.
- The preview should fit below the project name without stretching the layout. Prefer a two-line clamp with a safe character fallback around 80 characters plus `...`.

Resource panel:

- Uploaded PDFs.
- Documents.
- Text notes.
- Images.
- Links.
- Local files selected as references.

V1 uploaded files are copied by the backend into:

```text
<primary_workspace>/.socrates/resources/
```

The resulting `project_resources.uri` points to the stored local file path.

File upload behavior:

- Clicking the files add action opens the file upload control.
- Users may select up to 10 files at once.
- The backend stores each uploaded file under the primary workspace `.socrates/resources/` folder and creates one `project_resources` row per file.
- The file panel should show uploaded file previews with filename, type, and size when known.
- The preview area must have a bounded height. It may show around four file previews before becoming scrollable.
- The file panel must not grow indefinitely when a project has many resources.

Instructions panel:

- Project-specific guidance.
- Persistent instructions for conversations in this project.
- Clicking the instructions add/edit action opens a modal with a large text area.
- Saving instructions writes the full content to `project_instructions`.
- The dashboard panel displays only a bounded preview of saved instructions. Prefer a two-line clamp with a safe character fallback around 100 characters plus `...`.
- Empty instructions should show the add-instructions prompt.

Conversation list:

- Existing conversations in this project.
- Last message preview.
- Last activity time.
- Status.

Actions:

```text
Start new chat
Open existing chat
Add resource
Edit instructions
Open workspace folder
```

Routing:

```text
start new chat -> create conversation -> /projects/:projectId/chats/:conversationId
open existing chat -> /projects/:projectId/chats/:conversationId
back to all projects -> /projects
```

The project dashboard must not show the full chat composer in V1. The composer belongs on `/projects/:projectId/chats/:conversationId`. The dashboard shows a centered `Start new chat` button/action instead.

## `/projects/:projectId/chats/:conversationId`

Purpose:

- Main Socrates chat workspace.
- Stream agent events over WebSocket.
- Show thinking, answer, tool calls, approvals, artifacts, terminal output, and context usage.

Primary layout:

```text
left/nav area
  project and conversation navigation

main chat area
  user messages
  thinking blocks
  assistant messages
  tool-call timeline
  feedback controls
  composer

right panel
  artifacts
  diffs
  previews
  project resources
  terminal output when relevant
```

Composer controls:

- Text input.
- Voice input.
- Attach resource.
- Model selector.
- Thinking toggle.
- Approval mode selector.
- Send.

Composer run-state behavior:

```text
no active turn -> show send arrow and allow sending
active turn -> show stop button and block sending another query
stop button -> send chat.turn.cancel
turn.completed / turn.failed / turn.cancelled -> show send arrow again
```

V1 uses cancel/stop, not true pause/resume.

Runtime settings are per turn:

```text
provider
model
thinking_enabled
thinking_effort
approval_mode
sandbox_mode
max_output_tokens
temperature
```

These settings are stored in `turn_runtime_configs`.

WebSocket behavior:

```text
web sends user message or transcribed voice message
server validates event
core starts turn
provider streams model events
tools emit progress events
server streams typed events back to web
web renders live state
db records every event
```

## Project-Scoped Conversations

Every conversation belongs to exactly one project.

```text
projects.id -> conversations.project_id
```

This keeps the app organized:

```text
Project
  resources
  instructions
  conversations
    turns
    messages
    events
```

Global chats should not exist in V1.

## Resource Flow

```text
user adds resource
  -> copy/upload file-backed resources to <workspace>/.socrates/resources/
  -> create project_resources row
  -> emit project.resource.created event
  -> resource becomes available to future project conversations
```

Resources are project-level context, not conversation-only context by default.

The default V1 resource storage location is:

```text
<primary_workspace>/.socrates/resources/
```

Do not scatter uploaded resources into arbitrary workspace folders.

Later, a conversation can pin or select a subset of project resources if needed.

## Chat Creation Flow

```text
user clicks New chat on project dashboard
  -> create conversations row with project_id
  -> create sessions row if a runtime session is needed immediately
  -> route to /projects/:projectId/chats/:conversationId
```

The first user message creates the first `turn`.

## Voice Input Flow

```text
user records voice
  -> create voice_inputs row
  -> transcribe
  -> create normal user message from transcript
  -> create normal turn
```

Voice input is a message creation path, not a separate conversation type.

## Read-Aloud Flow

```text
user clicks read aloud on assistant message
  -> create audio_outputs row
  -> generate or play audio
  -> attach optional audio artifact
```

Read aloud is attached to an assistant message.

## Feedback Flow

```text
user clicks thumbs up/down
  -> create or update message_feedback row
  -> emit feedback.created or feedback.updated event
```

Feedback should attach to the exact message, turn, or model call being rated.

## Frontend Hooks

Socrates should use its own React hooks around its own WebSocket and HTTP contracts.

Initial hooks:

```text
useSocratesSocket()
useCurrentUser()
useOnboardingState()
useProjects()
useProject()
useProjectResources()
useProjectConversations()
useConversation()
useChatTurn()
useApprovals()
useContextUsage()
useVoiceInput()
useReadAloud()
useMessageFeedback()
```

Do not make `@ai-sdk/react` the core chat state engine in V1. Socrates needs typed events richer than a normal chat stream.

## Design Notes

The first UI should feel calm and serious, not busy.

Guidelines:

- Build the actual app, not a marketing landing page.
- Keep `/welcome` minimal and polished.
- Keep `/onboarding` one step.
- Make `/projects` practical and uncluttered.
- Make project dashboards resource-aware.
- Keep chat event-rich but visually organized.
- Do not copy Claude/Codex visuals directly; use them only as interaction references.
