from decimal import Decimal

import pytest

from app.llm.registry import ModelRegistry
from app.llm.service import LLMService
from app.llm.types import LLMResponse, UsageInfo
from app.services.chat import send_chat_message
from app.services.conversations import create_conversation, list_conversations, update_conversation
from app.services.messages import create_message, list_messages
from app.schemas.conversation import ConversationUpdateRequest, CreateConversationRequest
from app.schemas.message import ChatTurnRequest, MessageCreateRequest


class FakeChatProvider:
    provider_name = "openrouter"

    def __init__(self):
        self.calls = []

    async def generate(self, request, model_spec):
        self.calls.append((request, model_spec))
        return LLMResponse(
            provider=model_spec.provider,
            model=model_spec.public_id,
            provider_message_id="provider-msg-1",
            request_id="request-1",
            output_text="Generated assistant reply",
            structured_output=None,
            finish_reason="stop",
            usage=UsageInfo(
                input_tokens=11,
                output_tokens=22,
                total_tokens=33,
                cost_usd=Decimal("0.003300"),
            ),
            provider_metadata={
                "upstreamModel": model_spec.upstream_model_id,
                "reasoning": "Reasoning trace",
                "reasoningDetails": [{"type": "reasoning.text", "text": "Reasoning trace"}],
            },
            raw_response={"id": "provider-msg-1"},
        )


@pytest.mark.asyncio
async def test_create_and_list_conversations(db_session):
    conversation = await create_conversation(
        db_session,
        CreateConversationRequest(title="Backend Setup", metadata={"source": "test"}),
    )

    conversations = await list_conversations(db_session)

    assert conversation.title == "Backend Setup"
    assert len(conversations) == 1
    assert conversations[0].id == conversation.id


@pytest.mark.asyncio
async def test_create_message_updates_cached_aggregates(db_session):
    conversation = await create_conversation(
        db_session,
        CreateConversationRequest(title="Aggregate Test"),
    )

    message = await create_message(
        db_session,
        conversation.id,
        MessageCreateRequest(
            role="user",
            content_text="Hello backend",
            input_tokens=12,
            output_tokens=34,
            total_tokens=46,
            cost_usd=Decimal("0.012345"),
            attachments=[
                {
                    "attachmentType": "image",
                    "mimeType": "image/png",
                    "sourceUrl": "https://example.com/image.png",
                }
            ],
            tool_calls=[
                {
                    "toolName": "web_search",
                    "status": "completed",
                    "argumentsJson": {"q": "premchat"},
                    "resultJson": {"hits": 1},
                }
            ],
            llm_events=[
                {
                    "provider": "openai",
                    "eventType": "response.completed",
                    "eventIndex": 0,
                    "payload": {"ok": True},
                }
            ],
        ),
    )

    refreshed_messages = await list_messages(db_session, conversation.id)
    refreshed_conversations = await list_conversations(db_session)
    refreshed_conversation = refreshed_conversations[0]

    assert message.sequence_number == 1
    assert len(refreshed_messages) == 1
    assert refreshed_conversation.message_count == 1
    assert refreshed_conversation.total_tokens == 46
    assert refreshed_conversation.total_cost_usd == Decimal("0.012345")
    assert len(refreshed_messages[0].attachments) == 1
    assert len(refreshed_messages[0].tool_calls) == 1
    assert len(refreshed_messages[0].llm_events) == 1


@pytest.mark.asyncio
async def test_soft_deleted_conversation_disappears_from_list(db_session):
    conversation = await create_conversation(
        db_session,
        CreateConversationRequest(title="Delete Me"),
    )

    await update_conversation(
        db_session,
        conversation.id,
        ConversationUpdateRequest(status="deleted"),
    )

    conversations = await list_conversations(db_session)

    assert conversations == []


@pytest.mark.asyncio
async def test_send_chat_message_persists_assistant_and_updates_defaults(
    db_session, monkeypatch
):
    conversation = await create_conversation(
        db_session,
        CreateConversationRequest(title="Chat Loop"),
    )
    provider = FakeChatProvider()
    llm_service = LLMService(
        registry=ModelRegistry(),
        providers={"openrouter": provider},
    )

    monkeypatch.setattr("app.services.chat.build_llm_service", lambda: llm_service)

    result = await send_chat_message(
        db_session,
        conversation.id,
        ChatTurnRequest(
            content="Switch to Kimi",
            model="moonshotai/kimi-k2.5",
            thinking_enabled=True,
        ),
    )

    assert result.conversation.default_model == "moonshotai/kimi-k2.5"
    assert result.conversation.default_provider == "openrouter"
    assert result.conversation.thinking_enabled is True
    assert result.user_message.role == "user"
    assert result.assistant_message.role == "assistant"
    assert result.assistant_message.model == "moonshotai/kimi-k2.5"
    assert result.assistant_message.provider == "openrouter"
    assert result.assistant_message.total_tokens == 33
    assert result.assistant_message.cost_usd == Decimal("0.003300")
    assert result.assistant_message.provider_metadata["reasoning"] == "Reasoning trace"
    assert result.assistant_message.provider_metadata["reasoningDetails"][0]["text"] == "Reasoning trace"
