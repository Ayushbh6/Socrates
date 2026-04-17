from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_THINKING_ENABLED
from app.db.models.conversation import Conversation
from app.db.models.message import Message
from app.db.session import SessionLocal
from app.llm.runtime import build_llm_service
from app.llm.types import ImageContentPart, LLMInputMessage, LLMRequest, TextContentPart
from app.repositories.conversations import get_conversation_for_user
from app.schemas.conversation import ConversationDetailResponse
from app.schemas.message import ChatTurnRequest, MessageCreateRequest
from app.schemas.serializers import serialize_conversation_detail_with_messages, serialize_message
from app.repositories.messages import list_messages_for_conversation
from app.services.messages import persist_message
from app.services.users import get_dev_user


@dataclass(slots=True)
class ChatTurnResult:
    conversation: Conversation
    conversation_response: ConversationDetailResponse
    user_message: Message
    assistant_message: Message


def _truncate_title(text: str, limit: int = 48) -> str:
    normalized = " ".join(text.split()).strip()
    if not normalized:
        return "New conversation"
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1].rstrip() + "…"


def _message_to_llm_input(
    message: Message,
    *,
    include_reasoning_continuity: bool,
) -> LLMInputMessage:
    content: list[TextContentPart | ImageContentPart] = []

    if message.content_text:
        content.append(TextContentPart(text=message.content_text))

    if message.role == "user":
        for attachment in message.attachments:
            if attachment.attachment_type != "image":
                continue
            image_url = attachment.source_url or attachment.storage_path
            if not image_url:
                continue
            content.append(
                ImageContentPart(
                    image_url=image_url,
                    mime_type=attachment.mime_type,
                )
            )

    provider_metadata: dict = {}
    if include_reasoning_continuity and message.role == "assistant":
        reasoning = message.provider_metadata.get("reasoning")
        reasoning_details = message.provider_metadata.get("reasoningDetails")
        if reasoning is not None:
            provider_metadata["reasoning"] = reasoning
        if reasoning_details is not None:
            provider_metadata["reasoningDetails"] = reasoning_details

    return LLMInputMessage(
        role=message.role,
        content=content or [TextContentPart(text="")],
        provider_metadata=provider_metadata,
    )


def _assistant_text_from_response(output_text: str, structured_output) -> str:
    if output_text:
        return output_text
    if structured_output is not None:
        return json.dumps(structured_output, ensure_ascii=True)
    return ""


def _llm_event_record(event) -> dict:
    return {
        "provider": event.provider,
        "model": event.model,
        "eventType": event.event_type,
        "eventIndex": event.event_index,
        "isTerminal": event.event_type == "response.completed",
        "inputTokens": event.input_tokens,
        "outputTokens": event.output_tokens,
        "latencyMs": event.latency_ms,
        "payload": event.payload,
    }


def _decimal_from_payload(value: str | int | float | None) -> Decimal:
    if value is None:
        return Decimal("0")
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal("0")


async def send_chat_message(
    session: AsyncSession,
    conversation_id: UUID,
    payload: ChatTurnRequest,
) -> ChatTurnResult:
    content = payload.content.strip()
    if not content:
        raise ValueError("Message content is required.")

    user = await get_dev_user(session)
    conversation = await get_conversation_for_user(
        session,
        conversation_id,
        user.id,
        include_messages=True,
        for_update=True,
    )
    if conversation is None:
        raise ValueError("Conversation not found.")
    if conversation.status == "deleted" or conversation.deleted_at is not None:
        raise ValueError("Cannot add messages to a deleted conversation.")

    llm_service = build_llm_service()
    if payload.model is not None:
        model_spec = llm_service.registry.resolve(payload.model, payload.provider)
    else:
        effective_model = conversation.default_model or DEFAULT_MODEL
        effective_provider = payload.provider or conversation.default_provider or DEFAULT_PROVIDER
        model_spec = llm_service.registry.resolve(effective_model, effective_provider)

    effective_thinking_enabled = (
        conversation.thinking_enabled
        if payload.thinking_enabled is None
        else payload.thinking_enabled
    )
    if effective_thinking_enabled is None:
        effective_thinking_enabled = DEFAULT_THINKING_ENABLED

    if conversation.title == "New conversation" or conversation.message_count == 0:
        conversation.title = _truncate_title(content)

    user_message = await persist_message(
        session,
        conversation=conversation,
        actor_user_id=user.id,
        payload=MessageCreateRequest(
            role="user",
            status="completed",
            content_text=content,
        ),
        commit=False,
    )

    history = [
        _message_to_llm_input(
            message,
            include_reasoning_continuity=(
                model_spec.provider == "openrouter"
                and model_spec.supports_reasoning_continuity
                and message.provider == "openrouter"
            ),
        )
        for message in sorted(conversation.messages, key=lambda item: item.sequence_number)
    ]
    history.append(
        LLMInputMessage(
            role="user",
            content=[TextContentPart(text=content)],
        )
    )

    llm_response = await llm_service.generate(
        LLMRequest(
            provider=model_spec.provider,
            model=model_spec.public_id,
            messages=history,
            thinking_enabled=effective_thinking_enabled,
            conversation_id=conversation.id,
            message_id=user_message.id,
        )
    )

    assistant_provider_metadata = dict(llm_response.provider_metadata)
    assistant_provider_metadata["thinkingEnabled"] = effective_thinking_enabled
    assistant_content = _assistant_text_from_response(
        llm_response.output_text,
        llm_response.structured_output,
    )

    assistant_message = await persist_message(
        session,
        conversation=conversation,
        actor_user_id=user.id,
        payload=MessageCreateRequest(
            role="assistant",
            status="completed",
            content_text=assistant_content,
            provider=model_spec.provider,
            model=model_spec.public_id,
            provider_message_id=llm_response.provider_message_id,
            request_id=llm_response.request_id,
            input_tokens=llm_response.usage.input_tokens,
            output_tokens=llm_response.usage.output_tokens,
            total_tokens=llm_response.usage.total_tokens,
            cost_usd=Decimal(llm_response.usage.cost_usd),
            stop_reason=llm_response.finish_reason,
            provider_metadata=assistant_provider_metadata,
            raw_response=llm_response.raw_response,
            tool_calls=[
                {
                    "toolCallId": item.tool_call_id,
                    "toolName": item.tool_name,
                    "status": "completed",
                    "argumentsJson": item.arguments_json,
                    "providerMetadata": item.provider_metadata,
                }
                for item in llm_response.tool_calls
            ],
            llm_events=[
                {
                    "provider": model_spec.provider,
                    "model": model_spec.public_id,
                    "eventType": "response.completed",
                    "eventIndex": 0,
                    "isTerminal": True,
                    "inputTokens": llm_response.usage.input_tokens,
                    "outputTokens": llm_response.usage.output_tokens,
                    "payload": {
                        "finishReason": llm_response.finish_reason,
                        "providerMessageId": llm_response.provider_message_id,
                        "requestId": llm_response.request_id,
                        "reasoning": assistant_provider_metadata.get("reasoning"),
                        "reasoningDetails": assistant_provider_metadata.get("reasoningDetails"),
                    },
                }
            ],
        ),
        commit=False,
    )

    conversation.default_provider = model_spec.provider
    conversation.default_model = model_spec.public_id
    conversation.thinking_enabled = effective_thinking_enabled

    await session.commit()

    refreshed = await get_conversation_for_user(
        session,
        conversation_id,
        user.id,
        include_messages=False,
        include_deleted=True,
    )
    if refreshed is None:
        raise RuntimeError("Conversation could not be reloaded after chat turn.")

    refreshed_messages = await list_messages_for_conversation(session, conversation_id)
    refreshed_by_id = {item.id: item for item in refreshed_messages}

    return ChatTurnResult(
        conversation=refreshed,
        conversation_response=serialize_conversation_detail_with_messages(
            refreshed,
            refreshed_messages,
        ),
        user_message=refreshed_by_id[user_message.id],
        assistant_message=refreshed_by_id[assistant_message.id],
    )


async def stream_chat_message_events(
    conversation_id: UUID,
    payload: ChatTurnRequest,
) -> AsyncIterator[dict]:
    content = payload.content.strip()
    if not content:
        raise ValueError("Message content is required.")

    async with SessionLocal() as session:
        user = await get_dev_user(session)
        conversation = await get_conversation_for_user(
            session,
            conversation_id,
            user.id,
            include_messages=True,
            for_update=True,
        )
        if conversation is None:
            raise ValueError("Conversation not found.")
        if conversation.status == "deleted" or conversation.deleted_at is not None:
            raise ValueError("Cannot add messages to a deleted conversation.")

        llm_service = build_llm_service()
        if payload.model is not None:
            model_spec = llm_service.registry.resolve(payload.model, payload.provider)
        else:
            effective_model = conversation.default_model or DEFAULT_MODEL
            effective_provider = (
                payload.provider or conversation.default_provider or DEFAULT_PROVIDER
            )
            model_spec = llm_service.registry.resolve(effective_model, effective_provider)

        effective_thinking_enabled = (
            conversation.thinking_enabled
            if payload.thinking_enabled is None
            else payload.thinking_enabled
        )
        if effective_thinking_enabled is None:
            effective_thinking_enabled = DEFAULT_THINKING_ENABLED

        if conversation.title == "New conversation" or conversation.message_count == 0:
            conversation.title = _truncate_title(content)

        conversation.default_provider = model_spec.provider
        conversation.default_model = model_spec.public_id
        conversation.thinking_enabled = effective_thinking_enabled

        user_message = await persist_message(
            session,
            conversation=conversation,
            actor_user_id=user.id,
            payload=MessageCreateRequest(
                role="user",
                status="completed",
                content_text=content,
            ),
            commit=False,
        )
        await session.commit()

        history_messages = await list_messages_for_conversation(session, conversation_id)
        history = [
            _message_to_llm_input(
                message,
                include_reasoning_continuity=(
                    model_spec.provider == "openrouter"
                    and model_spec.supports_reasoning_continuity
                    and message.provider == "openrouter"
                ),
            )
            for message in history_messages
        ]

        assistant_stream_id = f"stream-{uuid4()}"
        assistant_message_event = {
            "id": assistant_stream_id,
            "conversationId": str(conversation.id),
            "role": "assistant",
            "content": "",
            "createdAt": user_message.created_at.isoformat(),
            "status": "streaming",
            "provider": model_spec.provider,
            "model": model_spec.public_id,
        }

        yield {
            "type": "meta",
            "conversationId": str(conversation.id),
            "conversationTitle": conversation.title,
            "provider": model_spec.provider,
            "model": model_spec.public_id,
            "thinkingEnabled": effective_thinking_enabled,
            "userMessage": serialize_message(user_message).model_dump(by_alias=True, mode="json"),
            "assistantMessage": assistant_message_event,
        }

        accumulated_text = ""
        accumulated_reasoning = ""
        collected_llm_events: list[dict] = []
        final_provider_metadata: dict = {"thinkingEnabled": effective_thinking_enabled}
        final_raw_response: dict | None = None
        final_provider_message_id: str | None = None
        final_request_id: str | None = None
        final_finish_reason: str | None = None
        final_usage_input = 0
        final_usage_output = 0
        final_usage_total = 0
        final_cost_usd = Decimal("0")
        final_tool_calls: list[dict] = []

        try:
            async for event in llm_service.stream(
                LLMRequest(
                    provider=model_spec.provider,
                    model=model_spec.public_id,
                    messages=history,
                    thinking_enabled=effective_thinking_enabled,
                    conversation_id=conversation.id,
                    message_id=user_message.id,
                )
            ):
                collected_llm_events.append(_llm_event_record(event))

                if event.event_type == "reasoning.delta":
                    delta = str(event.payload.get("delta") or "")
                    if delta:
                        accumulated_reasoning += delta
                        yield {
                            "type": "reasoning",
                            "assistantMessageId": assistant_stream_id,
                            "reasoning": {
                                "text": accumulated_reasoning,
                                "status": "streaming",
                            },
                        }
                    continue

                if event.event_type == "text.delta":
                    delta = str(event.payload.get("delta") or "")
                    if delta:
                        accumulated_text += delta
                        yield {
                            "type": "delta",
                            "assistantMessageId": assistant_stream_id,
                            "delta": delta,
                        }
                    continue

                if event.event_type == "response.completed":
                    payload_data = event.payload
                    final_provider_message_id = payload_data.get("provider_message_id")
                    final_request_id = payload_data.get("request_id")
                    final_finish_reason = payload_data.get("finish_reason")
                    final_provider_metadata.update(payload_data.get("provider_metadata") or {})
                    final_raw_response = payload_data.get("raw_response")
                    final_tool_calls = payload_data.get("tool_calls") or []
                    usage = payload_data.get("usage") or {}
                    final_usage_input = int(usage.get("input_tokens", 0) or 0)
                    final_usage_output = int(usage.get("output_tokens", 0) or 0)
                    final_usage_total = int(usage.get("total_tokens", 0) or 0)
                    final_cost_usd = _decimal_from_payload(usage.get("cost_usd"))
                    continue
        except Exception as exc:
            yield {
                "type": "error",
                "assistantMessageId": assistant_stream_id,
                "message": str(exc),
            }
            await session.rollback()
            return

        if accumulated_reasoning:
            final_provider_metadata["reasoning"] = accumulated_reasoning

        assistant_message = await persist_message(
            session,
            conversation=conversation,
            actor_user_id=user.id,
            payload=MessageCreateRequest(
                role="assistant",
                status="completed",
                content_text=accumulated_text,
                provider=model_spec.provider,
                model=model_spec.public_id,
                provider_message_id=final_provider_message_id,
                request_id=final_request_id,
                input_tokens=final_usage_input,
                output_tokens=final_usage_output,
                total_tokens=final_usage_total,
                cost_usd=final_cost_usd,
                stop_reason=final_finish_reason,
                provider_metadata=final_provider_metadata,
                raw_response=final_raw_response,
                tool_calls=[
                    {
                        "toolCallId": item.get("tool_call_id"),
                        "toolName": item.get("tool_name"),
                        "status": "completed",
                        "argumentsJson": item.get("arguments_json") or {},
                        "providerMetadata": item.get("provider_metadata") or {},
                    }
                    for item in final_tool_calls
                ],
                llm_events=collected_llm_events,
            ),
            commit=False,
        )
        await session.commit()

        yield {
            "type": "done",
            "assistantMessageId": assistant_stream_id,
            "persistedAssistantMessageId": str(assistant_message.id),
        }
