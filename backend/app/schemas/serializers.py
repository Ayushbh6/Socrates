from app.db.models.conversation import Conversation
from app.db.models.llm_event import LlmEvent
from app.db.models.message import Message
from app.db.models.message_attachment import MessageAttachment
from app.db.models.message_tool_call import MessageToolCall
from app.db.models.user import User
from app.schemas.conversation import ConversationDetailResponse, ConversationSummaryResponse
from app.schemas.message import (
    AttachmentResponse,
    LlmEventResponse,
    MessageResponse,
    ToolCallResponse,
)
from app.schemas.user import UserResponse


def _truncate_preview(text: str, length: int = 72) -> str:
    normalized = " ".join(text.split()).strip()
    if not normalized:
        return "New conversation"
    if len(normalized) <= length:
        return normalized
    return normalized[: length - 1].rstrip() + "…"


def serialize_user(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        status=user.status,
        metadata=user.metadata_json,
        created_at=user.created_at,
        updated_at=user.updated_at,
        deleted_at=user.deleted_at,
    )


def serialize_attachment(attachment: MessageAttachment) -> AttachmentResponse:
    return AttachmentResponse(
        id=attachment.id,
        attachment_type=attachment.attachment_type,
        mime_type=attachment.mime_type,
        storage_provider=attachment.storage_provider,
        storage_path=attachment.storage_path,
        source_url=attachment.source_url,
        filename=attachment.filename,
        size_bytes=attachment.size_bytes,
        width=attachment.width,
        height=attachment.height,
        sha256=attachment.sha256,
        metadata=attachment.metadata_json,
        created_at=attachment.created_at,
    )


def serialize_tool_call(tool_call: MessageToolCall) -> ToolCallResponse:
    return ToolCallResponse(
        id=tool_call.id,
        tool_call_id=tool_call.tool_call_id,
        tool_name=tool_call.tool_name,
        status=tool_call.status,
        arguments_json=tool_call.arguments_json,
        result_json=tool_call.result_json,
        error_text=tool_call.error_text,
        started_at=tool_call.started_at,
        completed_at=tool_call.completed_at,
        latency_ms=tool_call.latency_ms,
        provider_metadata=tool_call.provider_metadata,
        created_at=tool_call.created_at,
        updated_at=tool_call.updated_at,
    )


def serialize_llm_event(event: LlmEvent) -> LlmEventResponse:
    return LlmEventResponse(
        id=event.id,
        provider=event.provider,
        model=event.model,
        event_type=event.event_type,
        event_index=event.event_index,
        event_time=event.event_time,
        is_terminal=event.is_terminal,
        input_tokens=event.input_tokens,
        output_tokens=event.output_tokens,
        latency_ms=event.latency_ms,
        payload=event.payload,
        created_at=event.created_at,
    )


def serialize_message(message: Message) -> MessageResponse:
    reasoning_value = message.provider_metadata.get("reasoning")
    reasoning_details = message.provider_metadata.get("reasoningDetails")
    reasoning: dict | None = None
    if reasoning_value is not None or reasoning_details is not None:
        reasoning = {
            "text": reasoning_value,
            "details": reasoning_details,
        }

    return MessageResponse(
        id=message.id,
        conversation_id=message.conversation_id,
        user_id=message.user_id,
        parent_message_id=message.parent_message_id,
        sequence_number=message.sequence_number,
        role=message.role,
        status=message.status,
        content_text=message.content_text,
        provider=message.provider,
        model=message.model,
        provider_message_id=message.provider_message_id,
        request_id=message.request_id,
        input_tokens=message.input_tokens,
        output_tokens=message.output_tokens,
        total_tokens=message.total_tokens,
        cost_usd=message.cost_usd,
        latency_ms=message.latency_ms,
        stop_reason=message.stop_reason,
        provider_metadata=message.provider_metadata,
        reasoning=reasoning,
        raw_response=message.raw_response,
        attachments=[serialize_attachment(item) for item in message.attachments],
        tool_calls=[serialize_tool_call(item) for item in message.tool_calls],
        llm_events=[serialize_llm_event(item) for item in message.llm_events],
        created_at=message.created_at,
        updated_at=message.updated_at,
        deleted_at=message.deleted_at,
    )


def serialize_conversation_summary(conversation: Conversation) -> ConversationSummaryResponse:
    preview = "New conversation"
    if conversation.messages:
        last_message = conversation.messages[-1]
        preview = _truncate_preview(last_message.content_text or "")

    return ConversationSummaryResponse(
        id=conversation.id,
        user_id=conversation.user_id,
        title=conversation.title,
        status=conversation.status,
        provider=conversation.default_provider,
        model=conversation.default_model,
        thinking_enabled=conversation.thinking_enabled,
        preview=preview,
        message_count=conversation.message_count,
        input_tokens=conversation.input_tokens,
        output_tokens=conversation.output_tokens,
        total_tokens=conversation.total_tokens,
        total_cost_usd=conversation.total_cost_usd,
        last_message_at=conversation.last_message_at,
        metadata=conversation.metadata_json,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        deleted_at=conversation.deleted_at,
    )


def serialize_conversation_detail(conversation: Conversation) -> ConversationDetailResponse:
    summary = serialize_conversation_summary(conversation)
    return ConversationDetailResponse(
        **summary.model_dump(),
        messages=[serialize_message(item) for item in conversation.messages],
    )


def serialize_conversation_detail_with_messages(
    conversation: Conversation,
    messages: list[Message],
) -> ConversationDetailResponse:
    summary = serialize_conversation_summary(conversation)
    return ConversationDetailResponse(
        **summary.model_dump(),
        messages=[serialize_message(item) for item in messages],
    )
