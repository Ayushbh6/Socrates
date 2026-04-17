from __future__ import annotations

import json
from collections.abc import Sequence
from collections.abc import AsyncIterator
from typing import Any

from app.llm.base import BaseLLMProvider, LLMProviderError
from app.llm.types import (
    ImageContentPart,
    LLMInputMessage,
    LLMRequest,
    LLMResponse,
    ModelSpec,
    TextContentPart,
    ToolCallRequest,
    UsageInfo,
)


class OpenAIProvider(BaseLLMProvider):
    provider_name = "openai"

    def __init__(
        self,
        *,
        api_key: str | None,
        client: Any | None = None,
        base_url: str | None = None,
    ):
        self._base_url = base_url
        self._api_key = api_key
        self._client = client

    @property
    def client(self) -> Any:
        if self._client is not None:
            return self._client

        if not self._api_key:
            raise LLMProviderError("OPENAI_API_KEY is not configured.")

        try:
            from openai import AsyncOpenAI
        except ImportError as exc:
            raise LLMProviderError(
                "The OpenAI SDK is not installed. Install backend dependencies first."
            ) from exc

        self._client = AsyncOpenAI(api_key=self._api_key, base_url=self._base_url)
        return self._client

    async def generate(self, request: LLMRequest, model_spec: ModelSpec) -> LLMResponse:
        payload = self._build_payload(request, model_spec)

        try:
            response = await self.client.responses.create(**payload)
        except Exception as exc:  # pragma: no cover - network/SDK failures
            raise LLMProviderError(f"OpenAI request failed: {exc}") from exc

        raw = self._to_raw_dict(response)
        output_text = self._extract_output_text(response, raw)
        structured_output, structured_output_raw = self._extract_structured_output(
            request,
            output_text,
            raw,
        )

        return LLMResponse(
            provider=self.provider_name,
            model=model_spec.public_id,
            provider_message_id=raw.get("id"),
            request_id=getattr(response, "_request_id", None) or raw.get("request_id"),
            output_text=output_text,
            structured_output=structured_output,
            structured_output_raw=structured_output_raw,
            structured_output_valid=None if request.response_mode == "structured" else False,
            finish_reason=self._extract_finish_reason(raw),
            usage=self._extract_usage(raw),
            tool_calls=self._extract_tool_calls(raw),
            provider_metadata=self._extract_provider_metadata(
                request=request,
                model_spec=model_spec,
                raw=raw,
            ),
            raw_response=raw,
        )

    async def stream(
        self,
        request: LLMRequest,
        model_spec: ModelSpec,
    ) -> AsyncIterator["LLMEvent"]:
        from app.llm.types import LLMEvent

        payload = self._build_chat_completion_payload(request, model_spec)
        payload["stream"] = True
        payload["stream_options"] = {"include_usage": True}

        event_index = 0
        provider_message_id: str | None = None
        finish_reason: str | None = None
        final_usage = UsageInfo()

        try:
            stream = await self.client.chat.completions.create(**payload)
        except Exception as exc:  # pragma: no cover - network/SDK failures
            raise LLMProviderError(f"OpenAI request failed: {exc}") from exc

        yield LLMEvent(
            event_type="response.started",
            event_index=event_index,
            provider=self.provider_name,
            model=model_spec.public_id,
            message_id=request.message_id,
            payload={},
        )
        event_index += 1

        async for chunk in stream:
            raw_chunk = self._chunk_to_dict(chunk)
            provider_message_id = raw_chunk.get("id") or provider_message_id
            choices = raw_chunk.get("choices", [])
            usage = raw_chunk.get("usage")
            if isinstance(usage, dict):
                final_usage = UsageInfo(
                    input_tokens=int(usage.get("prompt_tokens", 0) or 0),
                    output_tokens=int(usage.get("completion_tokens", 0) or 0),
                    total_tokens=int(usage.get("total_tokens", 0) or 0),
                )

            if not isinstance(choices, list):
                continue

            for choice in choices:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta", {})
                if not isinstance(delta, dict):
                    delta = {}

                content_delta = delta.get("content")
                if isinstance(content_delta, str) and content_delta:
                    yield LLMEvent(
                        event_type="text.delta",
                        event_index=event_index,
                        provider=self.provider_name,
                        model=model_spec.public_id,
                        message_id=request.message_id,
                        payload={"delta": content_delta},
                    )
                    event_index += 1

                if choice.get("finish_reason"):
                    finish_reason = str(choice.get("finish_reason"))

        yield LLMEvent(
            event_type="response.completed",
            event_index=event_index,
            provider=self.provider_name,
            model=model_spec.public_id,
            message_id=request.message_id,
            payload={
                "provider_message_id": provider_message_id,
                "request_id": None,
                "finish_reason": finish_reason,
                "provider_metadata": {
                    "upstreamModel": model_spec.upstream_model_id,
                    "thinkingEnabled": request.thinking_enabled,
                },
                "raw_response": {
                    "provider": "openai",
                    "streamed": True,
                    "provider_message_id": provider_message_id,
                },
                "tool_calls": [],
                "usage": {
                    "input_tokens": final_usage.input_tokens,
                    "output_tokens": final_usage.output_tokens,
                    "total_tokens": final_usage.total_tokens,
                    "cost_usd": "0",
                },
            },
            input_tokens=final_usage.input_tokens,
            output_tokens=final_usage.output_tokens,
        )

    def _build_payload(self, request: LLMRequest, model_spec: ModelSpec) -> dict[str, Any]:
        messages: list[LLMInputMessage] = list(request.messages)
        if request.system_prompt:
            messages = [
                LLMInputMessage(
                    role="system",
                    content=[TextContentPart(text=request.system_prompt)],
                ),
                *messages,
            ]

        payload: dict[str, Any] = {
            "model": model_spec.upstream_model_id,
            "input": [self._serialize_message(message) for message in messages],
        }

        if request.temperature is not None:
            payload["temperature"] = request.temperature

        if request.max_output_tokens is not None:
            payload["max_output_tokens"] = request.max_output_tokens

        if model_spec.supports_thinking:
            payload["reasoning"] = {
                "effort": "medium" if request.thinking_enabled else "none"
            }

        if request.tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                    "strict": tool.strict,
                }
                for tool in request.tools
            ]

        if request.tool_choice is not None:
            payload["tool_choice"] = request.tool_choice

        if request.response_mode == "structured" and request.output_schema is not None:
            payload["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": request.output_schema.name,
                    "description": request.output_schema.description,
                    "schema": request.output_schema.schema,
                    "strict": request.output_schema.strict,
                }
            }

        return payload

    def _build_chat_completion_payload(
        self,
        request: LLMRequest,
        model_spec: ModelSpec,
    ) -> dict[str, Any]:
        messages = list(request.messages)
        if request.system_prompt:
            messages = [
                LLMInputMessage(
                    role="system",
                    content=[TextContentPart(text=request.system_prompt)],
                ),
                *messages,
            ]

        payload: dict[str, Any] = {
            "model": model_spec.upstream_model_id,
            "messages": [
                self._serialize_chat_completion_message(message) for message in messages
            ],
        }

        if request.temperature is not None:
            payload["temperature"] = request.temperature

        if request.max_output_tokens is not None:
            payload["max_completion_tokens"] = request.max_output_tokens

        if model_spec.supports_thinking:
            payload["reasoning_effort"] = "medium" if request.thinking_enabled else "none"

        return payload

    def _serialize_chat_completion_message(self, message: LLMInputMessage) -> dict[str, Any]:
        text_parts = [part.text for part in message.content if isinstance(part, TextContentPart)]
        if all(isinstance(part, TextContentPart) for part in message.content):
            serialized: dict[str, Any] = {
                "role": message.role,
                "content": "".join(text_parts),
            }
            if message.tool_name:
                serialized["name"] = message.tool_name
            if message.tool_call_id:
                serialized["tool_call_id"] = message.tool_call_id
            return serialized

        content: list[dict[str, Any]] = []
        for part in message.content:
            if isinstance(part, TextContentPart):
                content.append({"type": "text", "text": part.text})
            elif isinstance(part, ImageContentPart):
                image_url = part.image_url or part.source_bytes_ref
                if not image_url:
                    raise LLMProviderError("Image content requires image_url or source_bytes_ref.")
                image_payload: dict[str, Any] = {"url": image_url}
                if part.detail:
                    image_payload["detail"] = part.detail
                content.append({"type": "image_url", "image_url": image_payload})

        return {"role": message.role, "content": content}

    def _serialize_message(self, message: LLMInputMessage) -> dict[str, Any]:
        content: list[dict[str, Any]] = []

        for part in message.content:
            if isinstance(part, TextContentPart):
                content.append({"type": "input_text", "text": part.text})
            elif isinstance(part, ImageContentPart):
                image_url = part.image_url or part.source_bytes_ref
                if not image_url:
                    raise LLMProviderError("Image content requires image_url or source_bytes_ref.")

                image_part: dict[str, Any] = {
                    "type": "input_image",
                    "image_url": image_url,
                }
                if part.detail:
                    image_part["detail"] = part.detail
                content.append(image_part)

        serialized: dict[str, Any] = {
            "role": message.role,
            "content": content,
        }

        if message.tool_call_id:
            serialized["tool_call_id"] = message.tool_call_id
        if message.tool_name:
            serialized["name"] = message.tool_name

        return serialized

    def _to_raw_dict(self, response: Any) -> dict[str, Any]:
        if hasattr(response, "model_dump"):
            return response.model_dump(mode="json")
        if isinstance(response, dict):
            return response
        raise LLMProviderError("OpenAI SDK returned an unsupported response object.")

    def _chunk_to_dict(self, chunk: Any) -> dict[str, Any]:
        if hasattr(chunk, "model_dump"):
            return chunk.model_dump(mode="json")
        if isinstance(chunk, dict):
            return chunk
        raise LLMProviderError("OpenAI SDK returned an unsupported stream chunk.")

    def _extract_output_text(self, response: Any, raw: dict[str, Any]) -> str:
        output_text = getattr(response, "output_text", None)
        if isinstance(output_text, str):
            return output_text

        fragments: list[str] = []
        for item in raw.get("output", []):
            for content in item.get("content", []):
                text_value = content.get("text")
                if isinstance(text_value, str):
                    fragments.append(text_value)

        return "".join(fragments)

    def _extract_structured_output(
        self,
        request: LLMRequest,
        output_text: str,
        raw: dict[str, Any],
    ) -> tuple[dict[str, Any] | list[Any] | None, Any]:
        if request.response_mode != "structured":
            return None, None

        parsed_output = raw.get("output_parsed")
        if parsed_output is not None:
            return parsed_output, parsed_output

        if output_text:
            try:
                return json.loads(output_text), output_text
            except json.JSONDecodeError:
                return None, output_text

        return None, raw.get("output")

    def _extract_finish_reason(self, raw: dict[str, Any]) -> str | None:
        output = raw.get("output")
        if isinstance(output, Sequence):
            for item in output:
                status = item.get("status")
                if status:
                    return str(status)
        return raw.get("status")

    def _extract_usage(self, raw: dict[str, Any]) -> UsageInfo:
        usage = raw.get("usage", {})
        input_tokens = int(usage.get("input_tokens", 0) or 0)
        output_tokens = int(usage.get("output_tokens", 0) or 0)
        total_tokens = int(
            usage.get("total_tokens")
            or usage.get("input_tokens", 0)
            + usage.get("output_tokens", 0)
        )

        return UsageInfo(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
        )

    def _extract_tool_calls(self, raw: dict[str, Any]) -> list[ToolCallRequest]:
        tool_calls: list[ToolCallRequest] = []

        for item in raw.get("output", []):
            if item.get("type") != "function_call":
                continue

            arguments = item.get("arguments")
            if isinstance(arguments, str):
                try:
                    parsed_arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    parsed_arguments = {"raw": arguments}
            elif isinstance(arguments, dict):
                parsed_arguments = arguments
            else:
                parsed_arguments = {}

            tool_calls.append(
                ToolCallRequest(
                    tool_call_id=str(item.get("call_id") or item.get("id")),
                    tool_name=str(item.get("name")),
                    arguments_json=parsed_arguments,
                    provider_metadata={"status": item.get("status")},
                )
            )

        return tool_calls

    def _extract_provider_metadata(
        self,
        *,
        request: LLMRequest,
        model_spec: ModelSpec,
        raw: dict[str, Any],
    ) -> dict[str, Any]:
        metadata: dict[str, Any] = {
            "upstreamModel": model_spec.upstream_model_id,
            "thinkingEnabled": request.thinking_enabled,
        }

        reasoning_text = self._extract_reasoning_text(raw)
        if reasoning_text:
            metadata["reasoning"] = reasoning_text

        return metadata

    def _extract_reasoning_text(self, raw: dict[str, Any]) -> str | None:
        fragments: list[str] = []

        for item in raw.get("output", []):
            if item.get("type") == "reasoning":
                summary = item.get("summary")
                if isinstance(summary, str):
                    fragments.append(summary)
                elif isinstance(summary, list):
                    for part in summary:
                        if isinstance(part, dict) and isinstance(part.get("text"), str):
                            fragments.append(part["text"])

            for content in item.get("content", []):
                if not isinstance(content, dict):
                    continue

                if content.get("type") in {"reasoning", "reasoning_summary"}:
                    text_value = content.get("text")
                    if isinstance(text_value, str):
                        fragments.append(text_value)

                summary = content.get("summary")
                if isinstance(summary, str):
                    fragments.append(summary)

        combined = "\n\n".join(fragment.strip() for fragment in fragments if fragment.strip())
        return combined or None
