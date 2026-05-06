from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from backend.src.agent.events import AgentEvent, AgentEventType
from backend.src.app import create_app
from backend.src.core.schema import LLMResponse, Message, MessageRole, ToolCall, UsageStats
from backend.src.db.models import AgentEventRecord, AgentRun, MessageRecord
from backend.src.db.session import get_session_factory


class FakeRunner:
    async def stream(self, request):
        yield AgentEvent(
            type=AgentEventType.THINKING,
            provider="fake",
            model=request.model,
            round_index=0,
            response=LLMResponse(
                content="",
                thinking="Let us examine the matter.",
                usage=UsageStats(),
                raw_dump={"chunk": 1},
                metadata={"provider": "fake", "model": request.model},
            ),
        )
        yield AgentEvent(
            type=AgentEventType.CONTENT,
            provider="fake",
            model=request.model,
            round_index=0,
            response=LLMResponse(
                content="The examined answer is ready.",
                usage=UsageStats(),
                raw_dump={"chunk": 2},
                metadata={"provider": "fake", "model": request.model},
            ),
        )
        yield AgentEvent(
            type=AgentEventType.FINAL_RESPONSE,
            provider="fake",
            model=request.model,
            round_index=1,
            response=LLMResponse(
                content="The examined answer is ready.",
                thinking="Let us examine the matter.",
                usage=UsageStats(input_tokens=11, output_tokens=7, completion_tokens=7, total_tokens=18),
                raw_dump={"final": True},
                metadata={
                    "provider": "fake",
                    "model": request.model,
                    "agent_usage": {
                        "input_tokens": 11,
                        "output_tokens": 7,
                        "completion_tokens": 7,
                        "total_tokens": 18,
                    },
                    "agent_turn_telemetry": [
                        {
                            "round_index": 0,
                            "phase": "tool",
                            "elapsed_ms": 5.0,
                            "usage": {
                                "input_tokens": 11,
                                "output_tokens": 7,
                                "completion_tokens": 7,
                                "total_tokens": 18,
                            },
                            "tool_call_count": 0,
                            "parsed_output": False,
                            "had_thinking": True,
                        }
                    ],
                    "agent_elapsed_ms": 12.5,
                },
            ),
        )


class MalformedPayloadRunner:
    """Emits a tool call whose `arguments` dict contains values that cannot
    round-trip through strict JSON (NaN, Infinity, Decimal, bytes, UUID). A
    production-grade stream must sanitize these before persisting or publishing
    so the WebSocket never closes abnormally on a malformed frame."""

    @staticmethod
    def _bad_arguments() -> dict:
        import math
        from decimal import Decimal
        from uuid import UUID

        return {
            "scope": "project",
            "path": "bad.json",
            "score": math.nan,
            "limit": math.inf,
            "tax": Decimal("1.50"),
            "checksum": b"\x00\x01\x02",
            "trace_id": UUID("12345678-1234-5678-1234-567812345678"),
        }

    async def stream(self, request):
        tool_call = ToolCall(id="call_bad_args", name="read_file", arguments=self._bad_arguments())
        yield AgentEvent(
            type=AgentEventType.TOOL_CALL,
            provider="fake",
            model=request.model,
            round_index=0,
            tool_call=tool_call,
        )
        yield AgentEvent(
            type=AgentEventType.TOOL_RESULT,
            provider="fake",
            model=request.model,
            round_index=0,
            tool_call=tool_call,
            tool_result='{"ok":true,"tool_name":"read_file","data":{"path":"bad.json"}}',
        )
        yield AgentEvent(
            type=AgentEventType.CONTENT,
            provider="fake",
            model=request.model,
            round_index=0,
            response=LLMResponse(
                content="Parsed despite odd arguments.",
                usage=UsageStats(),
                raw_dump={},
                metadata={"provider": "fake", "model": request.model},
            ),
        )
        yield AgentEvent(
            type=AgentEventType.FINAL_RESPONSE,
            provider="fake",
            model=request.model,
            round_index=1,
            response=LLMResponse(
                content="Parsed despite odd arguments.",
                usage=UsageStats(input_tokens=2, output_tokens=3, completion_tokens=3, total_tokens=5),
                raw_dump={"final": True},
                metadata={
                    "provider": "fake",
                    "model": request.model,
                    "agent_usage": {
                        "input_tokens": 2,
                        "output_tokens": 3,
                        "completion_tokens": 3,
                        "total_tokens": 5,
                    },
                    "agent_turn_telemetry": [
                        {
                            "round_index": 0,
                            "phase": "tool",
                            "elapsed_ms": 1.0,
                            "usage": {
                                "input_tokens": 2,
                                "output_tokens": 3,
                                "completion_tokens": 3,
                                "total_tokens": 5,
                            },
                            "tool_call_count": 1,
                            "parsed_output": False,
                            "had_thinking": False,
                        }
                    ],
                    "agent_elapsed_ms": 1.0,
                },
            ),
        )


class FailingRunner:
    async def stream(self, request):
        yield AgentEvent(
            type=AgentEventType.CONTENT,
            provider="fake",
            model=request.model,
            round_index=0,
            response=LLMResponse(
                content="Beginning the answer.",
                usage=UsageStats(),
                raw_dump={"chunk": 1},
                metadata={"provider": "fake", "model": request.model},
            ),
        )
        raise RuntimeError("Synthetic provider failure")


class IdleStreamingRunner:
    """Emits an initial event, then stalls for long enough that the stream
    must rely on application-level heartbeats to keep intermediaries from
    dropping the connection. Used to verify heartbeat cadence."""

    IDLE_SECONDS = 1.2

    async def stream(self, request):
        yield AgentEvent(
            type=AgentEventType.THINKING,
            provider="fake",
            model=request.model,
            round_index=0,
            response=LLMResponse(
                content="",
                thinking="Pausing to reflect...",
                usage=UsageStats(),
                raw_dump={},
                metadata={"provider": "fake", "model": request.model},
            ),
        )
        await asyncio.sleep(self.IDLE_SECONDS)
        yield AgentEvent(
            type=AgentEventType.FINAL_RESPONSE,
            provider="fake",
            model=request.model,
            round_index=1,
            response=LLMResponse(
                content="Reflection complete.",
                thinking="Pausing to reflect...",
                usage=UsageStats(input_tokens=1, output_tokens=1, completion_tokens=1, total_tokens=2),
                raw_dump={"final": True},
                metadata={
                    "provider": "fake",
                    "model": request.model,
                    "agent_usage": {
                        "input_tokens": 1,
                        "output_tokens": 1,
                        "completion_tokens": 1,
                        "total_tokens": 2,
                    },
                    "agent_turn_telemetry": [
                        {
                            "round_index": 0,
                            "phase": "tool",
                            "elapsed_ms": 1.0,
                            "usage": {
                                "input_tokens": 1,
                                "output_tokens": 1,
                                "completion_tokens": 1,
                                "total_tokens": 2,
                            },
                            "tool_call_count": 0,
                            "parsed_output": False,
                            "had_thinking": True,
                        }
                    ],
                    "agent_elapsed_ms": 1.0,
                },
            ),
        )


class SlowPendingRunner:
    async def stream(self, request):
        yield AgentEvent(
            type=AgentEventType.THINKING,
            provider="fake",
            model=request.model,
            round_index=0,
            response=LLMResponse(
                content="",
                thinking="Working through the problem.",
                usage=UsageStats(),
                raw_dump={"chunk": 1},
                metadata={"provider": "fake", "model": request.model},
            ),
        )
        await asyncio.sleep(0.2)
        yield AgentEvent(
            type=AgentEventType.FINAL_RESPONSE,
            provider="fake",
            model=request.model,
            round_index=1,
            response=LLMResponse(
                content="Finished after the delay.",
                thinking="Working through the problem.",
                usage=UsageStats(input_tokens=3, output_tokens=4, completion_tokens=4, total_tokens=7),
                raw_dump={"final": True},
                metadata={
                    "provider": "fake",
                    "model": request.model,
                    "agent_usage": {
                        "input_tokens": 3,
                        "output_tokens": 4,
                        "completion_tokens": 4,
                        "total_tokens": 7,
                    },
                    "agent_turn_telemetry": [
                        {
                            "round_index": 0,
                            "phase": "tool",
                            "elapsed_ms": 25.0,
                            "usage": {
                                "input_tokens": 3,
                                "output_tokens": 4,
                                "completion_tokens": 4,
                                "total_tokens": 7,
                            },
                            "tool_call_count": 0,
                            "parsed_output": False,
                            "had_thinking": True,
                        }
                    ],
                    "agent_elapsed_ms": 50.0,
                },
            ),
        )


@pytest.fixture
def client(monkeypatch, tmp_path):
    app_data_dir = tmp_path / "appdata"
    monkeypatch.setenv("APP_DATA_DIR", str(app_data_dir))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'premchat.sqlite3'}")

    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


def bootstrap_user_and_project(client: TestClient) -> tuple[str, str]:
    bootstrap = client.post("/api/v1/bootstrap", json={"display_name": "Ayush", "preferences": {"theme": "light"}})
    assert bootstrap.status_code == 201

    project = client.post(
        "/api/v1/projects",
        json={"name": "Quant Lab", "description": "Research workspace", "default_system_prompt": "Think carefully."},
    )
    assert project.status_code == 201

    conversation = client.post(
        f"/api/v1/projects/{project.json()['id']}/conversations",
        json={"title": "Strategy review"},
    )
    assert conversation.status_code == 201
    assert conversation.json()["model"] == "openai/gpt-5.4-mini"
    assert conversation.json()["thinking_level"] == "off"
    return project.json()["id"], conversation.json()["id"]


def test_bootstrap_flow(client: TestClient):
    status_before = client.get("/api/v1/bootstrap")
    assert status_before.status_code == 200
    assert status_before.json() == {"has_user": False, "onboarding_completed": False}

    created = client.post("/api/v1/bootstrap", json={"display_name": "Ayush", "preferences": {"tone": "calm"}})
    assert created.status_code == 201
    assert created.json()["display_name"] == "Ayush"

    duplicate = client.post("/api/v1/bootstrap", json={"display_name": "Other", "preferences": {}})
    assert duplicate.status_code == 409


def test_conversation_model_preferences_persist(client: TestClient):
    project_id, conversation_id = bootstrap_user_and_project(client)

    patched = client.patch(
        f"/api/v1/conversations/{conversation_id}",
        json={
            "model": "openrouter/qwen/qwen3.6-plus",
            "thinking_level": "high",
        },
    )
    assert patched.status_code == 200
    assert patched.json()["model"] == "openrouter/qwen/qwen3.6-plus"
    assert patched.json()["thinking_level"] == "low"

    listed = client.get(f"/api/v1/projects/{project_id}/conversations")
    assert listed.status_code == 200
    assert listed.json()[0]["model"] == "openrouter/qwen/qwen3.6-plus"
    assert listed.json()[0]["thinking_level"] == "low"


def test_project_rename_persists(client: TestClient):
    project_id, _ = bootstrap_user_and_project(client)

    patched = client.patch(
        f"/api/v1/projects/{project_id}",
        json={"name": "Renamed Lab"},
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == "Renamed Lab"

    fetched = client.get(f"/api/v1/projects/{project_id}")
    assert fetched.status_code == 200
    assert fetched.json()["name"] == "Renamed Lab"


def test_project_workspace_registration_and_primary_switch(client: TestClient, tmp_path):
    project_id, _ = bootstrap_user_and_project(client)
    sandbox_root = tmp_path / "sandbox"
    reports_root = tmp_path / "reports"
    sandbox_root.mkdir()
    reports_root.mkdir()

    created = client.post(
        f"/api/v1/projects/{project_id}/workspaces",
        json={
            "label": "Sandbox",
            "relative_path": str(sandbox_root),
            "is_primary": True,
            "access_granted": True,
        },
    )
    assert created.status_code == 201
    first_workspace = created.json()
    assert first_workspace["label"] == "Sandbox"
    assert first_workspace["is_primary"] is True
    assert first_workspace["access_granted"] is True

    second = client.post(
        f"/api/v1/projects/{project_id}/workspaces",
        json={
            "label": "Reports",
            "relative_path": str(reports_root),
            "is_primary": False,
            "access_granted": False,
        },
    )
    assert second.status_code == 201
    second_workspace = second.json()
    assert second_workspace["access_granted"] is False

    promoted = client.patch(
        f"/api/v1/projects/{project_id}/workspaces/{second_workspace['id']}",
        json={"is_primary": True, "access_granted": True},
    )
    assert promoted.status_code == 200
    promoted_payload = promoted.json()
    assert promoted_payload["is_primary"] is True
    assert promoted_payload["access_granted"] is True
    assert promoted_payload["access_revoked_at"] is None

    workspaces = client.get(f"/api/v1/projects/{project_id}/workspaces")
    assert workspaces.status_code == 200
    payload = workspaces.json()
    assert payload[0]["id"] == second_workspace["id"]
    assert payload[0]["is_primary"] is True
    assert any(item["id"] == first_workspace["id"] and item["is_primary"] is False for item in payload)


def test_project_workspace_rejects_relative_path(client: TestClient):
    project_id, _ = bootstrap_user_and_project(client)

    response = client.post(
        f"/api/v1/projects/{project_id}/workspaces",
        json={
            "label": "Relative",
            "relative_path": "sandbox",
            "is_primary": True,
            "access_granted": True,
        },
    )

    assert response.status_code == 400
    assert "absolute path" in response.json()["detail"]


def test_project_asset_and_message_stream_flow(client: TestClient):
    project_id, conversation_id = bootstrap_user_and_project(client)
    client.app.state.run_manager._runner_factory = FakeRunner

    upload = client.post(
        f"/api/v1/projects/{project_id}/assets",
        files={"file": ("chart.png", b"fake-image-content", "image/png")},
    )
    assert upload.status_code == 201
    asset_id = upload.json()["id"]

    message_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "model": "openai/gpt-5.4-mini",
            "thinking_level": "off",
            "input_mode": "text",
            "content_text": "Analyze this image.",
            "asset_ids": [asset_id],
        },
    )
    assert message_response.status_code == 202
    run_id = message_response.json()["agent_run_id"]

    seen_types = []
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            seen_types.append(payload["type"])
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    assert seen_types[0] == "run.snapshot"
    assert seen_types[1] == "run.started"
    assert "run.turn.started" in seen_types
    assert "run.thinking.delta" in seen_types
    assert "run.content.delta" in seen_types
    assert "run.message.completed" in seen_types
    assert seen_types[-1] == "run.completed"

    active_run_after = client.get(f"/api/v1/conversations/{conversation_id}/active-run")
    assert active_run_after.status_code == 200
    assert active_run_after.json() is None

    messages = client.get(f"/api/v1/conversations/{conversation_id}/messages")
    assert messages.status_code == 200
    payload = messages.json()
    assert len(payload) == 2
    assert payload[0]["role"] == "user"
    assert payload[0]["execution_mode"] == "chat"
    assert payload[0]["assets"][0]["id"] == asset_id
    assert payload[0]["model"] == "openai/gpt-5.4-mini"
    assert payload[1]["role"] == "assistant"
    assert payload[1]["execution_mode"] == "chat"
    assert payload[1]["content_text"] == "The examined answer is ready."

    session = get_session_factory()()
    try:
        run = session.get(AgentRun, run_id)
        assert run is not None
        assert run.status == "completed"
        assert run.response_message_id is not None
        events = session.query(AgentEventRecord).filter(AgentEventRecord.agent_run_id == run_id).all()
        assert any(event.event_type == "run.completed" for event in events)
    finally:
        session.close()

    run_response = client.get(f"/api/v1/agent-runs/{run_id}")
    assert run_response.status_code == 200
    run_payload = run_response.json()
    assert run_payload["id"] == run_id
    assert run_payload["status"] == "completed"
    assert run_payload["trigger_message_id"] == payload[0]["id"]
    assert run_payload["response_message_id"] == payload[1]["id"]
    assert run_payload["event_count"] >= 5
    assert run_payload["turn_count"] >= 1

    turns_response = client.get(f"/api/v1/agent-runs/{run_id}/turns")
    assert turns_response.status_code == 200
    turns_payload = turns_response.json()
    assert len(turns_payload) >= 1
    assert turns_payload[0]["round_index"] == 0
    assert turns_payload[0]["had_thinking"] is True

    events_response = client.get(f"/api/v1/agent-runs/{run_id}/events")
    assert events_response.status_code == 200
    events_payload = events_response.json()
    assert events_payload[0]["event_type"] == "run.started"
    assert events_payload[-1]["event_type"] == "run.completed"
    assert any(event["event_type"] == "run.message.completed" for event in events_payload)


def test_run_failure_is_persisted(client: TestClient):
    _, conversation_id = bootstrap_user_and_project(client)
    client.app.state.run_manager._runner_factory = FailingRunner

    message_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "model": "openai/gpt-5.4-mini",
            "thinking_level": "off",
            "input_mode": "text",
            "content_text": "Cause a failure.",
            "asset_ids": [],
        },
    )
    assert message_response.status_code == 202
    run_id = message_response.json()["agent_run_id"]

    terminal_payload = None
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                terminal_payload = payload
                break

    assert terminal_payload is not None
    assert terminal_payload["type"] == "run.failed"
    assert "Synthetic provider failure" in terminal_payload["error"]

    session = get_session_factory()()
    try:
        run = session.get(AgentRun, run_id)
        assert run is not None
        assert run.status == "failed"
        message = session.get(MessageRecord, run.trigger_message_id)
        assert message is not None
        assert message.status == "failed"
    finally:
        session.close()

    run_response = client.get(f"/api/v1/agent-runs/{run_id}")
    assert run_response.status_code == 200
    assert run_response.json()["status"] == "failed"
    assert "Synthetic provider failure" in run_response.json()["error_message"]

    events_response = client.get(f"/api/v1/agent-runs/{run_id}/events")
    assert events_response.status_code == 200
    assert events_response.json()[-1]["event_type"] == "run.failed"


def test_conversation_active_run_conflict_returns_409(client: TestClient):
    _, conversation_id = bootstrap_user_and_project(client)
    client.app.state.run_manager._runner_factory = SlowPendingRunner

    first = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "model": "openai/gpt-5.4-mini",
            "thinking_level": "off",
            "input_mode": "text",
            "content_text": "First request",
            "asset_ids": [],
        },
    )
    assert first.status_code == 202
    run_id = first.json()["agent_run_id"]

    active_run = client.get(f"/api/v1/conversations/{conversation_id}/active-run")
    assert active_run.status_code == 200
    assert active_run.json()["id"] == run_id

    second = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "model": "openai/gpt-5.4-mini",
            "thinking_level": "off",
            "input_mode": "text",
            "content_text": "Second request",
            "asset_ids": [],
        },
    )
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "conversation_run_in_progress"
    assert second.json()["detail"]["run_id"] == run_id

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break


def test_trace_endpoints_404_for_unknown_run(client: TestClient):
    unknown_id = "00000000-0000-0000-0000-000000000000"

    assert client.get(f"/api/v1/agent-runs/{unknown_id}").status_code == 404
    assert client.get(f"/api/v1/agent-runs/{unknown_id}/turns").status_code == 404
    assert client.get(f"/api/v1/agent-runs/{unknown_id}/events").status_code == 404


def test_create_conversation_default_placeholder_title(client: TestClient):
    bootstrap = client.post("/api/v1/bootstrap", json={"display_name": "Ayush", "preferences": {}})
    assert bootstrap.status_code == 201
    project = client.post("/api/v1/projects", json={"name": "Lab"})
    assert project.status_code == 201
    project_id = project.json()["id"]

    created = client.post(f"/api/v1/projects/{project_id}/conversations", json={"summary": None})
    assert created.status_code == 201
    assert created.json()["title"] == "New conversation"


def test_first_user_message_derives_conversation_title(client: TestClient):
    project_id, conversation_id = bootstrap_user_and_project(client)
    client.patch(
        f"/api/v1/conversations/{conversation_id}",
        json={"title": "New conversation"},
    )

    client.app.state.run_manager._runner_factory = FakeRunner

    message_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "model": "openai/gpt-5.4-mini",
            "thinking_level": "off",
            "input_mode": "text",
            "content_text": "Absolutely this is the question",
            "asset_ids": [],
        },
    )
    assert message_response.status_code == 202
    run_id = message_response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    listed = client.get(f"/api/v1/projects/{project_id}/conversations")
    assert listed.status_code == 200
    titles = {row["id"]: row["title"] for row in listed.json()}
    assert titles[conversation_id] == "Absol..."


def test_first_message_does_not_overwrite_renamed_title(client: TestClient):
    project_id, conversation_id = bootstrap_user_and_project(client)

    patched = client.patch(
        f"/api/v1/conversations/{conversation_id}",
        json={"title": "My custom title"},
    )
    assert patched.status_code == 200

    client.app.state.run_manager._runner_factory = FakeRunner

    message_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "model": "openai/gpt-5.4-mini",
            "thinking_level": "off",
            "input_mode": "text",
            "content_text": "Hello",
            "asset_ids": [],
        },
    )
    assert message_response.status_code == 202
    run_id = message_response.json()["agent_run_id"]

    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    listed = client.get(f"/api/v1/projects/{project_id}/conversations")
    assert listed.json()[0]["title"] == "My custom title"


def test_archive_project_soft_delete(client: TestClient):
    project_id, conversation_id = bootstrap_user_and_project(client)

    deleted = client.delete(f"/api/v1/projects/{project_id}")
    assert deleted.status_code == 200
    assert deleted.json()["archived_at"] is not None

    assert client.get(f"/api/v1/projects/{project_id}").status_code == 404

    listed = client.get("/api/v1/projects")
    assert listed.status_code == 200
    assert all(row["id"] != project_id for row in listed.json())

    assert client.get(f"/api/v1/conversations/{conversation_id}/messages").status_code == 404

    message_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "model": "openai/gpt-5.4-mini",
            "thinking_level": "off",
            "input_mode": "text",
            "content_text": "Still there?",
            "asset_ids": [],
        },
    )
    assert message_response.status_code == 404


class SlowStreamingRunner:
    """Emits many small delta events with awaits between them so the stream
    is actively producing events while a websocket client is mid-replay.
    Used to exercise the subscribe/replay race fix."""

    THINKING_CHUNKS = ["Examining ", "the ", "matter ", "carefully ", "now."]
    CONTENT_CHUNKS = ["The ", "answer ", "is ", "ready ", "for ", "you."]
    TOOL_CALLS = [
        ToolCall(id="call_read_pdf", name="read_file", arguments={"scope": "project", "path": "trend_following.pdf"}),
        ToolCall(id="call_read_chart", name="read_file", arguments={"scope": "project", "path": "chart-1-1024x770.jpg"}),
    ]

    async def stream(self, request):
        for chunk in self.THINKING_CHUNKS:
            await asyncio.sleep(0.01)
            yield AgentEvent(
                type=AgentEventType.THINKING,
                provider="fake",
                model=request.model,
                round_index=0,
                response=LLMResponse(
                    content="",
                    thinking=chunk,
                    usage=UsageStats(),
                    raw_dump={},
                    metadata={"provider": "fake", "model": request.model},
                ),
            )
        yield AgentEvent(
            type=AgentEventType.ASSISTANT_MESSAGE,
            provider="fake",
            model=request.model,
            round_index=0,
            message=Message(
                role=MessageRole.ASSISTANT,
                content="I will inspect the PDF first, then the chart image.",
                tool_calls=self.TOOL_CALLS,
            ),
        )
        for tool_call in self.TOOL_CALLS:
            await asyncio.sleep(0.01)
            yield AgentEvent(
                type=AgentEventType.TOOL_CALL,
                provider="fake",
                model=request.model,
                round_index=0,
                tool_call=tool_call,
            )
            await asyncio.sleep(0.01)
            yield AgentEvent(
                type=AgentEventType.TOOL_RESULT,
                provider="fake",
                model=request.model,
                round_index=0,
                tool_call=tool_call,
                tool_result=(
                    '{"ok":true,"tool_name":"read_file","data":{"path":"%s","content":"sample","more_available":false}}'
                    % tool_call.arguments["path"]
                ),
            )
        for chunk in self.CONTENT_CHUNKS:
            await asyncio.sleep(0.01)
            yield AgentEvent(
                type=AgentEventType.CONTENT,
                provider="fake",
                model=request.model,
                round_index=0,
                response=LLMResponse(
                    content=chunk,
                    usage=UsageStats(),
                    raw_dump={},
                    metadata={"provider": "fake", "model": request.model},
                ),
            )
        yield AgentEvent(
            type=AgentEventType.FINAL_RESPONSE,
            provider="fake",
            model=request.model,
            round_index=1,
            response=LLMResponse(
                content="".join(self.CONTENT_CHUNKS),
                thinking="".join(self.THINKING_CHUNKS),
                usage=UsageStats(input_tokens=5, output_tokens=6, completion_tokens=6, total_tokens=11),
                raw_dump={"final": True},
                metadata={
                    "provider": "fake",
                    "model": request.model,
                    "agent_usage": {
                        "input_tokens": 5,
                        "output_tokens": 6,
                        "completion_tokens": 6,
                        "total_tokens": 11,
                    },
                    "agent_turn_telemetry": [
                        {
                            "round_index": 0,
                            "phase": "tool",
                            "elapsed_ms": 1.0,
                            "usage": {
                                "input_tokens": 5,
                                "output_tokens": 6,
                                "completion_tokens": 6,
                                "total_tokens": 11,
                            },
                            "tool_call_count": len(self.TOOL_CALLS),
                            "parsed_output": False,
                            "had_thinking": True,
                        }
                    ],
                    "agent_elapsed_ms": 2.0,
                },
            ),
        )


def test_websocket_stream_has_no_gap_or_duplicate_under_race(client: TestClient):
    """Regression: events emitted between WS replay and subscribe must not
    be lost, and replayed events must not be re-delivered from the live queue.
    Each WS payload must carry a monotonically increasing `seq`, with no
    duplicates and no missing values."""

    _, conversation_id = bootstrap_user_and_project(client)
    client.app.state.run_manager._runner_factory = SlowStreamingRunner

    message_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "model": "openai/gpt-5.4-mini",
            "thinking_level": "low",
            "input_mode": "text",
            "content_text": "Stream me carefully.",
            "asset_ids": [],
        },
    )
    assert message_response.status_code == 202
    run_id = message_response.json()["agent_run_id"]

    received: list[dict] = []
    last_seq = 0
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while len(received) < 6:
            payload = websocket.receive_json()
            received.append(payload)
            if isinstance(payload.get("seq"), int):
                last_seq = payload["seq"]
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    resumed: list[dict] = []
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream?after_seq={last_seq}") as websocket:
        while True:
            payload = websocket.receive_json()
            resumed.append(payload)
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    assert received[0]["type"] == "run.snapshot"
    assert resumed[0]["type"] == "run.snapshot"

    combined = received[1:] + resumed[1:]
    seqs = [payload.get("seq") for payload in combined]
    assert all(isinstance(seq, int) for seq in seqs), f"every payload must carry an int seq, got {seqs}"
    assert seqs == sorted(set(seqs)), f"seqs must be strictly increasing with no duplicates, got {seqs}"

    session = get_session_factory()()
    try:
        persisted = (
            session.query(AgentEventRecord)
            .filter(AgentEventRecord.agent_run_id == run_id)
            .order_by(AgentEventRecord.sequence_no.asc())
            .all()
        )
        persisted_seqs = [record.sequence_no for record in persisted]
    finally:
        session.close()

    assert seqs == persisted_seqs, (
        "WS client must observe every persisted event exactly once. "
        f"received={seqs} persisted={persisted_seqs}"
    )

    types = [payload["type"] for payload in combined]
    assert types[0] == "run.started"
    assert types[-1] == "run.completed"
    assert types.count("run.assistant.message") == 1
    assert types.count("run.tool.called") == len(SlowStreamingRunner.TOOL_CALLS)
    assert types.count("run.tool.result") == len(SlowStreamingRunner.TOOL_CALLS)

    thinking_deltas = [payload for payload in combined if payload["type"] == "run.thinking.delta"]
    content_deltas = [payload for payload in combined if payload["type"] == "run.content.delta"]
    assert 1 <= len(thinking_deltas) <= len(SlowStreamingRunner.THINKING_CHUNKS)
    assert 1 <= len(content_deltas) <= len(SlowStreamingRunner.CONTENT_CHUNKS)
    assert "".join(payload["delta"] for payload in thinking_deltas) == "".join(SlowStreamingRunner.THINKING_CHUNKS)
    assert "".join(payload["delta"] for payload in content_deltas) == "".join(SlowStreamingRunner.CONTENT_CHUNKS)

    tool_result_indices = [index for index, event_type in enumerate(types) if event_type == "run.tool.result"]
    assert tool_result_indices
    assert any(types[index] == "run.assistant.message" for index in range(min(tool_result_indices)))

    assistant_message_index = types.index("run.assistant.message")
    last_tool_result_index = max(tool_result_indices)
    for index, event_type in enumerate(types):
        if event_type == "run.thinking.delta":
            assert index < assistant_message_index, "thinking deltas must flush before assistant message"
        if event_type == "run.content.delta":
            assert index > last_tool_result_index, "content deltas must flush after all tool results"

    events_response = client.get(f"/api/v1/agent-runs/{run_id}/events")
    assert events_response.status_code == 200
    event_types = [event["event_type"] for event in events_response.json()]
    assert "run.assistant.message" in event_types
    assert event_types.count("run.tool.called") == len(SlowStreamingRunner.TOOL_CALLS)
    assert event_types.count("run.tool.result") == len(SlowStreamingRunner.TOOL_CALLS)


def test_stream_survives_non_json_safe_tool_payload(client: TestClient):
    """Regression: a tool result containing NaN/Infinity/bytes/Decimal must be
    sanitized before it is persisted and published. The WS client must receive
    a valid `run.completed` event rather than having the socket torn down
    mid-stream."""

    import json

    _, conversation_id = bootstrap_user_and_project(client)
    client.app.state.run_manager._runner_factory = MalformedPayloadRunner

    message_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "model": "openai/gpt-5.4-mini",
            "thinking_level": "low",
            "input_mode": "text",
            "content_text": "Parse this.",
            "asset_ids": [],
        },
    )
    assert message_response.status_code == 202
    run_id = message_response.json()["agent_run_id"]

    received: list[dict] = []
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            received.append(payload)
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    types = [payload["type"] for payload in received]
    assert types[0] == "run.snapshot"
    assert "run.tool.called" in types
    assert "run.tool.result" in types
    assert types[-1] == "run.completed", f"stream must reach a clean terminal state, got {types}"

    tool_called_payload = next(payload for payload in received if payload["type"] == "run.tool.called")
    arguments = tool_called_payload["tool_call"]["arguments"]
    assert arguments["scope"] == "project"
    assert arguments["path"] == "bad.json"
    assert arguments["score"] is None
    assert arguments["limit"] is None
    assert arguments["tax"] == 1.5
    assert arguments["checksum"] == {"type": "bytes", "length": 3, "base64": "AAEC"}
    assert arguments["trace_id"] == "12345678-1234-5678-1234-567812345678"

    for payload in received:
        json.dumps(payload, allow_nan=False)


@pytest.fixture
def fast_heartbeat_client(monkeypatch, tmp_path):
    app_data_dir = tmp_path / "appdata"
    monkeypatch.setenv("APP_DATA_DIR", str(app_data_dir))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'premchat.sqlite3'}")
    monkeypatch.setenv("STREAM_HEARTBEAT_INTERVAL_SECONDS", "1")

    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


def test_stream_emits_heartbeats_while_idle(fast_heartbeat_client: TestClient):
    """Regression: while the agent is mid-reasoning and no events are being
    published, the WebSocket must emit application-level heartbeats so that
    intermediary proxies / load balancers do not close the idle connection."""

    client = fast_heartbeat_client
    _, conversation_id = bootstrap_user_and_project(client)
    client.app.state.run_manager._runner_factory = IdleStreamingRunner

    message_response = client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={
            "model": "openai/gpt-5.4-mini",
            "thinking_level": "low",
            "input_mode": "text",
            "content_text": "Pause then answer.",
            "asset_ids": [],
        },
    )
    assert message_response.status_code == 202
    run_id = message_response.json()["agent_run_id"]

    received: list[dict] = []
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            received.append(payload)
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    types = [payload["type"] for payload in received]
    assert types[0] == "run.snapshot"
    assert types[-1] == "run.completed"
    heartbeats = [payload for payload in received if payload["type"] == "run.heartbeat"]
    assert heartbeats, f"expected at least one heartbeat during the idle phase, got types={types}"
    for heartbeat in heartbeats:
        assert heartbeat["run_id"] == run_id
        assert isinstance(heartbeat.get("ts"), str) and heartbeat["ts"]
        assert "seq" not in heartbeat or heartbeat["seq"] is None


def test_archive_conversation_soft_delete(client: TestClient):
    project_id, conversation_id = bootstrap_user_and_project(client)

    deleted = client.delete(f"/api/v1/conversations/{conversation_id}")
    assert deleted.status_code == 200
    assert deleted.json()["archived_at"] is not None

    listed = client.get(f"/api/v1/projects/{project_id}/conversations")
    assert listed.status_code == 200
    assert listed.json() == []

    assert client.get(f"/api/v1/conversations/{conversation_id}/messages").status_code == 404
