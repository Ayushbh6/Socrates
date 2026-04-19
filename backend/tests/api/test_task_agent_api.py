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

    async def agenerate(self, request):
        return self.turns.pop(0)["fallback"]

    def astream(self, request):
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
    assert client.post("/api/v1/bootstrap", json={"display_name": "Ayush", "preferences": {}}).status_code == 201
    project = client.post("/api/v1/projects", json={"name": "Task Lab"})
    assert project.status_code == 201
    project_id = project.json()["id"]
    conversation = client.post(f"/api/v1/projects/{project_id}/conversations", json={"title": "Task flow"})
    assert conversation.status_code == 201
    return project_id, conversation.json()["id"]


def upload_text_asset(client: TestClient, project_id: str, filename: str, content: bytes) -> str:
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
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

    project_id, conversation_id = bootstrap_user_and_project(client)
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Please analyze this document properly.", "asset_ids": []},
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
    finally:
        session.close()


def test_risky_command_creates_approval_and_resolution_is_traced(client: TestClient, monkeypatch):
    monkeypatch.setenv("PREMCHAT_COMMAND_SANDBOX", "docker")
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I should open a task first.",
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
                        content="I need approval for this install.",
                        tool_calls=[
                            ToolCall(
                                id="call_install",
                                name="execute_command",
                                arguments={
                                    "scope": "task",
                                    "argv": ["python", "-m", "pip", "install", "pandas"],
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
                        content="Approval is required before I can continue.",
                        usage=UsageStats(total_tokens=7),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

    _, conversation_id = bootstrap_user_and_project(client)
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Install pandas if needed and continue.", "asset_ids": []},
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
    assert "task.approval.requested" in ws_types

    active_task = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    assert active_task.status_code == 200
    task_payload = active_task.json()
    assert task_payload["status"] == "awaiting_approval"

    approvals = client.get(f"/api/v1/tasks/{task_payload['id']}/approvals")
    assert approvals.status_code == 200
    approval_payload = approvals.json()
    assert len(approval_payload) == 1
    assert approval_payload[0]["approval_type"] == "dependency_install"
    assert approval_payload[0]["status"] == "pending"

    resolved = client.post(
        f"/api/v1/task-approvals/{approval_payload[0]['id']}",
        json={"approved": True, "note": "Proceed."},
    )
    assert resolved.status_code == 200
    resolved_payload = resolved.json()
    assert resolved_payload["status"] == "approved"

    active_task_after = client.get(f"/api/v1/conversations/{conversation_id}/active-task")
    assert active_task_after.status_code == 200
    assert active_task_after.json()["status"] == "active"

    events = client.get(f"/api/v1/agent-runs/{run_id}/events")
    assert events.status_code == 200
    event_types = [event["event_type"] for event in events.json()]
    assert "task.approval.resolved" in event_types


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
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

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
    input_artifacts = [artifact for artifact in artifact_payload if artifact["artifact_role"] == "input"]
    assert len(input_artifacts) == 1
    assert input_artifacts[0]["relative_path"] == "inputs/brief.txt"
    assert Path(task["workspace_root"], "inputs", "brief.txt").read_text(encoding="utf-8") == "hello from input"


def test_project_read_file_supports_line_ranges_and_search_filters(client: TestClient, monkeypatch):
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
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

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
        read_exec = session.query(ToolExecution).filter(ToolExecution.tool_call_id == "project_read").one()
        assert read_exec.result_json["line_start"] == 2
        assert read_exec.result_json["line_end"] == 3
        assert read_exec.result_json["content"] == "Beta\nwisdom begins in wonder"

        search_exec = session.query(ToolExecution).filter(ToolExecution.tool_call_id == "project_search").one()
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
                                arguments={"path_or_title": "todo", "content": "first line"},
                            ),
                            ToolCall(
                                id="note_2",
                                name="write_project_note",
                                arguments={"path_or_title": "todo", "content": "second line"},
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
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

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
            .filter(ToolExecution.agent_run_id == run_id, ToolExecution.tool_name == "write_project_note")
            .order_by(ToolExecution.created_at.asc())
            .all()
        )
        assert len(executions) == 2
        assert executions[0].result_json["asset_id"]
        assert executions[1].result_json["error_type"] == "task_required"
    finally:
        session.close()


def test_task_search_files_supports_globs_and_case_controls(client: TestClient, monkeypatch):
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
                                arguments={"title": "Search task files", "goal": "Prepare files for searching."},
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
                        content="I will create and search files.",
                        tool_calls=[
                            ToolCall(
                                id="seed_a",
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/a.py",
                                    "operation": "create",
                                    "content": "Needle\nneedle\n",
                                },
                            ),
                            ToolCall(
                                id="seed_b",
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/b.txt",
                                    "operation": "create",
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
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content="The search completed.",
                        usage=UsageStats(total_tokens=4),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

    _, conversation_id = bootstrap_user_and_project(client)
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Search the task files.", "asset_ids": []},
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
        case_exec = session.query(ToolExecution).filter(ToolExecution.tool_call_id == "search_case").one()
        assert case_exec.result_json["match_count"] == 1
        assert case_exec.result_json["matches"][0]["path"] == "work/a.py"
        assert case_exec.result_json["matches"][0]["line_no"] == 1

        regex_exec = session.query(ToolExecution).filter(ToolExecution.tool_call_id == "search_regex").one()
        assert regex_exec.result_json["match_count"] == 1
        assert regex_exec.result_json["matches"][0]["path"] == "work/a.py"
        assert regex_exec.result_json["matches"][0]["line_no"] == 2
    finally:
        session.close()


def test_edit_file_supports_multi_edit_and_conflict_detection(client: TestClient, monkeypatch):
    original = "alpha\nbeta\n"
    correct_sha = hashlib.sha256(original.encode("utf-8")).hexdigest()
    wrong_sha = hashlib.sha256(b"something else").hexdigest()
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
                                arguments={"title": "Multi edit", "goal": "Apply conflict-aware edits."},
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
                        content="I will create and then batch edit the file.",
                        tool_calls=[
                            ToolCall(
                                id="seed_file",
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/file.txt",
                                    "operation": "create",
                                    "content": original,
                                },
                            ),
                            ToolCall(
                                id="multi_edit_call",
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/file.txt",
                                    "operation": "multi_edit",
                                    "expected_sha256": correct_sha,
                                    "edits": [
                                        {"operation": "str_replace", "old_text": "alpha", "new_text": "ALPHA"},
                                        {"operation": "insert", "insert_after_line": 2, "content": "gamma"},
                                    ],
                                },
                            ),
                            ToolCall(
                                id="conflict_edit",
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/file.txt",
                                    "operation": "overwrite",
                                    "expected_sha256": wrong_sha,
                                    "content": "should fail\n",
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
                        content="The batch edit worked and the stale edit was blocked.",
                        usage=UsageStats(total_tokens=5),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

    _, conversation_id = bootstrap_user_and_project(client)
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Batch edit the file.", "asset_ids": []},
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
    assert Path(task["workspace_root"], "work", "file.txt").read_text(encoding="utf-8") == "ALPHA\nbeta\ngamma\n"

    session = get_session_factory()()
    try:
        conflict_exec = session.query(ToolExecution).filter(ToolExecution.tool_call_id == "conflict_edit").one()
        assert conflict_exec.result_json["error_type"] == "RuntimeError"
        assert "Edit conflict" in conflict_exec.result_json["message"]
    finally:
        session.close()


def test_task_edits_only_allow_work_and_outputs_and_outputs_can_be_exported(client: TestClient, monkeypatch):
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
                        content="Writing only to allowed locations.",
                        tool_calls=[
                            ToolCall(
                                id="edit_inputs",
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "path": "inputs/blocked.txt",
                                    "operation": "create",
                                    "content": "nope",
                                },
                            ),
                            ToolCall(
                                id="edit_work",
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/script.py",
                                    "operation": "create",
                                    "content": "print('ok')\n",
                                },
                            ),
                            ToolCall(
                                id="edit_output",
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "path": "outputs/result.txt",
                                    "operation": "create",
                                    "content": "done\n",
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
                        content="The files are in place.",
                        usage=UsageStats(total_tokens=5),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

    project_id, conversation_id = bootstrap_user_and_project(client)
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Create the files you need.", "asset_ids": []},
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
        failed_edit = session.query(ToolExecution).filter(ToolExecution.tool_call_id == "edit_inputs").one()
        assert failed_edit.result_json["error_type"] == "PermissionError"
    finally:
        session.close()

    artifacts = client.get(f"/api/v1/tasks/{task['id']}/artifacts")
    assert artifacts.status_code == 200
    artifact_payload = artifacts.json()
    output_artifact = next(artifact for artifact in artifact_payload if artifact["relative_path"] == "outputs/result.txt")
    assert output_artifact["artifact_role"] == "output"
    assert output_artifact["promoted_to_asset"] is False
    assert Path(task["workspace_root"], "work", "script.py").exists()
    assert not Path(task["workspace_root"], "inputs", "blocked.txt").exists()

    export_response = client.post(f"/api/v1/task-artifacts/{output_artifact['id']}/export")
    assert export_response.status_code == 200
    exported = export_response.json()
    assert exported["promoted_to_asset"] is True
    assert exported["asset_id"] is not None


def test_apply_patch_updates_work_and_creates_output_artifact(client: TestClient, monkeypatch):
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
                                arguments={"title": "Patch files", "goal": "Apply a safe patch."},
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
                        content="Preparing the source file first.",
                        tool_calls=[
                            ToolCall(
                                id="seed_file",
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "path": "work/source.py",
                                    "operation": "create",
                                    "content": "def greet():\n    return \"hi\"\n",
                                },
                            ),
                            ToolCall(
                                id="apply_patch_call",
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "operation": "apply_patch",
                                    "patch_text": "\n".join(
                                        [
                                            "*** Begin Patch",
                                            "*** Update File: work/source.py",
                                            "@@",
                                            " def greet():",
                                            "-    return \"hi\"",
                                            "+    return \"hello\"",
                                            "*** Add File: outputs/summary.txt",
                                            "+patched output",
                                            "*** End Patch",
                                        ]
                                    ),
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
                        content="The patch is applied.",
                        usage=UsageStats(total_tokens=5),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

    _, conversation_id = bootstrap_user_and_project(client)
    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Patch the task files.", "asset_ids": []},
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
    assert Path(task["workspace_root"], "work", "source.py").read_text(encoding="utf-8") == 'def greet():\n    return "hello"\n'

    artifacts = client.get(f"/api/v1/tasks/{task['id']}/artifacts")
    assert artifacts.status_code == 200
    output_artifact = next(artifact for artifact in artifacts.json() if artifact["relative_path"] == "outputs/summary.txt")
    assert output_artifact["artifact_role"] == "output"
    assert Path(task["workspace_root"], "outputs", "summary.txt").read_text(encoding="utf-8") == "patched output\n"

    session = get_session_factory()()
    try:
        execution = session.query(ToolExecution).filter(ToolExecution.tool_call_id == "apply_patch_call").one()
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
                                arguments={"title": "Blocked patch", "goal": "Attempt a blocked patch safely."},
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
                                name="edit_file",
                                arguments={
                                    "scope": "task",
                                    "operation": "apply_patch",
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
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

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
        execution = session.query(ToolExecution).filter(ToolExecution.tool_call_id == "blocked_patch").one()
        assert execution.result_json["error_type"] == "PermissionError"
    finally:
        session.close()


def test_linked_workspace_apply_patch_requires_explicit_approval(client: TestClient, monkeypatch):
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task before touching the repo.",
                        tool_calls=[
                            ToolCall(
                                id="create_task_call",
                                name="create_task",
                                arguments={"title": "Repo patch", "goal": "Prepare to patch the linked workspace."},
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
                        content="This linked workspace patch needs approval.",
                        tool_calls=[
                            ToolCall(
                                id="linked_patch",
                                name="edit_file",
                                arguments={
                                    "scope": "linked_workspace",
                                    "operation": "apply_patch",
                                    "patch_text": "\n".join(
                                        [
                                            "*** Begin Patch",
                                            "*** Add File: src/new_file.py",
                                            "+print('hi')",
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
                        content="Waiting for approval.",
                        usage=UsageStats(total_tokens=4),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

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

    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Patch the linked workspace.", "asset_ids": []},
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
    approval_payload = approvals.json()
    assert len(approval_payload) == 1
    assert approval_payload[0]["approval_type"] == "linked_workspace_write"
    assert approval_payload[0]["request_json"]["paths"] == ["src/new_file.py"]


def test_linked_workspace_command_requires_explicit_approval(client: TestClient, monkeypatch):
    monkeypatch.setenv("PREMCHAT_COMMAND_SANDBOX", "docker")
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="I need a task before touching the repo.",
                        tool_calls=[
                            ToolCall(
                                id="create_task_call",
                                name="create_task",
                                arguments={"title": "Repo task", "goal": "Inspect the linked workspace."},
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
                        content="This linked workspace command needs approval.",
                        tool_calls=[
                            ToolCall(
                                id="linked_cmd",
                                name="execute_command",
                                arguments={
                                    "scope": "linked_workspace",
                                    "argv": ["python", "script.py"],
                                    "cwd": ".",
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
                        content="Waiting for approval.",
                        usage=UsageStats(total_tokens=4),
                        raw_dump={"turn": 3},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

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

    response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content_text": "Run a command in the linked workspace.", "asset_ids": []},
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
    approval_payload = approvals.json()
    assert len(approval_payload) == 1
    assert approval_payload[0]["approval_type"] == "linked_workspace_command"
    assert approval_payload[0]["status"] == "pending"


def test_destructive_commands_are_blocked_even_in_sandbox_mode(client: TestClient, monkeypatch):
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
                                arguments={"title": "Blocked command", "goal": "Attempt a blocked command safely."},
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
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

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
        execution = session.query(ToolExecution).filter(ToolExecution.tool_call_id == "blocked_cmd").one()
        assert execution.result_json["error_type"] == "command_blocked"
    finally:
        session.close()
