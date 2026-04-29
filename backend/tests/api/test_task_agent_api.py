from __future__ import annotations

import hashlib
from pathlib import Path
from fastapi.testclient import TestClient
import pytest

from backend.src.app import create_app
from backend.src.core.schema import LLMResponse, ToolCall, UsageStats
from backend.src.db.models import AgentRun, TaskArtifact, ToolExecution
from backend.src.db.session import get_session_factory


class FakeAsyncStream:
    def __init__(self, chunks):
        self._chunks = list(chunks)
        self._index = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._index >= len(self._chunks):
            raise StopAsyncIteration
        chunk = self._chunks[self._index]
        self._index += 1
        return chunk

    async def aclose(self):
        return None


class FakeProvider:
    def __init__(self, turns):
        self.turns = list(turns)
        self.requests = []

    async def agenerate(self, request):
        self.requests.append(request)
        return self.turns.pop(0)["fallback"]

    def astream(self, request):
        self.requests.append(request)
        turn = self.turns.pop(0)
        return FakeAsyncStream(turn["chunks"])


@pytest.fixture
def client(monkeypatch, tmp_path):
    app_data_dir = tmp_path / "appdata"
    monkeypatch.setenv("APP_DATA_DIR", str(app_data_dir))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'premchat.sqlite3'}")

    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


def bootstrap_user_and_project(client: TestClient) -> tuple[str, str]:
    assert (
        client.post(
            "/api/v1/bootstrap", json={"display_name": "Ayush", "preferences": {}}
        ).status_code
        == 201
    )
    project = client.post("/api/v1/projects", json={"name": "Task Lab"})
    assert project.status_code == 201
    project_id = project.json()["id"]
    conversation = client.post(
        f"/api/v1/projects/{project_id}/conversations", json={"title": "Task flow"}
    )
    assert conversation.status_code == 201
    return project_id, conversation.json()["id"]


STANDARD_VALID_PLAN = "\n".join(
    [
        "# Plan",
        "",
        "## Summary",
        "Summary line.",
        "",
        "## Approach",
        "Approach line.",
        "",
        "## Execution Steps",
        "Step one.",
        "",
        "## Risks",
        "Risk line.",
        "",
        "## Verification",
        "Verify result.",
        "",
    ]
)

STANDARD_VALID_TODO = "\n".join(
    [
        "# Todo",
        "",
        "## Checklist",
        "- [ ] T1: Do the work",
        "- [x] T2: Verify it",
        "",
    ]
)

STANDARD_COMPLETED_TODO = "\n".join(
    [
        "# Todo",
        "",
        "## Checklist",
        "- [x] T1: Do the work",
        "- [X] T2: Verify it",
        "",
    ]
)


def _apply_patch_rejecting_invalid_replacement_plan() -> str:
    """Replace plan.md with a doc missing required sections; also updates work file (rejected before commit)."""
    invalid = ["# Plan", "", "## Summary", "Missing required sections."]
    hunk = (
        ["@@"]
        + [f"-{l}" for l in STANDARD_VALID_PLAN.splitlines()]
        + [f"+{l}" for l in invalid]
    )
    return "\n".join(
        [
            "*** Begin Patch",
            "*** Update File: work/source.txt",
            "@@",
            "-before",
            "+after",
            "*** Update File: plan.md",
            *hunk,
            "*** End Patch",
        ]
    )


def approve_pending_plan_approval_for_task(client: TestClient, task_id: str) -> None:
    response = client.get(f"/api/v1/tasks/{task_id}/approvals")
    assert response.status_code == 200
    for item in response.json():
        if (
            item["status"] == "pending"
            and "plan" in item.get("approval_type", "").lower()
        ):
            r = client.post(
                f"/api/v1/task-approvals/{item['id']}",
                json={"approved": True, "note": "ok"},
            )
            assert r.status_code == 200
            return
    raise AssertionError("Expected a pending plan_approval, found none.")


def drain_run_events(client: TestClient, run_id: str) -> list[dict]:
    events = []
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            events.append(payload)
            if payload["type"] in {"run.completed", "run.failed"}:
                return events


def provider_for_task_and_plan(
    *, create_id: str, plan_id: str, title: str = "Closure", goal: str = "Close task."
) -> FakeProvider:
    return FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Create task.",
                        tool_calls=[
                            ToolCall(
                                id=create_id,
                                name="create_task",
                                arguments={"title": title, "goal": goal},
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Write plan.",
                        tool_calls=[
                            ToolCall(
                                id=plan_id,
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Plan ready.",
                        usage=UsageStats(),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )


def provider_for_todo_and_work(
    *, todo_id: str, work_id: str, todo_content: str
) -> FakeProvider:
    return FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Todo and work.",
                        tool_calls=[
                            ToolCall(
                                id=todo_id,
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": todo_content,
                                },
                            ),
                            ToolCall(
                                id=work_id,
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "outputs/result.txt",
                                    "content": "done\n",
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Work ready.",
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )


def provider_for_status_update(
    *, call_id: str, status: str, summary: str
) -> FakeProvider:
    return FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Closing task.",
                        tool_calls=[
                            ToolCall(
                                id=call_id,
                                name="update_task_status",
                                arguments={"status": status, "result_summary": summary},
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Closure handled.",
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )


def install_provider_stack(monkeypatch, providers: list[FakeProvider]) -> None:
    stack = list(providers)

    def _provider(*_args, **_kwargs) -> FakeProvider:
        if not stack:
            return providers[-1]
        return stack.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", _provider)


def prepare_task_with_todo(
    client: TestClient,
    monkeypatch,
    *,
    todo_content: str,
    extra_providers: list[FakeProvider] | None = None,
) -> tuple[str, str, dict]:
    install_provider_stack(
        monkeypatch,
        [
            provider_for_task_and_plan(create_id="prep_create", plan_id="prep_plan"),
            provider_for_todo_and_work(
                todo_id="prep_todo", work_id="prep_work", todo_content=todo_content
            ),
            *(extra_providers or []),
        ],
    )
    _, conversation_id = bootstrap_user_and_project(client)
    first = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Prepare task for closure.", "asset_ids": []},
    )
    assert first.status_code == 202
    drain_run_events(client, first.json()["agent_run_id"])
    task = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    approve_pending_plan_approval_for_task(client, task["id"])
    second = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Create todo and outputs.", "asset_ids": []},
    )
    assert second.status_code == 202
    drain_run_events(client, second.json()["agent_run_id"])
    return (
        first.json()["agent_run_id"],
        conversation_id,
        client.get(f"/api/v1/conversations/{conversation_id}/active-task").json(),
    )


def upload_text_asset(
    client: TestClient, project_id: str, filename: str, content: bytes
) -> str:
    response = client.post(
        f"/api/v1/projects/{project_id}/assets",
        files={"file": (filename, content, "text/plain")},
    )
    assert response.status_code == 201
    return response.json()["id"]


def test_agent_creates_task_and_persists_active_task(client: TestClient, monkeypatch):
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Let us create a task.",
                        tool_calls=[
                            ToolCall(
                                id="call_1",
                                name="create_task",
                                arguments={
                                    "title": "Inspect report",
                                    "goal": "Review the uploaded report safely.",
                                    "success_criteria": "Produce a concise summary.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="The task is prepared and I am ready to proceed.",
                        usage=UsageStats(total_tokens=5),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr(
        "backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider
    )

    project_id, conversation_id = bootstrap_user_and_project(client)
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "Please analyze this document properly.",
            "asset_ids": [],
        },
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    ws_types: list[str] = []
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            ws_types.append(payload["type"])
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    assert "task.created" in ws_types

    active_task = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    assert active_task.status_code == 200
    task_payload = active_task.json()
    assert task_payload["title"] == "Inspect report"
    assert task_payload["status"] == "active"
    task_markdown = Path(task_payload["workspace_root"], "task.md").read_text(
        encoding="utf-8"
    )
    assert task_markdown.startswith("# Task\n")
    assert "## Objective\nInspect report" in task_markdown
    assert "## Context\nReview the uploaded report safely." in task_markdown
    assert "## Constraints\n" in task_markdown
    assert "## Deliverables\n" in task_markdown
    assert "## Success Criteria\nProduce a concise summary." in task_markdown

    messages = client.get(f"/api/v1/conversations/{conversation_id}/messages")
    assert messages.status_code == 200
    message_payload = messages.json()
    assert len(message_payload) == 2
    assert all(message["execution_mode"] == "task" for message in message_payload)
    assert all(message["task_id"] == task_payload["id"] for message in message_payload)

    session = get_session_factory()()
    try:
        run = session.get(AgentRun, run_id)
        assert run is not None
        assert run.execution_mode == "task"
        assert run.task_id == task_payload["id"]
        execution = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "call_1")
            .one()
        )
        assert execution.result_json["task_package_contract"]["required_files"] == [
            "task.md",
            "plan.md",
            "todo.md",
        ]
        assert execution.result_json["task_package_contract"]["files"]["plan.md"][
            "required_headings"
        ] == [
            "# Plan",
            "## Summary",
            "## Approach",
            "## Execution Steps",
            "## Risks",
            "## Verification",
        ]
        assert "plan.md" in execution.result_json["next_step"]
    finally:
        session.close()


def test_risky_command_creates_approval_and_resolution_is_traced(
    client: TestClient, monkeypatch
):
    monkeypatch.setenv("PREMCHAT_COMMAND_SANDBOX", "docker")
    run1_provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I should open a task and write a plan first.",
                        tool_calls=[
                            ToolCall(
                                id="call_create_task",
                                name="create_task",
                                arguments={
                                    "title": "Inspect dependency",
                                    "goal": "Check whether a package install is needed.",
                                    "success_criteria": "Wait for approval before installing anything.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Writing plan.",
                        tool_calls=[
                            ToolCall(
                                id="write_plan",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Plan drafted.",
                        usage=UsageStats(total_tokens=3),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    run2_provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need approval for this install.",
                        tool_calls=[
                            ToolCall(
                                id="write_todo",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": STANDARD_VALID_TODO,
                                },
                            ),
                            ToolCall(
                                id="call_install",
                                name="execute_command",
                                arguments={
                                    "scope": "task",
                                    "argv": [
                                        "python",
                                        "-m",
                                        "pip",
                                        "install",
                                        "pandas",
                                    ],
                                    "cwd": "work",
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Approval is required before I can continue.",
                        usage=UsageStats(total_tokens=7),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    provider_stack: list[FakeProvider] = [run1_provider, run2_provider]

    def get_provider_ladder(*_a, **_k) -> FakeProvider:
        if not provider_stack:
            return run2_provider
        return provider_stack.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", get_provider_ladder)

    _, conversation_id = bootstrap_user_and_project(client)
    r1 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "Install pandas if needed and continue (phase 1: task and plan).",
            "asset_ids": [],
        },
    )
    assert r1.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r1.json()['agent_run_id']}/stream"
    ) as ws:
        while True:
            p = ws.receive_json()
            if p["type"] in {"run.completed", "run.failed"}:
                break

    task = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    approve_pending_plan_approval_for_task(client, task["id"])

    r2 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Now install pandas if needed.", "asset_ids": []},
    )
    assert r2.status_code == 202
    run_id = r2.json()["agent_run_id"]

    ws_types: list[str] = []
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            ws_types.append(payload["type"])
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    assert "task.approval.requested" in ws_types

    active_task = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    assert active_task.status_code == 200
    task_payload = active_task.json()
    assert task_payload["status"] == "awaiting_approval"

    approvals = client.get(f"/api/v1/tasks/{task_payload['id']}/approvals")
    assert approvals.status_code == 200
    approval_payload = [
        a
        for a in approvals.json()
        if a["approval_type"] == "dependency_install" and a["status"] == "pending"
    ]
    assert len(approval_payload) == 1

    resolved = client.post(
        f"/api/v1/task-approvals/{approval_payload[0]['id']}",
        json={"approved": True, "note": "Proceed."},
    )
    assert resolved.status_code == 200
    resolved_payload = resolved.json()
    assert resolved_payload["status"] == "approved"

    active_task_after = client.get(
        f"/api/v1/conversations/{conversation_id}/active-task"
    )
    assert active_task_after.status_code == 200
    assert active_task_after.json()["status"] == "active"

    events = client.get(f"/api/v1/agent-runs/{run_id}/events")
    assert events.status_code == 200
    event_types = [event["event_type"] for event in events.json()]
    assert "task.approval.resolved" in event_types


def test_execute_command_tool_not_exposed_outside_docker(
    client: TestClient, monkeypatch
):
    monkeypatch.delenv("PREMCHAT_COMMAND_SANDBOX", raising=False)
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I can answer without commands.",
                        usage=UsageStats(total_tokens=3),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            }
        ]
    )
    monkeypatch.setattr(
        "backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider
    )

    _, conversation_id = bootstrap_user_and_project(client)
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Read the project and answer directly.", "asset_ids": []},
    )
    assert response.status_code == 202

    run_id = response.json()["agent_run_id"]
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    assert provider.requests
    tool_names = [tool.name for tool in provider.requests[0].tools or []]
    assert "execute_command" not in tool_names


def test_execute_command_tool_exposed_inside_docker(client: TestClient, monkeypatch):
    monkeypatch.setenv("PREMCHAT_COMMAND_SANDBOX", "docker")
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I can see the command tool.",
                        usage=UsageStats(total_tokens=3),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            }
        ]
    )
    monkeypatch.setattr(
        "backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider
    )

    _, conversation_id = bootstrap_user_and_project(client)
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Read the project and answer directly.", "asset_ids": []},
    )
    assert response.status_code == 202

    run_id = response.json()["agent_run_id"]
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    assert provider.requests
    tool_names = [tool.name for tool in provider.requests[0].tools or []]
    assert "execute_command" in tool_names


def test_query_attachment_is_copied_into_task_inputs(client: TestClient, monkeypatch):
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Creating a task for the uploaded file.",
                        tool_calls=[
                            ToolCall(
                                id="call_1",
                                name="create_task",
                                arguments={
                                    "title": "Inspect input",
                                    "goal": "Work with the attached file.",
                                    "success_criteria": "Task is ready with inputs.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="The task is ready.",
                        usage=UsageStats(total_tokens=4),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr(
        "backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider
    )

    project_id, conversation_id = bootstrap_user_and_project(client)
    asset_id = upload_text_asset(client, project_id, "brief.txt", b"hello from input")

    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Use the attached file.", "asset_ids": [asset_id]},
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    active_task = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    assert active_task.status_code == 200
    task = active_task.json()

    artifacts = client.get(f"/api/v1/tasks/{task['id']}/artifacts")
    assert artifacts.status_code == 200
    artifact_payload = artifacts.json()
    input_artifacts = [
        artifact
        for artifact in artifact_payload
        if artifact["artifact_role"] == "input"
    ]
    assert len(input_artifacts) == 1
    assert input_artifacts[0]["relative_path"] == "inputs/brief.txt"
    assert (
        Path(task["workspace_root"], "inputs", "brief.txt").read_text(encoding="utf-8")
        == "hello from input"
    )


def test_project_read_file_supports_line_ranges_and_search_filters(
    client: TestClient, monkeypatch
):
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I will inspect the uploaded project file.",
                        tool_calls=[
                            ToolCall(
                                id="project_read",
                                name="read_file",
                                arguments={
                                    "scope": "project",
                                    "path": "notes.txt",
                                    "line_start": 2,
                                    "line_end": 3,
                                },
                            ),
                            ToolCall(
                                id="project_search",
                                name="search_files",
                                arguments={
                                    "scope": "project",
                                    "query": "wisdom",
                                    "include_glob": "*.txt",
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="The project file was inspected.",
                        usage=UsageStats(total_tokens=4),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr(
        "backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider
    )

    project_id, conversation_id = bootstrap_user_and_project(client)
    upload_text_asset(
        client,
        project_id,
        "notes.txt",
        b"alpha\nBeta\nwisdom begins in wonder\nDelta\n",
    )

    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Inspect the project note.", "asset_ids": []},
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    session = get_session_factory()()
    try:
        read_exec = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "project_read")
            .one()
        )
        assert read_exec.result_json["line_start"] == 2
        assert read_exec.result_json["line_end"] == 3
        assert read_exec.result_json["content"] == "Beta\nwisdom begins in wonder"

        search_exec = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "project_search")
            .one()
        )
        assert search_exec.result_json["match_count"] == 1
        assert search_exec.result_json["matches"][0]["filename"] == "notes.txt"
        assert search_exec.result_json["matches"][0]["line_no"] == 3
    finally:
        session.close()


def test_second_chat_note_write_requires_task(client: TestClient, monkeypatch):
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I will save a short note.",
                        tool_calls=[
                            ToolCall(
                                id="note_1",
                                name="write_project_note",
                                arguments={
                                    "path_or_title": "todo",
                                    "content": "first line",
                                },
                            ),
                            ToolCall(
                                id="note_2",
                                name="write_project_note",
                                arguments={
                                    "path_or_title": "todo",
                                    "content": "second line",
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="The second note write was blocked.",
                        usage=UsageStats(total_tokens=4),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr(
        "backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider
    )

    _, conversation_id = bootstrap_user_and_project(client)
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Keep two small notes for me.", "asset_ids": []},
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    session = get_session_factory()()
    try:
        executions = (
            session.query(ToolExecution)
            .filter(
                ToolExecution.agent_run_id == run_id,
                ToolExecution.tool_name == "write_project_note",
            )
            .order_by(ToolExecution.created_at.asc())
            .all()
        )
        assert len(executions) == 2
        assert executions[0].result_json["asset_id"]
        assert executions[1].result_json["error_type"] == "task_required"
    finally:
        session.close()


def test_task_search_files_supports_globs_and_case_controls(
    client: TestClient, monkeypatch
):
    p1s = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task and plan.",
                        tool_calls=[
                            ToolCall(
                                id="create_task_call",
                                name="create_task",
                                arguments={
                                    "title": "Search task files",
                                    "goal": "Prepare files for searching.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Gating: plan and todo first.",
                        tool_calls=[
                            ToolCall(
                                id="wplan_s",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="ok",
                        usage=UsageStats(total_tokens=2),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    p2s = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I will create and search files.",
                        tool_calls=[
                            ToolCall(
                                id="wtd_s",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": STANDARD_VALID_TODO,
                                },
                            ),
                            ToolCall(
                                id="seed_a",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/a.py",
                                    "content": "Needle\nneedle\n",
                                },
                            ),
                            ToolCall(
                                id="seed_b",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/b.txt",
                                    "content": "needle only here\n",
                                },
                            ),
                            ToolCall(
                                id="search_case",
                                name="search_files",
                                arguments={
                                    "scope": "task",
                                    "query": "Needle",
                                    "path": "work",
                                    "include_glob": "*.py",
                                    "case_sensitive": True,
                                },
                            ),
                            ToolCall(
                                id="search_regex",
                                name="search_files",
                                arguments={
                                    "scope": "task",
                                    "query": "^needle$",
                                    "path": "work",
                                    "include_glob": "*.py",
                                    "regex": True,
                                    "case_sensitive": True,
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="The search completed.",
                        usage=UsageStats(total_tokens=4),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    sstack: list[FakeProvider] = [p1s, p2s]

    def gsf(*_a, **_k) -> FakeProvider:
        if not sstack:
            return p2s
        return sstack.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", gsf)

    _, conversation_id = bootstrap_user_and_project(client)
    r0 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Search the task files (1).", "asset_ids": []},
    )
    assert r0.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r0.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    ts = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    approve_pending_plan_approval_for_task(client, ts["id"])
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Search the task files (2).", "asset_ids": []},
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    session = get_session_factory()()
    try:
        case_exec = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "search_case")
            .one()
        )
        assert case_exec.result_json["match_count"] == 1
        assert case_exec.result_json["matches"][0]["path"] == "work/a.py"
        assert case_exec.result_json["matches"][0]["line_no"] == 1

        regex_exec = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "search_regex")
            .one()
        )
        assert regex_exec.result_json["match_count"] == 1
        assert regex_exec.result_json["matches"][0]["path"] == "work/a.py"
        assert regex_exec.result_json["matches"][0]["line_no"] == 2
    finally:
        session.close()


def test_edit_file_supports_exact_replace_and_conflict_detection(
    client: TestClient, monkeypatch
):
    original = "alpha\nbeta\n"
    correct_sha = hashlib.sha256(original.encode("utf-8")).hexdigest()
    wrong_sha = hashlib.sha256(b"something else").hexdigest()
    p1 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task and plan first.",
                        tool_calls=[
                            ToolCall(
                                id="create_task_call",
                                name="create_task",
                                arguments={
                                    "title": "Multi edit",
                                    "goal": "Apply conflict-aware edits.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Write plan for approval.",
                        tool_calls=[
                            ToolCall(
                                id="wplan_m",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Planned.",
                        usage=UsageStats(total_tokens=3),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    p2 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I will create and then batch edit the file.",
                        tool_calls=[
                            ToolCall(
                                id="write_todo_m",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": STANDARD_VALID_TODO,
                                },
                            ),
                            ToolCall(
                                id="seed_file",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/file.txt",
                                    "content": original,
                                },
                            ),
                            ToolCall(
                                id="edit_file_call",
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/file.txt",
                                    "expected_sha256": correct_sha,
                                    "old_text": original,
                                    "new_text": "ALPHA\nbeta\ngamma\n",
                                },
                            ),
                            ToolCall(
                                id="conflict_edit",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/file.txt",
                                    "overwrite": True,
                                    "expected_sha256": wrong_sha,
                                    "content": "should fail\n",
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="The batch edit worked and the stale edit was blocked.",
                        usage=UsageStats(total_tokens=5),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    mstack: list[FakeProvider] = [p1, p2]

    def gmult(*_a, **_k) -> FakeProvider:
        if not mstack:
            return p2
        return mstack.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", gmult)

    _, conversation_id = bootstrap_user_and_project(client)
    r0 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Batch edit the file (part 1: plan).", "asset_ids": []},
    )
    assert r0.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r0.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    t0 = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    approve_pending_plan_approval_for_task(client, t0["id"])
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Batch edit the file (part 2).", "asset_ids": []},
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    active_task = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    task = active_task.json()
    assert (
        Path(task["workspace_root"], "work", "file.txt").read_text(encoding="utf-8")
        == "ALPHA\nbeta\ngamma\n"
    )

    session = get_session_factory()()
    try:
        conflict_exec = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "conflict_edit")
            .one()
        )
        assert conflict_exec.result_json["error_type"] == "RuntimeError"
        assert "Edit conflict" in conflict_exec.result_json["message"]
    finally:
        session.close()


def test_task_edits_only_allow_work_and_outputs_and_outputs_can_be_exported(
    client: TestClient, monkeypatch
):
    p1 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task and plan first.",
                        tool_calls=[
                            ToolCall(
                                id="create_task_call",
                                name="create_task",
                                arguments={
                                    "title": "Prepare files",
                                    "goal": "Create work and output files safely.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Write plan for approval.",
                        tool_calls=[
                            ToolCall(
                                id="write_plan",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Planned.",
                        usage=UsageStats(total_tokens=3),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    p2 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Writing only to allowed locations after approval.",
                        tool_calls=[
                            ToolCall(
                                id="write_todo",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": STANDARD_VALID_TODO,
                                },
                            ),
                            ToolCall(
                                id="edit_inputs",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "inputs/blocked.txt",
                                    "content": "nope",
                                },
                            ),
                            ToolCall(
                                id="edit_work",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/script.py",
                                    "content": "print('ok')\n",
                                },
                            ),
                            ToolCall(
                                id="edit_output",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "outputs/result.txt",
                                    "content": "done\n",
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="The files are in place.",
                        usage=UsageStats(total_tokens=5),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    st: list[FakeProvider] = [p1, p2]

    def gprov(*_a, **_k) -> FakeProvider:
        if not st:
            return p2
        return st.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", gprov)

    project_id, conversation_id = bootstrap_user_and_project(client)
    r1 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "Create the files you need (part 1: task and plan).",
            "asset_ids": [],
        },
    )
    assert r1.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r1.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    t = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    approve_pending_plan_approval_for_task(client, t["id"])
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "Create the files you need (part 2: todo and work).",
            "asset_ids": [],
        },
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    active_task = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    assert active_task.status_code == 200
    task = active_task.json()

    session = get_session_factory()()
    try:
        failed_edit = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "edit_inputs")
            .one()
        )
        assert failed_edit.result_json["error_type"] == "PermissionError"
    finally:
        session.close()

    artifacts = client.get(f"/api/v1/tasks/{task['id']}/artifacts")
    assert artifacts.status_code == 200
    artifact_payload = artifacts.json()
    output_artifact = next(
        artifact
        for artifact in artifact_payload
        if artifact["relative_path"] == "outputs/result.txt"
    )
    assert output_artifact["artifact_role"] == "output"
    assert output_artifact["promoted_to_asset"] is False
    assert Path(task["workspace_root"], "work", "script.py").exists()
    assert not Path(task["workspace_root"], "inputs", "blocked.txt").exists()

    export_response = client.post(
        f"/api/v1/task-artifacts/{output_artifact['id']}/export"
    )
    assert export_response.status_code == 200
    exported = export_response.json()
    assert exported["promoted_to_asset"] is True
    assert exported["asset_id"] is not None


def test_task_package_root_writes_are_validated(client: TestClient, monkeypatch):
    valid_plan = "\n".join(
        [
            "# Plan",
            "",
            "## Summary",
            "Prepare the deliverable carefully.",
            "",
            "## Approach",
            "Read the available inputs and draft the result.",
            "",
            "## Execution Steps",
            "First inspect files, then write the output.",
            "",
            "## Risks",
            "Input details may be incomplete.",
            "",
            "## Verification",
            "Review the final output before responding.",
            "",
        ]
    )
    valid_todo = "\n".join(
        [
            "# Todo",
            "",
            "## Checklist",
            "- [ ] T1: Inspect the input material",
            "- [x] T2: Confirm the output format",
            "",
        ]
    )
    provider_part1 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task.",
                        tool_calls=[
                            ToolCall(
                                id="create_task_call",
                                name="create_task",
                                arguments={
                                    "title": "Package files",
                                    "goal": "Exercise task package validation.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Writing plan files.",
                        tool_calls=[
                            ToolCall(
                                id="invalid_plan",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": "# Plan\n\n## Summary\nOnly a summary.\n",
                                },
                            ),
                            ToolCall(
                                id="valid_plan",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": valid_plan,
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Plan step done.",
                        usage=UsageStats(total_tokens=5),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    provider_part2 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Writing todo and work after plan approval.",
                        tool_calls=[
                            ToolCall(
                                id="invalid_todo",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": "# Todo\n\n## Checklist\n- do the work\n",
                                },
                            ),
                            ToolCall(
                                id="valid_todo",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": valid_todo,
                                },
                            ),
                            ToolCall(
                                id="blocked_root",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "notes.md",
                                    "content": "not allowed\n",
                                },
                            ),
                            ToolCall(
                                id="valid_work",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/scratch.txt",
                                    "content": "still allowed\n",
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Validation is complete.",
                        usage=UsageStats(total_tokens=5),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    pstack2: list[FakeProvider] = [provider_part1, provider_part2]

    def get_p2(*_a, **_k) -> FakeProvider:
        if not pstack2:
            return provider_part2
        return pstack2.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", get_p2)

    _, conversation_id = bootstrap_user_and_project(client)
    r1 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Create package files (plan phase).", "asset_ids": []},
    )
    assert r1.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r1.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    task = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    approve_pending_plan_approval_for_task(client, task["id"])

    r2 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "Continue with todo and work (phase 2).",
            "asset_ids": [],
        },
    )
    assert r2.status_code == 202
    run_id = r2.json()["agent_run_id"]
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    task = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    task_root = Path(task["workspace_root"])
    assert (task_root / "plan.md").read_text(encoding="utf-8") == valid_plan
    assert (task_root / "todo.md").read_text(encoding="utf-8") == valid_todo
    assert (task_root / "work" / "scratch.txt").read_text(
        encoding="utf-8"
    ) == "still allowed\n"
    assert not (task_root / "notes.md").exists()

    session = get_session_factory()()
    try:
        invalid_plan = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "invalid_plan")
            .one()
        )
        assert invalid_plan.result_json["error_type"] == "missing_required_sections"
        assert "## Execution Steps" in invalid_plan.result_json["missing_sections"]
        invalid_todo = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "invalid_todo")
            .one()
        )
        assert invalid_todo.result_json["error_type"] == "invalid_task_file_format"
        blocked_root = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "blocked_root")
            .one()
        )
        assert blocked_root.result_json["error_type"] == "PermissionError"
    finally:
        session.close()


def test_apply_patch_updates_work_and_creates_output_artifact(
    client: TestClient, monkeypatch
):
    p1 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task and planning gate.",
                        tool_calls=[
                            ToolCall(
                                id="create_task_call",
                                name="create_task",
                                arguments={
                                    "title": "Patch files",
                                    "goal": "Apply a safe patch.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Write plan, todo, seed for patch next.",
                        tool_calls=[
                            ToolCall(
                                id="wplan",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Phase 1 done.",
                        usage=UsageStats(total_tokens=3),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    p2 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Preparing the source file and patch.",
                        tool_calls=[
                            ToolCall(
                                id="wtodo",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": STANDARD_VALID_TODO,
                                },
                            ),
                            ToolCall(
                                id="seed_file",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/source.py",
                                    "content": 'def greet():\n    return "hi"\n',
                                },
                            ),
                            ToolCall(
                                id="apply_patch_call",
                                name="apply_patch",
                                arguments={
                                    "scope": "task",
                                    "patch_text": "\n".join(
                                        [
                                            "*** Begin Patch",
                                            "*** Update File: work/source.py",
                                            "@@",
                                            " def greet():",
                                            '-    return "hi"',
                                            '+    return "hello"',
                                            "*** Add File: outputs/summary.txt",
                                            "+patched output",
                                            "*** End Patch",
                                        ]
                                    ),
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="The patch is applied.",
                        usage=UsageStats(total_tokens=5),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    st: list[FakeProvider] = [p1, p2]

    def gprov2(*_a, **_k) -> FakeProvider:
        if not st:
            return p2
        return st.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", gprov2)

    _, conversation_id = bootstrap_user_and_project(client)
    r1 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Patch the task files (part 1).", "asset_ids": []},
    )
    assert r1.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r1.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    t = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    approve_pending_plan_approval_for_task(client, t["id"])
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Patch the task files (part 2).", "asset_ids": []},
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    active_task = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    task = active_task.json()
    assert (
        Path(task["workspace_root"], "work", "source.py").read_text(encoding="utf-8")
        == 'def greet():\n    return "hello"\n'
    )

    artifacts = client.get(f"/api/v1/tasks/{task['id']}/artifacts")
    assert artifacts.status_code == 200
    output_artifact = next(
        artifact
        for artifact in artifacts.json()
        if artifact["relative_path"] == "outputs/summary.txt"
    )
    assert output_artifact["artifact_role"] == "output"
    assert (
        Path(task["workspace_root"], "outputs", "summary.txt").read_text(
            encoding="utf-8"
        )
        == "patched output\n"
    )

    session = get_session_factory()()
    try:
        execution = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "apply_patch_call")
            .one()
        )
        assert execution.result_json["operation"] == "apply_patch"
        assert execution.result_json["updated_files"] == ["work/source.py"]
        assert execution.result_json["created_files"] == ["outputs/summary.txt"]
    finally:
        session.close()


def test_apply_patch_cannot_write_to_task_inputs(client: TestClient, monkeypatch):
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task.",
                        tool_calls=[
                            ToolCall(
                                id="create_task_call",
                                name="create_task",
                                arguments={
                                    "title": "Blocked patch",
                                    "goal": "Attempt a blocked patch safely.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="This patch should be blocked.",
                        tool_calls=[
                            ToolCall(
                                id="blocked_patch",
                                name="apply_patch",
                                arguments={
                                    "scope": "task",
                                    "patch_text": "\n".join(
                                        [
                                            "*** Begin Patch",
                                            "*** Add File: inputs/secret.txt",
                                            "+nope",
                                            "*** End Patch",
                                        ]
                                    ),
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="The blocked patch failed as expected.",
                        usage=UsageStats(total_tokens=4),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr(
        "backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider
    )

    _, conversation_id = bootstrap_user_and_project(client)
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Try a blocked patch.", "asset_ids": []},
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    session = get_session_factory()()
    try:
        execution = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "blocked_patch")
            .one()
        )
        assert execution.result_json["error_type"] == "PermissionError"
    finally:
        session.close()


def test_apply_patch_validates_task_package_before_committing_any_file(
    client: TestClient, monkeypatch
):
    p1b = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task and plan.",
                        tool_calls=[
                            ToolCall(
                                id="create_task_call",
                                name="create_task",
                                arguments={
                                    "title": "Atomic package validation",
                                    "goal": "Reject invalid package patches atomically.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Write plan for approval before work.",
                        tool_calls=[
                            ToolCall(
                                id="wplan_b",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Planned.",
                        usage=UsageStats(total_tokens=3),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    p2b = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Preparing a source file and then applying an invalid package patch.",
                        tool_calls=[
                            ToolCall(
                                id="write_todo_b",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": STANDARD_VALID_TODO,
                                },
                            ),
                            ToolCall(
                                id="seed_file",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/source.txt",
                                    "content": "before\n",
                                },
                            ),
                            ToolCall(
                                id="invalid_package_patch",
                                name="apply_patch",
                                arguments={
                                    "scope": "task",
                                    "patch_text": _apply_patch_rejecting_invalid_replacement_plan(),
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="The invalid patch was rejected.",
                        usage=UsageStats(total_tokens=5),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    bstack: list[FakeProvider] = [p1b, p2b]

    def gbval(*_a, **_k) -> FakeProvider:
        if not bstack:
            return p2b
        return bstack.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", gbval)

    _, conversation_id = bootstrap_user_and_project(client)
    r0 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "Try an invalid package patch (part 1: plan).",
            "asset_ids": [],
        },
    )
    assert r0.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r0.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    t = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    approve_pending_plan_approval_for_task(client, t["id"])
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "Try an invalid package patch (part 2).",
            "asset_ids": [],
        },
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    task = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    task_root = Path(task["workspace_root"])
    assert (task_root / "work" / "source.txt").read_text(encoding="utf-8") == "before\n"
    # plan.md existed from part 1; the invalid patch must be rejected before committing, leaving it unchanged
    assert (task_root / "plan.md").read_text(encoding="utf-8") == STANDARD_VALID_PLAN

    session = get_session_factory()()
    try:
        execution = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "invalid_package_patch")
            .one()
        )
        assert execution.result_json["error_type"] == "missing_required_sections"
        assert "## Verification" in execution.result_json["missing_sections"]
    finally:
        session.close()


def test_linked_workspace_apply_patch_requires_explicit_approval(
    client: TestClient, monkeypatch
):
    p1l = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task and internal plan before the repo.",
                        tool_calls=[
                            ToolCall(
                                id="create_task_call",
                                name="create_task",
                                arguments={
                                    "title": "Repo patch",
                                    "goal": "Prepare to patch the linked workspace.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Write plan and todo for gate.",
                        tool_calls=[
                            ToolCall(
                                id="wpl",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Gated planning done.",
                        usage=UsageStats(total_tokens=3),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    p2l = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="This linked workspace patch needs approval.",
                        tool_calls=[
                            ToolCall(
                                id="wtl",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": STANDARD_VALID_TODO,
                                },
                            ),
                            ToolCall(
                                id="linked_patch",
                                name="apply_patch",
                                arguments={
                                    "scope": "linked_workspace",
                                    "patch_text": "\n".join(
                                        [
                                            "*** Begin Patch",
                                            "*** Add File: src/new_file.py",
                                            "+print('hi')",
                                            "*** End Patch",
                                        ]
                                    ),
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Waiting for approval.",
                        usage=UsageStats(total_tokens=4),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    lstack: list[FakeProvider] = [p1l, p2l]

    def glh(*_a, **_k) -> FakeProvider:
        if not lstack:
            return p2l
        return lstack.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", glh)

    project_id, conversation_id = bootstrap_user_and_project(client)
    workspace = client.post(
        f"/api/v1/projects/{project_id}/workspaces",
        json={
            "label": "Repo",
            "relative_path": "repo-patch-test",
            "editor_type": "vscode",
            "is_primary": True,
            "access_granted": True,
        },
    )
    assert workspace.status_code == 201

    r1l = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "Patch the linked workspace (part 1: planning).",
            "asset_ids": [],
        },
    )
    assert r1l.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r1l.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    t = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    approve_pending_plan_approval_for_task(client, t["id"])
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Patch the linked workspace (part 2).", "asset_ids": []},
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    active_task = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    approvals = client.get(f"/api/v1/tasks/{active_task.json()['id']}/approvals")
    assert approvals.status_code == 200
    linked_pending = [
        a
        for a in approvals.json()
        if a["approval_type"] == "linked_workspace_write" and a["status"] == "pending"
    ]
    assert len(linked_pending) == 1
    assert linked_pending[0]["request_json"]["paths"] == ["src/new_file.py"]


def test_linked_workspace_command_requires_explicit_approval(
    client: TestClient, monkeypatch
):
    monkeypatch.setenv("PREMCHAT_COMMAND_SANDBOX", "docker")
    p1c = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task and internal gating first.",
                        tool_calls=[
                            ToolCall(
                                id="create_task_call",
                                name="create_task",
                                arguments={
                                    "title": "Repo task",
                                    "goal": "Inspect the linked workspace.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Write plan for approval.",
                        tool_calls=[
                            ToolCall(
                                id="wplc",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Planned.",
                        usage=UsageStats(total_tokens=3),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    p2c = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="This linked workspace command needs approval.",
                        tool_calls=[
                            ToolCall(
                                id="wtlc",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": STANDARD_VALID_TODO,
                                },
                            ),
                            ToolCall(
                                id="linked_cmd",
                                name="execute_command",
                                arguments={
                                    "scope": "linked_workspace",
                                    "argv": ["python", "script.py"],
                                    "cwd": ".",
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Waiting for approval.",
                        usage=UsageStats(total_tokens=4),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    cstack: list[FakeProvider] = [p1c, p2c]

    def glc(*_a, **_k) -> FakeProvider:
        if not cstack:
            return p2c
        return cstack.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", glc)

    project_id, conversation_id = bootstrap_user_and_project(client)
    workspace = client.post(
        f"/api/v1/projects/{project_id}/workspaces",
        json={
            "label": "Repo",
            "relative_path": "repo-under-test",
            "editor_type": "vscode",
            "is_primary": True,
            "access_granted": True,
        },
    )
    assert workspace.status_code == 201

    r0 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "Run a command in the linked workspace (part 1).",
            "asset_ids": [],
        },
    )
    assert r0.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r0.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    t = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    approve_pending_plan_approval_for_task(client, t["id"])
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "Run a command in the linked workspace (part 2).",
            "asset_ids": [],
        },
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    active_task = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    approvals = client.get(f"/api/v1/tasks/{active_task.json()['id']}/approvals")
    assert approvals.status_code == 200
    cmd_pending = [
        a
        for a in approvals.json()
        if a["approval_type"] == "linked_workspace_command" and a["status"] == "pending"
    ]
    assert len(cmd_pending) == 1


def test_todo_write_returns_plan_approval_required_without_user_approval(
    client: TestClient, monkeypatch
):
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Start task.",
                        tool_calls=[
                            ToolCall(
                                id="g_create",
                                name="create_task",
                                arguments={
                                    "title": "Gate test",
                                    "goal": "Check plan approval gate.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Write plan",
                        tool_calls=[
                            ToolCall(
                                id="g_plan",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Write todo",
                        tool_calls=[
                            ToolCall(
                                id="g_todo",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": STANDARD_VALID_TODO,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Done",
                        usage=UsageStats(),
                        raw_dump={"turn": 4},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr(
        "backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider
    )
    _, conversation_id = bootstrap_user_and_project(client)
    r = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "Run lifecycle gate test (todo before approval).",
            "asset_ids": [],
        },
    )
    assert r.status_code == 202
    run_id = r.json()["agent_run_id"]
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    session = get_session_factory()()
    try:
        g_todo = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "g_todo")
            .one()
        )
        assert g_todo.result_json["error_type"] == "plan_approval_required"
    finally:
        session.close()


def test_work_write_returns_todo_required_after_plan_approved_without_todo(
    client: TestClient, monkeypatch
):
    p1 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task and plan",
                        tool_calls=[
                            ToolCall(
                                id="w_create",
                                name="create_task",
                                arguments={
                                    "title": "Work gate",
                                    "goal": "Block work without todo.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="write plan",
                        tool_calls=[
                            ToolCall(
                                id="w_plan",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="pl",
                        usage=UsageStats(),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    p2 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="write work with no todo",
                        tool_calls=[
                            ToolCall(
                                id="w_work_early",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/nope.txt",
                                    "content": "too soon\n",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="ok",
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    wstack: list[FakeProvider] = [p1, p2]

    def wgf(*_a, **_k) -> FakeProvider:
        if not wstack:
            return p2
        return wstack.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", wgf)
    _, conversation_id = bootstrap_user_and_project(client)
    r0 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Work gate 1 (plan).", "asset_ids": []},
    )
    assert r0.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r0.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    t = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    approve_pending_plan_approval_for_task(client, t["id"])
    r1 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Work gate 2 (work only).", "asset_ids": []},
    )
    assert r1.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r1.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    session = get_session_factory()()
    try:
        ex = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "w_work_early")
            .one()
        )
        assert ex.result_json["error_type"] == "todo_required"
    finally:
        session.close()


def test_revised_plan_after_approval_blocks_todo_until_new_approval(
    client: TestClient, monkeypatch
):
    p1 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="task+plan",
                        tool_calls=[
                            ToolCall(
                                id="r_create",
                                name="create_task",
                                arguments={
                                    "title": "Revision",
                                    "goal": "Re-approve after plan change.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="p",
                        tool_calls=[
                            ToolCall(
                                id="r_plan",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="e",
                        usage=UsageStats(),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    p2 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="revise plan and todo",
                        tool_calls=[
                            ToolCall(
                                id="r_revise",
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "old_text": "Summary line.",
                                    "new_text": "Revised summary line.",
                                },
                            ),
                            ToolCall(
                                id="r_todo",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "todo.md",
                                    "content": STANDARD_VALID_TODO,
                                },
                            ),
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="x",
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    rstack: list[FakeProvider] = [p1, p2]

    def rgf(*_a, **_k) -> FakeProvider:
        if not rstack:
            return p2
        return rstack.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", rgf)
    _, conversation_id = bootstrap_user_and_project(client)
    r0 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Revision part 1.", "asset_ids": []},
    )
    assert r0.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r0.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    t = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    approve_pending_plan_approval_for_task(client, t["id"])
    r1 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Revision part 2.", "asset_ids": []},
    )
    assert r1.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r1.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    session = get_session_factory()()
    try:
        revise = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "r_revise")
            .one()
        )
        assert "error_type" not in revise.result_json
        tdx = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "r_todo")
            .one()
        )
        assert tdx.result_json["error_type"] == "plan_approval_required"
    finally:
        session.close()


def _patch_add_todo_and_work() -> str:
    """V4A patch adding valid todo.md and a work file in one apply_patch (used to test atomic gate)."""
    tlines = [f"+{l}" for l in STANDARD_VALID_TODO.splitlines()]
    return "\n".join(
        [
            "*** Begin Patch",
            "*** Add File: todo.md",
            *tlines,
            "*** Add File: work/sneak.txt",
            "+not committed",
            "*** End Patch",
        ]
    )


def test_apply_patch_cannot_add_todo_and_work_before_plan_approval(
    client: TestClient, monkeypatch
):
    p1 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Start",
                        tool_calls=[
                            ToolCall(
                                id="sneak_ct",
                                name="create_task",
                                arguments={
                                    "title": "Sneak patch",
                                    "goal": "Atomic gate.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Plan only",
                        tool_calls=[
                            ToolCall(
                                id="sneak_plan",
                                name="write_file",
                                arguments={
                                    "scope": "task",
                                    "path": "plan.md",
                                    "content": STANDARD_VALID_PLAN,
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="e",
                        usage=UsageStats(),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    p2 = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Try atomic todo+work without approval",
                        tool_calls=[
                            ToolCall(
                                id="sneak_patch",
                                name="apply_patch",
                                arguments={
                                    "scope": "task",
                                    "patch_text": _patch_add_todo_and_work(),
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="x",
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    sstack2: list[FakeProvider] = [p1, p2]

    def sneaker(*_a, **_k) -> FakeProvider:
        if not sstack2:
            return p2
        return sstack2.pop(0)

    monkeypatch.setattr("backend.src.agent.runtime.get_provider", sneaker)
    _, conversation_id = bootstrap_user_and_project(client)
    r0 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Sneak part 1 (no approval).", "asset_ids": []},
    )
    assert r0.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r0.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    r1 = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Sneak part 2 (apply_patch).", "asset_ids": []},
    )
    assert r1.status_code == 202
    with client.websocket_connect(
        f"/api/v1/agent-runs/{r1.json()['agent_run_id']}/stream"
    ) as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break
    task = client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
    task_root = Path(task["workspace_root"])
    assert not (task_root / "todo.md").exists()
    assert not (task_root / "work" / "sneak.txt").exists()
    session = get_session_factory()()
    try:
        ex = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "sneak_patch")
            .one()
        )
        assert ex.result_json["error_type"] == "plan_approval_required"
    finally:
        session.close()


def test_update_task_status_completed_closes_task_after_user_acceptance(
    client: TestClient, monkeypatch
):
    _, conversation_id, task = prepare_task_with_todo(
        client,
        monkeypatch,
        todo_content=STANDARD_COMPLETED_TODO,
        extra_providers=[
            provider_for_status_update(
                call_id="close_completed",
                status="completed",
                summary="All requested work was delivered and accepted.",
            )
        ],
    )

    close_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "I accept the work. Please mark it complete.",
            "asset_ids": [],
        },
    )
    assert close_response.status_code == 202
    close_run_id = close_response.json()["agent_run_id"]
    events = drain_run_events(client, close_run_id)

    assert any(
        event["type"] == "task.status.updated"
        and event["task"]["status"] == "completed"
        for event in events
    )
    active_task = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    assert active_task.status_code == 200
    assert active_task.json() is None

    closed_task = client.get(f"/api/v1/tasks/{task['id']}")
    assert closed_task.status_code == 200
    assert closed_task.json()["status"] == "completed"
    assert closed_task.json()["completed_at"] is not None
    assert (
        closed_task.json()["result_summary"]
        == "All requested work was delivered and accepted."
    )

    replay = client.get(f"/api/v1/agent-runs/{close_run_id}/events")
    assert replay.status_code == 200
    assert any(event["event_type"] == "task.status.updated" for event in replay.json())


def test_update_task_status_completed_blocks_unchecked_todo(
    client: TestClient, monkeypatch
):
    _, conversation_id, task = prepare_task_with_todo(
        client,
        monkeypatch,
        todo_content=STANDARD_VALID_TODO,
        extra_providers=[
            provider_for_status_update(
                call_id="close_unchecked",
                status="completed",
                summary="Attempted completion with open todo.",
            )
        ],
    )

    close_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "I accept the work. Please mark it complete.",
            "asset_ids": [],
        },
    )
    assert close_response.status_code == 202
    drain_run_events(client, close_response.json()["agent_run_id"])

    active_task = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    assert active_task.status_code == 200
    assert active_task.json()["id"] == task["id"]
    session = get_session_factory()()
    try:
        execution = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "close_unchecked")
            .one()
        )
        assert execution.result_json["error_type"] == "todo_incomplete"
    finally:
        session.close()


def test_update_task_status_completed_requires_current_user_acceptance(
    client: TestClient, monkeypatch
):
    _, conversation_id, task = prepare_task_with_todo(
        client,
        monkeypatch,
        todo_content=STANDARD_COMPLETED_TODO,
        extra_providers=[
            provider_for_status_update(
                call_id="close_without_acceptance",
                status="completed",
                summary="Attempted completion without acceptance.",
            )
        ],
    )

    close_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Please close this when appropriate.", "asset_ids": []},
    )
    assert close_response.status_code == 202
    drain_run_events(client, close_response.json()["agent_run_id"])

    active_task = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    assert active_task.status_code == 200
    assert active_task.json()["id"] == task["id"]
    session = get_session_factory()()
    try:
        execution = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "close_without_acceptance")
            .one()
        )
        assert execution.result_json["error_type"] == "acceptance_required"
    finally:
        session.close()


def test_update_task_status_failed_closes_task_with_summary(
    client: TestClient, monkeypatch
):
    _, conversation_id, task = prepare_task_with_todo(
        client,
        monkeypatch,
        todo_content=STANDARD_VALID_TODO,
        extra_providers=[
            provider_for_status_update(
                call_id="close_failed",
                status="failed",
                summary="The task is unrecoverable because the required input is unavailable.",
            )
        ],
    )

    close_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "This is unrecoverable. Mark the task failed.",
            "asset_ids": [],
        },
    )
    assert close_response.status_code == 202
    events = drain_run_events(client, close_response.json()["agent_run_id"])

    assert any(
        event["type"] == "task.status.updated" and event["task"]["status"] == "failed"
        for event in events
    )
    assert (
        client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
        is None
    )
    closed_task = client.get(f"/api/v1/tasks/{task['id']}").json()
    assert closed_task["status"] == "failed"
    assert closed_task["failed_at"] is not None
    assert (
        closed_task["result_summary"]
        == "The task is unrecoverable because the required input is unavailable."
    )


def test_terminal_task_is_not_reused_for_future_task_scoped_work(
    client: TestClient, monkeypatch
):
    _, conversation_id, closed_candidate = prepare_task_with_todo(
        client,
        monkeypatch,
        todo_content=STANDARD_COMPLETED_TODO,
        extra_providers=[
            provider_for_status_update(
                call_id="close_for_reuse",
                status="completed",
                summary="Accepted and closed.",
            ),
            FakeProvider(
                [
                    {
                        "chunks": [
                            LLMResponse(
                                content="Try task write without active task.",
                                tool_calls=[
                                    ToolCall(
                                        id="write_after_close",
                                        name="write_file",
                                        arguments={
                                            "scope": "task",
                                            "path": "work/after.txt",
                                            "content": "no active task\n",
                                        },
                                    )
                                ],
                                usage=UsageStats(),
                                raw_dump={"turn": 1},
                                metadata={"provider": "fake", "model": "fake-model"},
                            )
                        ]
                    },
                    {
                        "chunks": [
                            LLMResponse(
                                content="Write blocked.",
                                usage=UsageStats(),
                                raw_dump={"turn": 2},
                                metadata={"provider": "fake", "model": "fake-model"},
                            )
                        ]
                    },
                ]
            ),
            provider_for_task_and_plan(
                create_id="new_after_close",
                plan_id="new_after_close_plan",
                title="New task",
            ),
        ],
    )

    close_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "I accept the work. Mark it complete.", "asset_ids": []},
    )
    assert close_response.status_code == 202
    drain_run_events(client, close_response.json()["agent_run_id"])
    assert (
        client.get(f"/api/v1/conversations/{conversation_id}/active-task").json()
        is None
    )

    blocked_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "content_text": "Try writing after closure without a task.",
            "asset_ids": [],
        },
    )
    assert blocked_response.status_code == 202
    drain_run_events(client, blocked_response.json()["agent_run_id"])
    session = get_session_factory()()
    try:
        blocked = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "write_after_close")
            .one()
        )
        assert blocked.result_json["error_type"] == "task_required"
    finally:
        session.close()

    new_task_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Start a new task now.", "asset_ids": []},
    )
    assert new_task_response.status_code == 202
    drain_run_events(client, new_task_response.json()["agent_run_id"])
    new_active = client.get(
        f"/api/v1/conversations/{conversation_id}/active-task"
    ).json()
    assert new_active["id"] != closed_candidate["id"]
    assert new_active["status"] == "awaiting_approval"


def test_destructive_commands_are_blocked_even_in_sandbox_mode(
    client: TestClient, monkeypatch
):
    monkeypatch.setenv("PREMCHAT_COMMAND_SANDBOX", "docker")
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task first.",
                        tool_calls=[
                            ToolCall(
                                id="create_task_call",
                                name="create_task",
                                arguments={
                                    "title": "Blocked command",
                                    "goal": "Attempt a blocked command safely.",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="Attempting a dangerous command should fail.",
                        tool_calls=[
                            ToolCall(
                                id="blocked_cmd",
                                name="execute_command",
                                arguments={
                                    "scope": "task",
                                    "argv": ["rm", "-rf", "/tmp/nope"],
                                    "cwd": "work",
                                },
                            )
                        ],
                        usage=UsageStats(),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="The dangerous command was blocked.",
                        usage=UsageStats(total_tokens=4),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr(
        "backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider
    )

    _, conversation_id = bootstrap_user_and_project(client)
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Try a dangerous command.", "asset_ids": []},
    )
    assert response.status_code == 202
    run_id = response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    session = get_session_factory()()
    try:
        execution = (
            session.query(ToolExecution)
            .filter(ToolExecution.tool_call_id == "blocked_cmd")
            .one()
        )
        assert execution.result_json["error_type"] == "command_blocked"
    finally:
        session.close()
