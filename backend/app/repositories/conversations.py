from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.models.conversation import Conversation
from app.db.models.message import Message


async def list_conversations_for_user(
    session: AsyncSession,
    user_id: UUID,
) -> list[Conversation]:
    result = await session.execute(
        select(Conversation)
        .where(
            Conversation.user_id == user_id,
            Conversation.deleted_at.is_(None),
            Conversation.status != "deleted",
        )
        .options(selectinload(Conversation.messages))
        .order_by(Conversation.updated_at.desc())
    )
    return list(result.scalars().unique().all())


async def create_conversation_record(
    session: AsyncSession,
    *,
    user_id: UUID,
    title: str,
    metadata: dict,
    default_provider: str,
    default_model: str,
    thinking_enabled: bool,
) -> Conversation:
    conversation = Conversation(
        user_id=user_id,
        title=title,
        metadata_json=metadata,
        default_provider=default_provider,
        default_model=default_model,
        thinking_enabled=thinking_enabled,
    )
    session.add(conversation)
    await session.flush()
    await session.refresh(conversation)
    return conversation


async def get_conversation_for_user(
    session: AsyncSession,
    conversation_id: UUID,
    user_id: UUID,
    *,
    include_messages: bool = True,
    for_update: bool = False,
    include_deleted: bool = False,
) -> Conversation | None:
    conditions = [
        Conversation.id == conversation_id,
        Conversation.user_id == user_id,
    ]

    if not include_deleted:
        conditions.extend(
            [
                Conversation.deleted_at.is_(None),
                Conversation.status != "deleted",
            ]
        )

    query = select(Conversation).where(*conditions)

    if include_messages:
        query = query.options(
            selectinload(Conversation.messages)
            .selectinload(Message.attachments),
            selectinload(Conversation.messages)
            .selectinload(Message.tool_calls),
            selectinload(Conversation.messages)
            .selectinload(Message.llm_events),
        )

    if for_update:
        query = query.with_for_update()

    result = await session.execute(query)
    return result.scalar_one_or_none()
