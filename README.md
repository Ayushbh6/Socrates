# Socrates

> A local-first coding agent with a real task workspace, real file editing, and real guardrails.

<p align="center">
  <img alt="Socrates banner" src="https://img.shields.io/badge/Local--First-Coding%20Agent-111827?style=for-the-badge&labelColor=0f172a" />
  <img alt="Docker first" src="https://img.shields.io/badge/Docker-First-2563eb?style=for-the-badge&logo=docker&logoColor=white" />
  <img alt="Task backed" src="https://img.shields.io/badge/Task-Backed-059669?style=for-the-badge" />
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-Persisted-7c3aed?style=for-the-badge" />
</p>

Socrates is a chat-first, task-backed workspace agent. It can read uploaded resources, reason in chat, escalate into a structured task when real work is needed, and operate on a user-approved linked code workspace with explicit guardrails.

## Why Socrates

- Chat first, not task first. Simple questions stay simple.
- Real task workspaces with `inputs/`, `work/`, `outputs/`, and `logs/`.
- Real coding-agent tools: read, search, edit, patch, and execute commands.
- Real approval flow for risky commands and linked-workspace edits.
- Local-first persistence with SQLite plus filesystem-backed task state.

## Mental Model

```mermaid
flowchart LR
    U["User"] --> C["Chat"]
    C --> A["Socrates"]
    A --> P["Project Assets<br/>read/search"]
    A --> T["Task Workspace<br/>inputs / work / outputs / logs"]
    A --> W["Linked Workspace<br/>real user-approved code folder"]
```

Socrates works across 3 spaces:

| Space | What it is | What the agent can do |
| --- | --- | --- |
| `project` | Uploaded project resources | Read and search |
| `task` | Internal scratch workspace | Read, search, edit, patch, execute commands |
| `linked_workspace` | Real user-approved code folder | Read, search, edit, patch, execute commands with approval |

## Task Workspace Rules

Socrates does not get free-form filesystem access. The task workspace is structured and enforced:

| Folder | Purpose | Agent access |
| --- | --- | --- |
| `inputs/` | Query attachments and backend-managed task inputs | Read/search only |
| `work/` | Scripts, temp files, intermediate analysis | Read/search/edit/write |
| `outputs/` | Final deliverables | Read/search/edit/write |
| `logs/` | System-managed execution logs | Read/search only |

## Tool Surface

Socrates currently uses a compact 8-tool surface:

1. `list_files`
2. `read_file`
3. `search_files`
4. `edit_file`
5. `execute_command`
6. `create_task`
7. `write_project_note`
8. `get_system_time`

`edit_file` supports:
- `view`
- `create`
- `str_replace`
- `insert`
- `overwrite`
- `multi_edit`
- `apply_patch`

## Safety Model

- Chat mode is read-only except one small `write_project_note`.
- If real writing or command execution is needed, Socrates must create or resume a task.
- Linked workspace commands require approval.
- Destructive system commands are hard-blocked.
- Raw host paths and internal IDs are not model-facing.
- Command execution is Docker-gated. No unsafe local fallback is used in normal operation.

## Quick Start

### Prerequisite

- Docker Desktop

### Run

```bash
docker compose up --build
```

Then open:

- App: `http://localhost:3000`
- API: `http://localhost:8000/api/v1`

## What Starts Automatically

- SQLite database
- backend migrations
- persistent app-data volume
- managed per-project task workspaces
- managed per-project Python environments
- bind-mounted `./host-workspaces` root for linked workspaces

## What You Can Do

- upload PDFs, images, CSV/TSV, JSON, SQLite files, and code files
- ask questions directly in chat
- let Socrates escalate into a task for deeper analysis
- inspect and edit files in a linked code workspace
- run approved commands against a real workspace
- export task outputs back into project assets

## Local Development

### Backend

```bash
python -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.src.app:app --reload
```

### Frontend

```bash
cd frontend
npm ci
npm run dev
```

The frontend proxies API traffic to the backend in development.

## Project Docs

- [Memory](./MEMORY.md)
- [API Contracts](./CONTRACTS.md)
- [Database Structure](./dbstructure.md)

## Current Status

Socrates is already a real workspace coding agent:

- task-backed execution is live
- linked workspaces are live
- approval flow is live
- read/search/edit/patch flow is live
- structured task artifacts and export flow are live

The remaining work is hardening and iteration, not basic capability creation.
