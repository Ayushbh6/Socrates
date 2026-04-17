from __future__ import annotations

import json
from collections.abc import AsyncIterator
from decimal import Decimal
from typing import Any

import httpx

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


class OpenRouterProvider(BaseLLMProvider):
    provider_name = "openrouter"

    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str,
        client: httpx.AsyncClient | None = None,
        app_url: str | None = None,
        app_title: str | None = None,
    ):
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._client = client
        self._app_url = app_url
        self._app_title = app_title

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is not None:
            return self._client

        if not self._api_key:
            raise LLMProviderError("OPENROUTER_API_KEY is not configured.")

        headers = self._build_headers()
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers=headers,
            timeout=60.0,
        )
        return self._client

    async def generate(self, request: LLMRequest, model_spec: ModelSpec) -> LLMResponse:
        payload = self._build_payload(request, model_spec)
        headers = self._build_headers()

        try:
            response = await self.client.post(
                "/chat/completions",
                json=payload,
                headers=headers,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            body = exc.response.text
            raise LLMProviderError(
                f"OpenRouter request failed with status {exc.response.status_code}: {body}"
            ) from exc
        except httpx.HTTPError as exc:
            raise LLMProviderError(f"OpenRouter request failed: {exc}") from exc

        raw = response.json()
        output_text = self._extract_output_text(raw)
        structured_output, structured_output_raw = self._extract_structured_output(
            request,
            output_text,
        )

        return LLMResponse(
            provider=self.provider_name,
            model=model_spec.public_id,
            provider_message_id=raw.get("id"),
            request_id=response.headers.get("x-request-id"),
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

        payload = self._build_payload(request, model_spec)
        payload["stream"] = True
        headers = self._build_headers()

        text_index = 0
        reasoning_index = 0
        event_index = 0
        raw_chunks: list[dict[str, Any]] = []
        response_id: str | None = None
        provider_metadata: dict[str, Any] = {
            "upstreamModel": model_spec.upstream_model_id,
            "thinkingEnabled": request.thinking_enabled,
        }
        tool_calls: list[ToolCallRequest] = []
        final_usage = UsageInfo()
        finish_reason: str | None = None

        try:
            async with self.client.stream(
                "POST",
                "/chat/completions",
                json=payload,
                headers=headers,
            ) as response:
                response.raise_for_status()

                yield LLMEvent(
                    event_type="response.started",
                    event_index=event_index,
                    provider=self.provider_name,
                    model=model_spec.public_id,
                    message_id=request.message_id,
                    payload={},
                )
                event_index += 1

                async for line in response.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue

                    data = line[6:].strip()
                    if data == "[DONE]":
                        break

                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue

                    if isinstance(chunk, dict):
                        raw_chunks.append(chunk)

                    if response_id is None and isinstance(chunk, dict):
                        response_id = chunk.get("id")

                    choice = self._first_choice(chunk)
                    delta = choice.get("delta", {}) if isinstance(choice, dict) else {}
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
                            payload={"delta": content_delta, "index": text_index},
                        )
                        event_index += 1
                        text_index += 1

                    reasoning_delta = self._extract_reasoning_delta(delta)
                    if reasoning_delta:
                        yield LLMEvent(
                            event_type="reasoning.delta",
                            event_index=event_index,
                            provider=self.provider_name,
                            model=model_spec.public_id,
                            message_id=request.message_id,
                            payload={"delta": reasoning_delta, "index": reasoning_index},
                        )
                        event_index += 1
                        reasoning_index += 1

                    if isinstance(choice, dict) and choice.get("finish_reason"):
                        finish_reason = str(choice.get("finish_reason"))

                    if isinstance(chunk, dict):
                        extracted_usage = self._extract_usage(chunk)
                        if (
                            extracted_usage.input_tokens
                            or extracted_usage.output_tokens
                            or extracted_usage.total_tokens
                            or extracted_usage.cost_usd
                        ):
                            final_usage = extracted_usage

                        extracted_tool_calls = self._extract_tool_calls(chunk)
                        if extracted_tool_calls:
                            tool_calls = extracted_tool_calls

                        chunk_metadata = self._extract_provider_metadata(
                            request=request,
                            model_spec=model_spec,
                            raw=chunk,
                        )
                        provider_metadata.update(chunk_metadata)

        except httpx.HTTPStatusError as exc:
            body = exc.response.text
            raise LLMProviderError(
                f"OpenRouter request failed with status {exc.response.status_code}: {body}"
            ) from exc
        except httpx.HTTPError as exc:
            raise LLMProviderError(f"OpenRouter request failed: {exc}") from exc

        yield LLMEvent(
            event_type="response.completed",
            event_index=event_index,
            provider=self.provider_name,
            model=model_spec.public_id,
            message_id=request.message_id,
            payload={
                "provider_message_id": response_id,
                "request_id": None,
                "finish_reason": finish_reason,
                "provider_metadata": provider_metadata,
                "raw_response": {"stream": raw_chunks},
                "tool_calls": [
                    {
                        "tool_call_id": item.tool_call_id,
                        "tool_name": item.tool_name,
                        "arguments_json": item.arguments_json,
                        "provider_metadata": item.provider_metadata,
                    }
                    for item in tool_calls
                ],
                "usage": {
                    "input_tokens": final_usage.input_tokens,
                    "output_tokens": final_usage.output_tokens,
                    "total_tokens": final_usage.total_tokens,
                    "cost_usd": str(final_usage.cost_usd),
                },
            },
            input_tokens=final_usage.input_tokens,
            output_tokens=final_usage.output_tokens,
        )

    def _build_headers(self) -> dict[str, str]:
        if not self._api_key:
            raise LLMProviderError("OPENROUTER_API_KEY is not configured.")

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

        if self._app_url:
            headers["HTTP-Referer"] = self._app_url
        if self._app_title:
            headers["X-Title"] = self._app_title

        return headers

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
            "messages": [self._serialize_message(message) for message in messages],
        }

        if request.temperature is not None:
            payload["temperature"] = request.temperature

        if request.max_output_tokens is not None:
            payload["max_tokens"] = request.max_output_tokens

        if model_spec.supports_thinking:
            if request.thinking_enabled:
                payload["reasoning"] = {"enabled": True}
            elif model_spec.reasoning_cannot_be_disabled:
                payload["reasoning"] = {
                    "enabled": True,
                    "exclude": True,
                }
            else:
                payload["reasoning"] = {"enabled": False}

        if request.tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    },
                }
                for tool in request.tools
            ]

        if request.tool_choice is not None:
            payload["tool_choice"] = request.tool_choice

        if request.response_mode == "structured" and request.output_schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": request.output_schema.name,
                    "strict": request.output_schema.strict,
                    "schema": request.output_schema.schema,
                },
            }

        return payload

    def _serialize_message(self, message: LLMInputMessage) -> dict[str, Any]:
        serialized: dict[str, Any] = {"role": message.role}

        if message.role == "tool":
            content = self._serialize_tool_content(message)
            serialized["content"] = content
            if message.tool_call_id:
                serialized["tool_call_id"] = message.tool_call_id
            if message.tool_name:
                serialized["name"] = message.tool_name
            return serialized

        if self._is_text_only(message):
            serialized["content"] = self._serialize_text_content(message)
        else:
            serialized["content"] = self._serialize_content_parts(message)

        if message.tool_name:
            serialized["name"] = message.tool_name
        if message.role == "assistant":
            reasoning = (
                message.provider_metadata.get("reasoning")
                or message.provider_metadata.get("reasoning_text")
            )
            reasoning_details = (
                message.provider_metadata.get("reasoningDetails")
                or message.provider_metadata.get("reasoning_details")
            )
            if reasoning:
                serialized["reasoning"] = reasoning
            if reasoning_details:
                serialized["reasoning_details"] = reasoning_details

        return serialized

    def _serialize_tool_content(self, message: LLMInputMessage) -> str:
        if not message.content:
            return ""

        return "".join(
            part.text for part in message.content if isinstance(part, TextContentPart)
        )

    def _serialize_text_content(self, message: LLMInputMessage) -> str:
        return "".join(
            part.text for part in message.content if isinstance(part, TextContentPart)
        )

    def _serialize_content_parts(self, message: LLMInputMessage) -> list[dict[str, Any]]:
        parts: list[dict[str, Any]] = []

        for part in message.content:
            if isinstance(part, TextContentPart):
                parts.append({"type": "text", "text": part.text})
            elif isinstance(part, ImageContentPart):
                image_url = part.image_url or part.source_bytes_ref
                if not image_url:
                    raise LLMProviderError("Image content requires image_url or source_bytes_ref.")

                image_payload: dict[str, Any] = {"url": image_url}
                if part.detail:
                    image_payload["detail"] = part.detail

                parts.append(
                    {
                        "type": "image_url",
                        "image_url": image_payload,
                    }
                )

        return parts

    def _is_text_only(self, message: LLMInputMessage) -> bool:
        return all(isinstance(part, TextContentPart) for part in message.content)

    def _extract_output_text(self, raw: dict[str, Any]) -> str:
        message = self._first_message(raw)
        content = message.get("content") if isinstance(message, dict) else None

        if isinstance(content, str):
            return content

        if isinstance(content, list):
            fragments: list[str] = []
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    fragments.append(item["text"])
            return "".join(fragments)

        return ""

    def _extract_reasoning_delta(self, delta: dict[str, Any]) -> str:
        candidates = [
            delta.get("reasoning"),
            delta.get("reasoning_text"),
            delta.get("reasoning_content"),
        ]

        for candidate in candidates:
            if isinstance(candidate, str) and candidate:
                return candidate

        reasoning_details = delta.get("reasoning_details")
        if isinstance(reasoning_details, list):
            fragments: list[str] = []
            for item in reasoning_details:
                if isinstance(item, dict):
                    text_value = item.get("text") or item.get("summary")
                    if isinstance(text_value, str) and text_value:
                        fragments.append(text_value)
            if fragments:
                return "\n".join(fragments)

        return ""

    def _extract_structured_output(
        self,
        request: LLMRequest,
        output_text: str,
    ) -> tuple[dict[str, Any] | list[Any] | None, Any]:
        if request.response_mode != "structured":
            return None, None

        if not output_text:
            return None, None

        try:
            return json.loads(output_text), output_text
        except json.JSONDecodeError:
            return None, output_text

    def _extract_finish_reason(self, raw: dict[str, Any]) -> str | None:
        choice = self._first_choice(raw)
        if isinstance(choice, dict):
            return choice.get("finish_reason")
        return None

    def _extract_usage(self, raw: dict[str, Any]) -> UsageInfo:
        usage = raw.get("usage", {})
        provider_cost = (
            usage.get("cost")
            or raw.get("cost")
            or raw.get("provider_data", {}).get("cost")
        )

        cost_usd = Decimal("0")
        if provider_cost is not None:
            try:
                cost_usd = Decimal(str(provider_cost))
            except Exception:
                cost_usd = Decimal("0")

        return UsageInfo(
            input_tokens=int(usage.get("prompt_tokens", 0) or 0),
            output_tokens=int(usage.get("completion_tokens", 0) or 0),
            total_tokens=int(usage.get("total_tokens", 0) or 0),
            cost_usd=cost_usd,
        )

    def _extract_tool_calls(self, raw: dict[str, Any]) -> list[ToolCallRequest]:
        message = self._first_message(raw)
        if not isinstance(message, dict):
            return []

        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list):
            return []

        normalized: list[ToolCallRequest] = []
        for tool_call in tool_calls:
            if not isinstance(tool_call, dict):
                continue

            function = tool_call.get("function") or {}
            arguments = function.get("arguments")

            if isinstance(arguments, str):
                try:
                    parsed_arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    parsed_arguments = {"raw": arguments}
            elif isinstance(arguments, dict):
                parsed_arguments = arguments
            else:
                parsed_arguments = {}

            normalized.append(
                ToolCallRequest(
                    tool_call_id=str(tool_call.get("id")),
                    tool_name=str(function.get("name")),
                    arguments_json=parsed_arguments,
                    provider_metadata={"type": tool_call.get("type")},
                )
            )

        return normalized

    def _extract_provider_metadata(
        self,
        *,
        request: LLMRequest,
        model_spec: ModelSpec,
        raw: dict[str, Any],
    ) -> dict[str, Any]:
        message = self._first_message(raw)
        metadata: dict[str, Any] = {
            "upstreamModel": model_spec.upstream_model_id,
            "thinkingEnabled": request.thinking_enabled,
        }

        if isinstance(message, dict):
            reasoning = message.get("reasoning")
            reasoning_details = message.get("reasoning_details")
            if reasoning is not None:
                metadata["reasoning"] = reasoning
            if isinstance(reasoning_details, list) and reasoning_details:
                metadata["reasoningDetails"] = reasoning_details

        return metadata

    def _first_choice(self, raw: dict[str, Any]) -> dict[str, Any]:
        choices = raw.get("choices", [])
        if isinstance(choices, list) and choices:
            choice = choices[0]
            if isinstance(choice, dict):
                return choice
        return {}

    def _first_message(self, raw: dict[str, Any]) -> dict[str, Any]:
        choice = self._first_choice(raw)
        message = choice.get("message", {})
        if isinstance(message, dict):
            return message
        return {}
