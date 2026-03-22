# PremChat

A calmer way to think with light. PremChat is a minimalist, serene AI interface designed to provide a focused and tranquil environment for thinking and collaboration.

## Features

- **Sentient Orb**: A visual centerpiece that represents the AI's presence.
- **Minimalist Design**: A clean, dark-themed UI focused on clarity and calm.
- **Workspaces**: Dedicated areas for different projects and contexts.
- **Persistent Chat**: Conversations and messages persist in PostgreSQL through the FastAPI backend.
- **Model Switching**: Choose between supported OpenAI and OpenRouter models per conversation.
- **Thinking Toggle**: Turn provider reasoning on or off from the composer.

Default local ports:
- Frontend: `3000`
- Backend API: `8000`
- PremChat PostgreSQL: `5433`

## Project Structure

The project is organized into a frontend (Next.js) and a backend (Python).

```
.
├── backend/           # FastAPI backend, SQLAlchemy models, Alembic migrations, tests
├── docker-compose.yml # Local PostgreSQL + pgvector
├── frontend/          # Next.js application
│   ├── src/
│   │   ├── app/      # App router pages
│   │   ├── components/ # Shared UI components
│   │   ├── hooks/    # Custom React hooks
│   │   └── lib/      # Utility functions
├── requirements.txt   # Repo Python dependencies used by the backend
└── venv/              # Repo virtual environment used by the backend
```

## Getting Started

### One-command development

From the repo root, you can start the local stack with:

```bash
./start-app.sh
```

Or equivalently:

```bash
make dev
```

This will:
- start PostgreSQL in Docker in detached mode
- wait for the database to become healthy
- start the FastAPI backend
- start the Next.js frontend
- stream backend and frontend logs in one terminal
- clean up the frontend/backend processes when you stop the command

The script expects backend Python dependencies to already be installed in the repo `venv/`.

Provider-backed chat requires `backend/.env` with your API keys, for example:

```bash
OPENAI_API_KEY=...
OPENROUTER_API_KEY=...
```

You can manage the database separately with:

```bash
make db-up
make db-down
make db-logs
```

### Frontend

1. Navigate to the `frontend` directory:
   ```bash
   cd frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the development server:
   ```bash
   npm run dev
   ```
   Open [http://localhost:3000](http://localhost:3000) to view the application.

### Backend

1. Create or activate the repo virtual environment:
   ```bash
   source venv/bin/activate
   ```
2. Install Python dependencies from the repo root:
   ```bash
   pip install -r requirements.txt
   ```
3. Start local PostgreSQL with pgvector:
   ```bash
   docker compose up -d
   ```
   PremChat binds PostgreSQL to `localhost:5433` so it does not collide with other apps already using `5432`.
4. Navigate to the backend:
   ```bash
   cd backend
   ```
5. Copy the environment example:
   ```bash
   cp .env.example .env
   ```
6. Run the initial database migration:
   ```bash
   alembic upgrade head
   ```
7. Configure provider API keys in `backend/.env`.
8. Start the backend development server:
   ```bash
   uvicorn app.main:app --reload
   ```
9. Run backend tests against a Postgres database:
   ```bash
   TEST_DATABASE_URL=postgresql+asyncpg://premchat:premchat@localhost:5433/premchat pytest
   ```

### Live chat flow

- The frontend still talks only to app-owned Next.js routes.
- Those routes now proxy to the FastAPI backend for:
  - conversation list/detail
  - model list
  - persisted message sends
- Supported live-selectable chat models currently include:
  - `gpt-5.2`
  - `gpt-5.4-mini`
  - `minimax/minimax-m2.7`
  - `qwen/qwen3.5-397b-a17b`
  - `moonshotai/kimi-k2.5`

## Tech Stack

- **Frontend**: Next.js, Tailwind CSS, Lucide React, Framer Motion.
- **Styling**: Tailwind CSS with custom theme integration.
- **Backend**: FastAPI, SQLAlchemy 2.x, Alembic, PostgreSQL, pgvector.
