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
