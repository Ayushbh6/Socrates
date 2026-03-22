from decimal import Decimal
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.base import utc_now
from app.db.models.conversation import Conversation
from app.db.models.message import Message
from app.repositories.conversations import get_conversation_for_user
from app.repositories.messages import (
    build_attachment_records,
    build_llm_event_records,
    build_tool_call_records,
    create_message_record,
    get_next_sequence_number,
    list_messages_for_conversation,
)
from app.schemas.message import MessageCreateRequest
from app.services.users import get_dev_user


async def list_messages(session: AsyncSession, conversation_id: UUID):
    user = await get_dev_user(session)
    conversation = await get_conversation_for_user(
        session,
        conversation_id,
        user.id,
        include_messages=False,
    )
    if conversation is None:
        return None

    return await list_messages_for_conversation(session, conversation_id)


async def create_message(
    session: AsyncSession,
    conversation_id: UUID,
    payload: MessageCreateRequest,
) -> Message:
    user = await get_dev_user(session)
    conversation = await get_conversation_for_user(
        session,
        conversation_id,
        user.id,
        include_messages=False,
        for_update=True,
    )
    if conversation is None:
        raise ValueError("Conversation not found.")

    if conversation.status == "deleted" or conversation.deleted_at is not None:
        raise ValueError("Cannot add messages to a deleted conversation.")

    message = await persist_message(
        session,
        conversation=conversation,
        actor_user_id=user.id,
        payload=payload,
        commit=False,
    )

    await session.commit()

    messages = await list_messages_for_conversation(session, conversation_id)
    return next(item for item in messages if item.id == message.id)


async def persist_message(
    session: AsyncSession,
    *,
    conversation: Conversation,
    actor_user_id: UUID,
    payload: MessageCreateRequest,
    commit: bool = False,
) -> Message:
    sequence_number = await get_next_sequence_number(session, conversation.id)
    effective_user_id = actor_user_id if payload.role == "user" else None

    message = await create_message_record(
        session,
        conversation_id=conversation.id,
        user_id=effective_user_id,
        parent_message_id=payload.parent_message_id,
        sequence_number=sequence_number,
        role=payload.role,
        status=payload.status,
        content_text=payload.content_text,
        provider=payload.provider,
        model=payload.model,
        provider_message_id=payload.provider_message_id,
        request_id=payload.request_id,
        input_tokens=payload.input_tokens,
        output_tokens=payload.output_tokens,
        total_tokens=payload.total_tokens,
        cost_usd=payload.cost_usd,
        latency_ms=payload.latency_ms,
        stop_reason=payload.stop_reason,
        provider_metadata=payload.provider_metadata,
        raw_response=payload.raw_response,
    )

    attachment_records = build_attachment_records(
        message.id,
        [
            {
                "attachment_type": item.attachment_type,
                "mime_type": item.mime_type,
                "storage_provider": item.storage_provider,
                "storage_path": item.storage_path,
                "source_url": item.source_url,
                "filename": item.filename,
                "size_bytes": item.size_bytes,
                "width": item.width,
                "height": item.height,
                "sha256": item.sha256,
                "metadata_json": item.metadata,
            }
            for item in payload.attachments
        ],
    )
    tool_call_records = build_tool_call_records(
        message.id,
        [
            {
                "tool_call_id": item.tool_call_id,
                "tool_name": item.tool_name,
                "status": item.status,
                "arguments_json": item.arguments_json,
                "result_json": item.result_json,
                "error_text": item.error_text,
                "started_at": item.started_at,
                "completed_at": item.completed_at,
                "latency_ms": item.latency_ms,
                "provider_metadata": item.provider_metadata,
            }
            for item in payload.tool_calls
        ],
    )
    llm_event_records = build_llm_event_records(
        message.id,
        [
            {
                "provider": item.provider,
                "model": item.model,
                "event_type": item.event_type,
                "event_index": item.event_index,
                "event_time": item.event_time or utc_now(),
                "is_terminal": item.is_terminal,
                "input_tokens": item.input_tokens,
                "output_tokens": item.output_tokens,
                "latency_ms": item.latency_ms,
                "payload": item.payload,
            }
            for item in payload.llm_events
        ],
    )

    session.add_all(attachment_records)
    session.add_all(tool_call_records)
    session.add_all(llm_event_records)

    conversation.message_count += 1
    conversation.input_tokens += payload.input_tokens
    conversation.output_tokens += payload.output_tokens
    conversation.total_tokens += payload.total_tokens
    conversation.total_cost_usd = Decimal(conversation.total_cost_usd) + payload.cost_usd
    conversation.last_message_at = message.created_at
    conversation.updated_at = utc_now()

    if commit:
        await session.commit()

    return message
