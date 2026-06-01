# Frontend Backend Contract

This file records durable contracts between UI, backend, local services, tools, and persisted data.

## Source Of Truth

- Keep request/response shapes, event names, tool boundaries, and UI expectations here.
- Prefer behavior-level contract notes over exhaustive type copies.
- Update this when a public boundary changes.

## API And Event Contracts

- HTTP endpoints:
- WebSocket/events:
- Tool interfaces:
- Error codes:

## UI Expectations

- What the frontend may assume:
- What the backend owns:
- What must be shown to the user:

## Update This When

- A route, event, schema, tool input/output, or error code changes.
- Frontend and backend responsibilities move.
- A contract bug is found and fixed.
