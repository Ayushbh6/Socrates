from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.llm.base import LLMProviderError, LLMStructuredOutputError, ModelResolutionError
from app.schemas.conversation import (
    ConversationDetailEnvelope,
    ConversationListEnvelope,
    ConversationMutationEnvelope,
    ConversationUpdateRequest,
    CreateConversationRequest,
)
from app.schemas.message import ChatTurnEnvelope, ChatTurnRequest, MessageEnvelope, MessageListEnvelope
from app.schemas.serializers import (
    serialize_conversation_detail,
    serialize_conversation_summary,
    serialize_message,
)
from app.services.chat import send_chat_message
from app.services.conversations import (
    create_conversation,
    get_conversation_detail,
    list_conversations,
    update_conversation,
)
from app.services.messages import list_messages


router = APIRouter()


@router.get("", response_model=ConversationListEnvelope)
async def get_conversations(
    session: AsyncSession = Depends(get_db_session),
) -> ConversationListEnvelope:
    conversations = await list_conversations(session)
    return ConversationListEnvelope(
        conversations=[serialize_conversation_summary(item) for item in conversations]
    )


@router.post(
    "",
    response_model=ConversationMutationEnvelope,
    status_code=status.HTTP_201_CREATED,
)
async def post_conversation(
    payload: CreateConversationRequest,
    session: AsyncSession = Depends(get_db_session),
) -> ConversationMutationEnvelope:
    conversation = await create_conversation(session, payload)
    return ConversationMutationEnvelope(
        conversation=serialize_conversation_detail(conversation)
    )


@router.get("/{conversation_id}", response_model=ConversationDetailEnvelope)
async def get_conversation(
    conversation_id: UUID,
    session: AsyncSession = Depends(get_db_session),
) -> ConversationDetailEnvelope:
    conversation = await get_conversation_detail(session, conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    return ConversationDetailEnvelope(
        conversation=serialize_conversation_detail(conversation)
    )


@router.patch("/{conversation_id}", response_model=ConversationMutationEnvelope)
async def patch_conversation(
    conversation_id: UUID,
    payload: ConversationUpdateRequest,
    session: AsyncSession = Depends(get_db_session),
) -> ConversationMutationEnvelope:
    conversation = await update_conversation(session, conversation_id, payload)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    return ConversationMutationEnvelope(
        conversation=serialize_conversation_detail(conversation)
    )


@router.get("/{conversation_id}/messages", response_model=MessageListEnvelope)
async def get_conversation_messages(
    conversation_id: UUID,
    session: AsyncSession = Depends(get_db_session),
) -> MessageListEnvelope:
    messages = await list_messages(session, conversation_id)
    if messages is None:
        raise HTTPException(status_code=404, detail="Conversation not found.")

    return MessageListEnvelope(messages=[serialize_message(item) for item in messages])


@router.post(
    "/{conversation_id}/messages",
    response_model=ChatTurnEnvelope,
    status_code=status.HTTP_201_CREATED,
)
async def post_conversation_message(
    conversation_id: UUID,
    payload: ChatTurnRequest,
    session: AsyncSession = Depends(get_db_session),
) -> ChatTurnEnvelope:
    try:
        result = await send_chat_message(session, conversation_id, payload)
    except ValueError as exc:
        if str(exc) == "Conversation not found.":
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (ModelResolutionError, LLMStructuredOutputError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LLMProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return ChatTurnEnvelope(
        conversation=result.conversation_response.model_dump(by_alias=True),
        user_message=serialize_message(result.user_message),
        assistant_message=serialize_message(result.assistant_message),
    )
