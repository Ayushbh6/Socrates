from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from backend.src.agent.events import AgentEvent, AgentEventType
from backend.src.app import create_app
from backend.src.core.schema import LLMResponse, UsageStats
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


def test_project_workspace_registration_and_primary_switch(client: TestClient):
    project_id, _ = bootstrap_user_and_project(client)

    created = client.post(
        f"/api/v1/projects/{project_id}/workspaces",
        json={
            "label": "Sandbox",
            "relative_path": "sandbox",
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
            "relative_path": "reports",
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

    assert seen_types[0] == "run.started"
    assert "run.turn.started" in seen_types
    assert "run.thinking.delta" in seen_types
    assert "run.content.delta" in seen_types
    assert "run.message.completed" in seen_types
    assert seen_types[-1] == "run.completed"

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
                            "tool_call_count": 0,
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
    with client.websocket_connect(f"/api/v1/agent-runs/{run_id}/stream") as websocket:
        while True:
            payload = websocket.receive_json()
            received.append(payload)
            if payload["type"] in {"run.completed", "run.failed"}:
                break

    seqs = [payload.get("seq") for payload in received]
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

    types = [payload["type"] for payload in received]
    assert types[0] == "run.started"
    assert types[-1] == "run.completed"
    assert types.count("run.thinking.delta") == len(SlowStreamingRunner.THINKING_CHUNKS)
    assert types.count("run.content.delta") == len(SlowStreamingRunner.CONTENT_CHUNKS)


def test_archive_conversation_soft_delete(client: TestClient):
    project_id, conversation_id = bootstrap_user_and_project(client)

    deleted = client.delete(f"/api/v1/conversations/{conversation_id}")
    assert deleted.status_code == 200
    assert deleted.json()["archived_at"] is not None

    listed = client.get(f"/api/v1/projects/{project_id}/conversations")
    assert listed.status_code == 200
    assert listed.json() == []

    assert client.get(f"/api/v1/conversations/{conversation_id}/messages").status_code == 404
