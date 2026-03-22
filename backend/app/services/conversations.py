from uuid import UUID

from app.core.constants import DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_THINKING_ENABLED
from app.db.models.base import utc_now
from app.db.models.conversation import Conversation
from app.llm.registry import ModelRegistry
from app.repositories.conversations import (
    create_conversation_record,
    get_conversation_for_user,
    list_conversations_for_user,
)
from app.schemas.conversation import ConversationUpdateRequest, CreateConversationRequest
from app.services.users import get_dev_user
from sqlalchemy.ext.asyncio import AsyncSession


def _resolve_conversation_defaults(
    *,
    provider: str | None,
    model: str | None,
    thinking_enabled: bool | None,
    current_provider: str | None = None,
    current_model: str | None = None,
    current_thinking_enabled: bool | None = None,
) -> tuple[str, str, bool]:
    registry = ModelRegistry()

    if model is not None:
        resolved = registry.resolve(model, provider)
        effective_provider = resolved.provider
        effective_model = resolved.public_id
    else:
        effective_model = current_model or DEFAULT_MODEL
        effective_provider = provider or current_provider or DEFAULT_PROVIDER
        resolved = registry.resolve(effective_model, effective_provider)

    return (
        effective_provider,
        effective_model,
        (
            current_thinking_enabled
            if thinking_enabled is None and current_thinking_enabled is not None
            else (thinking_enabled if thinking_enabled is not None else DEFAULT_THINKING_ENABLED)
        ),
    )


async def list_conversations(session: AsyncSession) -> list[Conversation]:
    user = await get_dev_user(session)
    return await list_conversations_for_user(session, user.id)


async def create_conversation(
    session: AsyncSession,
    payload: CreateConversationRequest,
) -> Conversation:
    user = await get_dev_user(session)
    title = payload.title.strip() if payload.title else "New conversation"
    provider, model, thinking_enabled = _resolve_conversation_defaults(
        provider=payload.provider,
        model=payload.model,
        thinking_enabled=payload.thinking_enabled,
    )

    conversation = await create_conversation_record(
        session,
        user_id=user.id,
        title=title or "New conversation",
        metadata=payload.metadata,
        default_provider=provider,
        default_model=model,
        thinking_enabled=thinking_enabled,
    )
    await session.commit()
    created = await get_conversation_for_user(session, conversation.id, user.id)
    if created is None:
        raise RuntimeError("Created conversation could not be reloaded.")
    return created


async def get_conversation_detail(
    session: AsyncSession,
    conversation_id: UUID,
) -> Conversation | None:
    user = await get_dev_user(session)
    return await get_conversation_for_user(session, conversation_id, user.id)


async def update_conversation(
    session: AsyncSession,
    conversation_id: UUID,
    payload: ConversationUpdateRequest,
) -> Conversation | None:
    user = await get_dev_user(session)
    conversation = await get_conversation_for_user(
        session,
        conversation_id,
        user.id,
        include_messages=False,
        for_update=True,
    )
    if conversation is None:
        return None

    updated = False

    if payload.title is not None:
        title = payload.title.strip() or "New conversation"
        if title != conversation.title:
            conversation.title = title
            conversation.updated_at = utc_now()
            updated = True

    if payload.status is not None and payload.status != conversation.status:
        conversation.status = payload.status
        if payload.status == "deleted":
            conversation.deleted_at = utc_now()
        else:
            conversation.deleted_at = None
        conversation.updated_at = utc_now()
        updated = True

    if (
        payload.provider is not None
        or payload.model is not None
        or payload.thinking_enabled is not None
    ):
        provider, model, thinking_enabled = _resolve_conversation_defaults(
            provider=payload.provider,
            model=payload.model,
            thinking_enabled=payload.thinking_enabled,
            current_provider=conversation.default_provider,
            current_model=conversation.default_model,
            current_thinking_enabled=conversation.thinking_enabled,
        )
        if provider != conversation.default_provider:
            conversation.default_provider = provider
            updated = True
        if model != conversation.default_model:
            conversation.default_model = model
            updated = True
        if thinking_enabled != conversation.thinking_enabled:
            conversation.thinking_enabled = thinking_enabled
            updated = True
        if updated:
            conversation.updated_at = utc_now()

    if updated:
        await session.commit()

    return await get_conversation_for_user(
        session,
        conversation_id,
        user.id,
        include_deleted=True,
    )
