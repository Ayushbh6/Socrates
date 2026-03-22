#!/usr/bin/env zsh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_DIR="$ROOT_DIR/backend"
CONTAINER_NAME="premchat-postgres"
ROOT_VENV_PYTHON="$ROOT_DIR/venv/bin/python"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not on PATH."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed or not on PATH."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop and try again."
  exit 1
fi

if [[ ! -d "$FRONTEND_DIR" || ! -d "$BACKEND_DIR" ]]; then
  echo "Expected frontend/ and backend/ directories at the repo root."
  exit 1
fi

if [[ -x "$ROOT_VENV_PYTHON" ]]; then
  BACKEND_PYTHON="$ROOT_VENV_PYTHON"
else
  echo "Expected repo virtualenv at $ROOT_VENV_PYTHON."
  echo "Create or refresh it with:"
  echo "  python3 -m venv venv"
  echo "  source venv/bin/activate"
  echo "  pip install -r requirements.txt"
  exit 1
fi

cleanup() {
  trap - INT TERM EXIT

  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
  fi

  if [[ -n "${FRONTEND_PID:-}" ]] && kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
    kill "$FRONTEND_PID" >/dev/null 2>&1 || true
  fi

  wait >/dev/null 2>&1 || true
}

trap cleanup INT TERM EXIT

echo "Starting PostgreSQL in Docker..."
(
  cd "$ROOT_DIR"
  docker compose up -d postgres
) >/dev/null

echo "Waiting for PostgreSQL to become healthy..."
for _ in {1..30}; do
  db_status="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)"
  if [[ "$db_status" == "healthy" ]]; then
    break
  fi
  sleep 1
done

db_status="$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)"
if [[ "$db_status" != "healthy" ]]; then
  echo "PostgreSQL did not become healthy in time."
  exit 1
fi

if [[ ! -f "$BACKEND_DIR/.env" ]]; then
  echo "Warning: backend/.env is missing. Copy backend/.env.example to backend/.env before using provider-backed features."
fi

if ! "$BACKEND_PYTHON" -c "import fastapi, sqlalchemy, alembic, openai, jsonschema" >/dev/null 2>&1; then
  echo "Missing backend Python dependencies in repo venv."
  echo "Run:"
  echo "  source venv/bin/activate"
  echo "  pip install -r requirements.txt"
  exit 1
fi

echo "Running database migrations..."
(
  cd "$BACKEND_DIR"
  "$BACKEND_PYTHON" -m alembic upgrade head
) >/dev/null

echo "Starting backend and frontend..."

(
  cd "$BACKEND_DIR"
  "$BACKEND_PYTHON" -m uvicorn app.main:app --reload --app-dir "$BACKEND_DIR" 2>&1 \
    | sed -u 's/^/[backend] /'
) &
BACKEND_PID=$!

(
  cd "$FRONTEND_DIR"
  npm run dev 2>&1 | sed -u 's/^/[frontend] /'
) &
FRONTEND_PID=$!

echo "PremChat development stack is running."
echo "Frontend: http://localhost:3000"
echo "Backend:  http://localhost:8000"

while true; do
  if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    echo "Backend exited. Shutting down frontend..."
    exit 1
  fi

  if ! kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
    echo "Frontend exited. Shutting down backend..."
    exit 1
  fi

  sleep 1
done
