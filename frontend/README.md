# PremChat Frontend

Run the full product from the repo root:

```bash
docker compose up --build
```

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
