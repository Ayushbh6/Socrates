---
socrates_doc: repo_contracts
schema_version: 1
owner_tool: repo_docs
scope: workspace
index_tags: [repo_docs]
---

# Contracts

This file records durable public/internal contracts that future changes must preserve.

<!-- socrates:section id="tool_contracts" kind="contracts" tags="tools" -->
## Tool Contracts

- Tool inputs/outputs:
- Tool-specific mutation boundaries:
- Tool failure and retry behavior:
<!-- /socrates:section -->

<!-- socrates:section id="api_contracts" kind="contracts" tags="api" -->
## API Contracts

- API routes:
- Request/response envelopes:
- Compatibility notes:
<!-- /socrates:section -->

<!-- socrates:section id="db_event_contracts" kind="contracts" tags="db,events" -->
## Database And Event Contracts

- Persistence invariants:
- Event invariants:
- Migration notes:
<!-- /socrates:section -->

<!-- socrates:section id="frontend_backend" kind="contracts" tags="frontend,backend" -->
## Frontend Backend Responsibilities

- Frontend responsibilities:
- Backend responsibilities:
- Shared contract ownership:
<!-- /socrates:section -->

<!-- socrates:section id="change_log" kind="changes" tags="maintenance" -->
## Change Log

- Update when a schema, event, tool, API, command, or storage invariant changes.
- Update when frontend/backend responsibilities move.
- Update when a bug reveals an implicit contract that should be explicit.
<!-- /socrates:section -->
