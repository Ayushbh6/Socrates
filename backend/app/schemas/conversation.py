from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import Field, field_validator

from app.schemas.base import APIModel
from app.schemas.message import MessageResponse


class CreateConversationRequest(APIModel):
    title: str | None = None
    metadata: dict = Field(default_factory=dict)
    provider: str | None = None
    model: str | None = None
    thinking_enabled: bool = False


class ConversationUpdateRequest(APIModel):
    title: str | None = None
    status: str | None = None
    provider: str | None = None
    model: str | None = None
    thinking_enabled: bool | None = None

    @field_validator("status")
    @classmethod
    def validate_status(cls, value: str | None) -> str | None:
        if value is None:
            return value
        allowed = {"active", "archived", "deleted"}
        if value not in allowed:
            raise ValueError(f"status must be one of: {', '.join(sorted(allowed))}")
        return value


class ConversationSummaryResponse(APIModel):
    id: UUID
    user_id: UUID
    title: str
    status: str
    provider: str
    model: str
    thinking_enabled: bool
    preview: str
    message_count: int
    input_tokens: int
    output_tokens: int
    total_tokens: int
    total_cost_usd: Decimal
    last_message_at: datetime | None
    metadata: dict
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


class ConversationDetailResponse(ConversationSummaryResponse):
    messages: list[MessageResponse]


class ConversationListEnvelope(APIModel):
    conversations: list[ConversationSummaryResponse]


class ConversationDetailEnvelope(APIModel):
    conversation: ConversationDetailResponse


class ConversationMutationEnvelope(APIModel):
    conversation: ConversationDetailResponse
