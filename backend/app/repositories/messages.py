from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models.llm_event import LlmEvent
from app.db.models.message import Message
from app.db.models.message_attachment import MessageAttachment
from app.db.models.message_tool_call import MessageToolCall


async def list_messages_for_conversation(
    session: AsyncSession,
    conversation_id: UUID,
) -> list[Message]:
    result = await session.execute(
        select(Message)
        .where(
            Message.conversation_id == conversation_id,
            Message.deleted_at.is_(None),
        )
        .options(
            selectinload(Message.attachments),
            selectinload(Message.tool_calls),
            selectinload(Message.llm_events),
        )
        .order_by(Message.sequence_number.asc())
    )
    return list(result.scalars().unique().all())


async def get_next_sequence_number(
    session: AsyncSession,
    conversation_id: UUID,
) -> int:
    result = await session.execute(
        select(func.coalesce(func.max(Message.sequence_number), 0) + 1).where(
            Message.conversation_id == conversation_id
        )
    )
    return int(result.scalar_one())


async def create_message_record(
    session: AsyncSession,
    *,
    conversation_id: UUID,
    user_id: UUID | None,
    parent_message_id: UUID | None,
    sequence_number: int,
    role: str,
    status: str,
    content_text: str | None,
    provider: str | None,
    model: str | None,
    provider_message_id: str | None,
    request_id: str | None,
    input_tokens: int,
    output_tokens: int,
    total_tokens: int,
    cost_usd,
    latency_ms: int | None,
    stop_reason: str | None,
    provider_metadata: dict,
    raw_response: dict | None,
) -> Message:
    message = Message(
        conversation_id=conversation_id,
        user_id=user_id,
        parent_message_id=parent_message_id,
        sequence_number=sequence_number,
        role=role,
        status=status,
        content_text=content_text,
        provider=provider,
        model=model,
        provider_message_id=provider_message_id,
        request_id=request_id,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        cost_usd=cost_usd,
        latency_ms=latency_ms,
        stop_reason=stop_reason,
        provider_metadata=provider_metadata,
        raw_response=raw_response,
    )
    session.add(message)
    await session.flush()
    return message


def build_attachment_records(message_id: UUID, attachments: list[dict]) -> list[MessageAttachment]:
    return [MessageAttachment(message_id=message_id, **attachment) for attachment in attachments]


def build_tool_call_records(message_id: UUID, tool_calls: list[dict]) -> list[MessageToolCall]:
    return [MessageToolCall(message_id=message_id, **tool_call) for tool_call in tool_calls]


def build_llm_event_records(message_id: UUID, llm_events: list[dict]) -> list[LlmEvent]:
    return [LlmEvent(message_id=message_id, **event) for event in llm_events]
