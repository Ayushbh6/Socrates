from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID


MessageRole = Literal["system", "user", "assistant", "tool"]
ResponseMode = Literal["text", "structured"]
ContentType = Literal["text", "image"]


@dataclass(slots=True)
class TextContentPart:
    type: Literal["text"] = "text"
    text: str = ""


@dataclass(slots=True)
class ImageContentPart:
    type: Literal["image"] = "image"
    image_url: str | None = None
    mime_type: str | None = None
    storage_path: str | None = None
    source_bytes_ref: str | None = None
    detail: Literal["low", "high", "auto"] | None = None


ContentPart = TextContentPart | ImageContentPart


@dataclass(slots=True)
class LLMInputMessage:
    role: MessageRole
    content: list[ContentPart]
    tool_call_id: str | None = None
    tool_name: str | None = None
    provider_metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: dict[str, Any]
    strict: bool = True


@dataclass(slots=True)
class StructuredOutputSchema:
    name: str
    schema: dict[str, Any]
    description: str | None = None
    strict: bool = True


@dataclass(slots=True)
class UsageInfo:
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cost_usd: Decimal = Decimal("0")


@dataclass(slots=True)
class ToolCallRequest:
    tool_call_id: str
    tool_name: str
    arguments_json: dict[str, Any]
    provider_metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class LLMRequest:
    model: str
    messages: list[LLMInputMessage]
    provider: str | None = None
    system_prompt: str | None = None
    tools: list[ToolDefinition] = field(default_factory=list)
    tool_choice: str | dict[str, Any] | None = None
    temperature: float | None = None
    max_output_tokens: int | None = None
    stream: bool = False
    thinking_enabled: bool = False
    response_mode: ResponseMode = "text"
    output_schema: StructuredOutputSchema | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    conversation_id: UUID | None = None
    message_id: UUID | None = None


@dataclass(slots=True)
class LLMResponse:
    provider: str
    model: str
    provider_message_id: str | None
    request_id: str | None
    output_text: str
    structured_output: dict[str, Any] | list[Any] | None
    structured_output_raw: Any = None
    structured_output_valid: bool | None = None
    structured_output_error: str | None = None
    finish_reason: str | None = None
    usage: UsageInfo = field(default_factory=UsageInfo)
    tool_calls: list[ToolCallRequest] = field(default_factory=list)
    provider_metadata: dict[str, Any] = field(default_factory=dict)
    raw_response: dict[str, Any] | None = None


@dataclass(slots=True)
class ModelPricing:
    input_per_million_usd: Decimal | None = None
    output_per_million_usd: Decimal | None = None


@dataclass(slots=True)
class ModelSpec:
    public_id: str
    provider: str
    upstream_model_id: str
    display_name: str
    supports_streaming: bool = True
    supports_tools: bool = True
    supports_images: bool = True
    supports_structured_output: bool = True
    supports_strict_schema: bool = True
    supports_thinking: bool = False
    supports_reasoning_continuity: bool = False
    reasoning_cannot_be_disabled: bool = False
    pricing: ModelPricing = field(default_factory=ModelPricing)


@dataclass(slots=True)
class LLMEvent:
    event_type: str
    event_index: int
    provider: str
    model: str
    message_id: UUID | None
    payload: dict[str, Any]
    input_tokens: int | None = None
    output_tokens: int | None = None
    latency_ms: int | None = None
