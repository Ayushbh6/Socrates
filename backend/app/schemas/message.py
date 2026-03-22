from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import Field, field_validator

from app.schemas.base import APIModel


class AttachmentPayload(APIModel):
    attachment_type: str = "image"
    mime_type: str
    storage_provider: str | None = None
    storage_path: str | None = None
    source_url: str | None = None
    filename: str | None = None
    size_bytes: int | None = None
    width: int | None = None
    height: int | None = None
    sha256: str | None = None
    metadata: dict = Field(default_factory=dict)

    @field_validator("attachment_type")
    @classmethod
    def validate_attachment_type(cls, value: str) -> str:
        if value != "image":
            raise ValueError("attachmentType must currently be 'image'")
        return value


class ToolCallPayload(APIModel):
    tool_call_id: str | None = None
    tool_name: str
    status: str = "completed"
    arguments_json: dict = Field(default_factory=dict)
    result_json: dict | None = None
    error_text: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    latency_ms: int | None = None
    provider_metadata: dict = Field(default_factory=dict)

    @field_validator("status")
    @classmethod
    def validate_tool_call_status(cls, value: str) -> str:
        allowed = {"pending", "running", "completed", "failed", "cancelled"}
        if value not in allowed:
            raise ValueError(f"status must be one of: {', '.join(sorted(allowed))}")
        return value


class LlmEventPayload(APIModel):
    provider: str
    model: str | None = None
    event_type: str
    event_index: int
    event_time: datetime | None = None
    is_terminal: bool = False
    input_tokens: int | None = None
    output_tokens: int | None = None
    latency_ms: int | None = None
    payload: dict


class MessageCreateRequest(APIModel):
    role: str
    status: str = "completed"
    content_text: str | None = None
    parent_message_id: UUID | None = None
    provider: str | None = None
    model: str | None = None
    provider_message_id: str | None = None
    request_id: str | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost_usd: Decimal = Decimal("0")
    latency_ms: int | None = None
    stop_reason: str | None = None
    provider_metadata: dict = Field(default_factory=dict)
    raw_response: dict | None = None
    attachments: list[AttachmentPayload] = Field(default_factory=list)
    tool_calls: list[ToolCallPayload] = Field(default_factory=list)
    llm_events: list[LlmEventPayload] = Field(default_factory=list)

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        allowed = {"system", "user", "assistant", "tool"}
        if value not in allowed:
            raise ValueError(f"role must be one of: {', '.join(sorted(allowed))}")
        return value

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: str) -> str:
        allowed = {"pending", "streaming", "completed", "failed", "cancelled"}
        if value not in allowed:
            raise ValueError(f"status must be one of: {', '.join(sorted(allowed))}")
        return value


class AttachmentResponse(APIModel):
    id: UUID
    attachment_type: str
    mime_type: str
    storage_provider: str | None
    storage_path: str | None
    source_url: str | None
    filename: str | None
    size_bytes: int | None
    width: int | None
    height: int | None
    sha256: str | None
    metadata: dict
    created_at: datetime


class ToolCallResponse(APIModel):
    id: UUID
    tool_call_id: str | None
    tool_name: str
    status: str
    arguments_json: dict
    result_json: dict | None
    error_text: str | None
    started_at: datetime | None
    completed_at: datetime | None
    latency_ms: int | None
    provider_metadata: dict
    created_at: datetime
    updated_at: datetime


class LlmEventResponse(APIModel):
    id: UUID
    provider: str
    model: str | None
    event_type: str
    event_index: int
    event_time: datetime
    is_terminal: bool
    input_tokens: int | None
    output_tokens: int | None
    latency_ms: int | None
    payload: dict
    created_at: datetime


class MessageResponse(APIModel):
    id: UUID
    conversation_id: UUID
    user_id: UUID | None
    parent_message_id: UUID | None
    sequence_number: int
    role: str
    status: str
    content_text: str | None
    provider: str | None
    model: str | None
    provider_message_id: str | None
    request_id: str | None
    input_tokens: int
    output_tokens: int
    total_tokens: int
    cost_usd: Decimal
    latency_ms: int | None
    stop_reason: str | None
    provider_metadata: dict
    reasoning: dict | None = None
    raw_response: dict | None
    attachments: list[AttachmentResponse]
    tool_calls: list[ToolCallResponse]
    llm_events: list[LlmEventResponse]
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


class MessageEnvelope(APIModel):
    message: MessageResponse


class MessageListEnvelope(APIModel):
    messages: list[MessageResponse]


class ChatTurnRequest(APIModel):
    content: str
    provider: str | None = None
    model: str | None = None
    thinking_enabled: bool | None = None


class ChatTurnEnvelope(APIModel):
    conversation: dict
    user_message: MessageResponse
    assistant_message: MessageResponse
