from __future__ import annotations

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
    assert payload[0]["assets"][0]["id"] == asset_id
    assert payload[0]["model"] == "openai/gpt-5.4-mini"
    assert payload[1]["role"] == "assistant"
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
