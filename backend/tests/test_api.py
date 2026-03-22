from decimal import Decimal

import pytest

from app.llm.registry import ModelRegistry
from app.llm.service import LLMService
from app.llm.types import LLMResponse, UsageInfo


class FakeChatProvider:
    provider_name = "openai"

    async def generate(self, request, model_spec):
        return LLMResponse(
            provider=model_spec.provider,
            model=model_spec.public_id,
            provider_message_id="provider-msg-api",
            request_id="request-api",
            output_text="Stored response",
            structured_output=None,
            finish_reason="stop",
            usage=UsageInfo(
                input_tokens=10,
                output_tokens=20,
                total_tokens=30,
                cost_usd=Decimal("0.010000"),
            ),
            provider_metadata={"upstreamModel": model_spec.upstream_model_id},
            raw_response={"id": "provider-msg-api"},
        )


def _patch_chat_service(monkeypatch):
    llm_service = LLMService(
        registry=ModelRegistry(),
        providers={
            "openai": FakeChatProvider(),
            "openrouter": FakeChatProvider(),
        },
    )
    monkeypatch.setattr("app.services.chat.build_llm_service", lambda: llm_service)


@pytest.mark.asyncio
async def test_healthz(client):
    response = await client.get("/healthz")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["pgvectorEnabled"] is True


@pytest.mark.asyncio
async def test_users_me(client):
    response = await client.get("/api/v1/users/me")

    assert response.status_code == 200
    body = response.json()
    assert body["user"]["email"] == "dev@premchat.local"
    assert body["user"]["displayName"] == "PremChat Dev"


@pytest.mark.asyncio
async def test_models_endpoint(client):
    response = await client.get("/api/v1/models")

    assert response.status_code == 200
    models = response.json()["models"]
    assert any(model["id"] == "gpt-5.2" for model in models)
    assert any(model["id"] == "moonshotai/kimi-k2.5" for model in models)


@pytest.mark.asyncio
async def test_conversation_and_message_endpoints(client, monkeypatch):
    _patch_chat_service(monkeypatch)
    create_response = await client.post(
        "/api/v1/conversations",
        json={
            "title": "API Conversation",
            "metadata": {"surface": "api"},
            "model": "gpt-5.2",
            "thinkingEnabled": False,
        },
    )

    assert create_response.status_code == 201
    conversation = create_response.json()["conversation"]
    assert conversation["model"] == "gpt-5.2"
    assert conversation["thinkingEnabled"] is False

    message_response = await client.post(
        f"/api/v1/conversations/{conversation['id']}/messages",
        json={
            "content": "Stored response request",
            "model": "gpt-5.4-mini",
            "thinkingEnabled": True,
        },
    )

    assert message_response.status_code == 201
    payload = message_response.json()
    assert payload["userMessage"]["sequenceNumber"] == 1
    assert payload["assistantMessage"]["sequenceNumber"] == 2
    assert payload["conversation"]["model"] == "gpt-5.4-mini"
    assert payload["conversation"]["thinkingEnabled"] is True

    detail_response = await client.get(f"/api/v1/conversations/{conversation['id']}")
    messages_response = await client.get(
        f"/api/v1/conversations/{conversation['id']}/messages"
    )

    assert detail_response.status_code == 200
    assert messages_response.status_code == 200
    assert detail_response.json()["conversation"]["messageCount"] == 2
    assert messages_response.json()["messages"][0]["contentText"] == "Stored response request"
    assert messages_response.json()["messages"][1]["model"] == "gpt-5.4-mini"


@pytest.mark.asyncio
async def test_404_for_missing_conversation(client):
    response = await client.get("/api/v1/conversations/00000000-0000-0000-0000-000000000999")

    assert response.status_code == 404


@pytest.mark.asyncio
async def test_400_for_invalid_message_payload(client):
    create_response = await client.post("/api/v1/conversations", json={"title": "Validation"})
    conversation_id = create_response.json()["conversation"]["id"]

    response = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content": ""},
    )

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_camel_case_response_fields(client, monkeypatch):
    _patch_chat_service(monkeypatch)
    create_response = await client.post("/api/v1/conversations", json={"title": "Camel"})
    conversation_id = create_response.json()["conversation"]["id"]

    response = await client.post(
        f"/api/v1/conversations/{conversation_id}/messages",
        json={"content": "hello"},
    )

    payload = response.json()["assistantMessage"]

    assert "conversationId" in payload
    assert "sequenceNumber" in payload
    assert "providerMetadata" in payload
    assert "createdAt" in payload


@pytest.mark.asyncio
async def test_patch_conversation_title(client):
    create_response = await client.post(
        "/api/v1/conversations",
        json={"title": "Rename me", "model": "gpt-5.2"},
    )
    conversation_id = create_response.json()["conversation"]["id"]

    response = await client.patch(
        f"/api/v1/conversations/{conversation_id}",
        json={"title": "Renamed thread"},
    )

    assert response.status_code == 200
    assert response.json()["conversation"]["title"] == "Renamed thread"


@pytest.mark.asyncio
async def test_patch_conversation_deleted_excludes_from_list(client):
    create_response = await client.post(
        "/api/v1/conversations",
        json={"title": "Delete me", "model": "gpt-5.2"},
    )
    conversation_id = create_response.json()["conversation"]["id"]

    delete_response = await client.patch(
        f"/api/v1/conversations/{conversation_id}",
        json={"status": "deleted"},
    )
    list_response = await client.get("/api/v1/conversations")
    detail_response = await client.get(f"/api/v1/conversations/{conversation_id}")

    assert delete_response.status_code == 200
    assert all(
        item["id"] != conversation_id for item in list_response.json()["conversations"]
    )
    assert detail_response.status_code == 404
