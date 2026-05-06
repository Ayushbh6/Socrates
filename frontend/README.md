# PremChat Frontend

Run the backend from the repo root:

```bash
python -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
uvicorn backend.src.app:app --host 127.0.0.1 --port 8000 --reload
```

Socrates persists runtime data in `~/.socrates`, outside this repository. Linked workspaces are explicit absolute paths approved by the user.

For frontend-only development:

```bash
npm ci
npm run dev
```

The frontend expects the backend API at `/api/v1`. In local Vite development that path is proxied using `VITE_API_PROXY_TARGET`.

Create `frontend/.env.local`:

```bash
VITE_API_PROXY_TARGET=http://127.0.0.1:8000
```

Use `127.0.0.1`, not `localhost`, so the Vite dev WebSocket proxy matches the backend IPv4 bind on macOS.
