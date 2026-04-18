import json
import os
import re
from typing import Any, AsyncGenerator, Dict, Generator, List, Literal, Optional

from ollama import AsyncClient, Client

from ..core.factory import ProviderFactory
from ..core.interfaces import BaseProvider
from ..core.schema import (
    Attachment,
    LLMRequest,
    LLMResponse,
    Message,
    MessageRole,
    ThinkingLevel,
    ToolCall,
    ToolDefinition,
    UsageStats,
)
from ..core.settings import get_settings

ThinkingProfile = Literal["boolean", "discrete_levels", "unsupported"]


@ProviderFactory.register("ollama")
class OllamaAdapter(BaseProvider):
    def __init__(self, model_name: str, **kwargs: Any):
        super().__init__(model_name, **kwargs)
        settings = get_settings()

        self.host = kwargs.get("host") or settings.ollama_host or os.environ.get("OLLAMA_HOST")
        configured_api_key = kwargs.get("api_key") or settings.ollama_api_key or os.environ.get("OLLAMA_API_KEY")
        self.api_key = configured_api_key if self._should_use_api_key(self.host, kwargs.get("api_key")) else None
        self._response_sequence = 0

        headers = dict(kwargs.get("headers") or {})
        normalized_headers = {key.lower(): value for key, value in headers.items()}
        if self.api_key and "authorization" not in normalized_headers:
            headers["Authorization"] = f"Bearer {self.api_key}"

        self.client = Client(host=self.host, headers=headers or None)
        self.async_client = AsyncClient(host=self.host, headers=headers or None)

    def _should_use_api_key(self, host: str, explicit_api_key: Optional[str]) -> bool:
        if explicit_api_key:
            return True
        normalized_host = host.lower()
        return normalized_host.startswith("https://ollama.com") or normalized_host.startswith("http://ollama.com")

    def _normalize_schema(self, schema: Any) -> Any:
        if isinstance(schema, dict):
            normalized = {key: self._normalize_schema(value) for key, value in schema.items()}
            if normalized.get("type") == "object" and "additionalProperties" not in normalized:
                normalized["additionalProperties"] = False
            return normalized
        if isinstance(schema, list):
            return [self._normalize_schema(item) for item in schema]
        return schema

    def _thinking_profile(self) -> ThinkingProfile:
        normalized_name = self.model_name.lower()
        if normalized_name.startswith("gpt-oss"):
            return "discrete_levels"
        return "boolean"

    def _resolve_think_parameter(self, level: ThinkingLevel) -> Optional[bool | str]:
        profile = self._thinking_profile()

        if profile == "boolean":
            return level != ThinkingLevel.OFF

        if profile == "discrete_levels":
            if level == ThinkingLevel.OFF:
                raise ValueError(
                    f"Model '{self.model_name}' does not support thinking level '{ThinkingLevel.OFF.value}'. "
                    "Supported levels are: low, medium, high."
                )
            return level.value

        if level != ThinkingLevel.OFF:
            raise ValueError(f"Model '{self.model_name}' does not support thinking mode.")
        return None

    def _prepare_images(self, attachments: Optional[List[Attachment]]) -> Optional[List[str | bytes]]:
        if not attachments:
            return None

        images: List[str | bytes] = []
        for attachment in attachments:
            if not attachment.mime_type.startswith("image/"):
                continue
            images.append(attachment.content)
        return images or None

    def _prepare_input(self, request: LLMRequest) -> List[Dict[str, Any]]:
        messages: List[Dict[str, Any]] = []

        if request.system_prompt:
            messages.append({"role": MessageRole.SYSTEM.value, "content": request.system_prompt})

        call_id_to_name: Dict[str, str] = {}
        for msg in request.history:
            if msg.role == MessageRole.ASSISTANT and msg.tool_calls:
                for tool_call in msg.tool_calls:
                    call_id_to_name[tool_call.id] = tool_call.name

        for msg in request.history:
            if msg.role == MessageRole.TOOL:
                tool_name = call_id_to_name.get(msg.tool_call_id or "") or msg.tool_call_id or "unknown"
                messages.append(
                    {
                        "role": MessageRole.TOOL.value,
                        "tool_name": tool_name,
                        "content": msg.content or "",
                    }
                )
                continue

            formatted_msg: Dict[str, Any] = {"role": msg.role.value}
            if msg.content is not None:
                formatted_msg["content"] = msg.content
            if msg.thinking:
                formatted_msg["thinking"] = msg.thinking

            images = self._prepare_images(msg.attachments)
            if images:
                formatted_msg["images"] = images

            if msg.role == MessageRole.ASSISTANT and msg.tool_calls:
                formatted_msg["tool_calls"] = [
                    {
                        "function": {
                            "name": tool_call.name,
                            "arguments": tool_call.arguments,
                        }
                    }
                    for tool_call in msg.tool_calls
                ]

            messages.append(formatted_msg)

        current_msg: Dict[str, Any] = {"role": MessageRole.USER.value, "content": request.query}
        current_images = self._prepare_images(request.attachments)
        if current_images:
            current_msg["images"] = current_images
        messages.append(current_msg)
        return messages

    def _prepare_tools(self, tools: Optional[List[ToolDefinition]]) -> Optional[List[Dict[str, Any]]]:
        if not tools:
            return None

        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": self._normalize_schema(tool.parameters),
                },
            }
            for tool in tools
        ]

    def _prepare_options(self, request: LLMRequest) -> Dict[str, Any]:
        options: Dict[str, Any] = {
            "temperature": request.config.temperature,
            "top_p": request.config.top_p,
        }

        if request.config.max_tokens is not None:
            options["num_predict"] = request.config.max_tokens

        if request.config.stop_sequences:
            options["stop"] = request.config.stop_sequences

        return options

    def _build_chat_kwargs(
        self,
        request: LLMRequest,
        *,
        stream: bool = False,
        include_response_format: bool = True,
        include_tools: bool = True,
    ) -> Dict[str, Any]:
        kwargs: Dict[str, Any] = {
            "model": self.model_name,
            "messages": self._prepare_input(request),
            "stream": stream,
            "think": self._resolve_think_parameter(request.config.thinking),
            "options": self._prepare_options(request),
        }

        if include_tools:
            tools = self._prepare_tools(request.tools)
            if tools:
                kwargs["tools"] = tools

        if include_response_format and request.response_model:
            kwargs["format"] = self._normalize_schema(request.response_model.model_json_schema())

        return kwargs

    def _next_response_round(self) -> int:
        self._response_sequence += 1
        return self._response_sequence

    def _tool_call_id(self, response_round: int, tool_index: int) -> str:
        return f"ollama_call_{response_round}_{tool_index}"

    def _parse_tool_arguments(self, arguments: Any) -> Dict[str, Any]:
        if isinstance(arguments, dict):
            return arguments
        if isinstance(arguments, str):
            try:
                parsed = json.loads(arguments)
            except json.JSONDecodeError:
                return {"raw": arguments}
            if isinstance(parsed, dict):
                return parsed
            return {"value": parsed}
        return {"value": arguments}

    def _map_tool_calls(self, tool_calls: Any, response_round: int) -> List[ToolCall]:
        mapped_tool_calls: List[ToolCall] = []
        for index, tool_call in enumerate(tool_calls or []):
            function = getattr(tool_call, "function", None) or tool_call.get("function", {})
            name = getattr(function, "name", None) or function.get("name")
            arguments = getattr(function, "arguments", None) or function.get("arguments")
            if not name:
                continue
            mapped_tool_calls.append(
                ToolCall(
                    id=self._tool_call_id(response_round, index),
                    name=name,
                    arguments=self._parse_tool_arguments(arguments),
                )
            )
        return mapped_tool_calls

    def _parse_structured_output(self, response_model: Optional[Any], content: str) -> Optional[Any]:
        if not response_model or not content:
            return None
        for candidate in self._structured_output_candidates(content):
            try:
                return response_model.model_validate_json(candidate)
            except Exception:
                continue
        return None

    def _structured_output_candidates(self, content: str) -> List[str]:
        stripped = content.strip()
        candidates = [stripped]

        fenced_match = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, re.DOTALL | re.IGNORECASE)
        if fenced_match:
            candidates.append(fenced_match.group(1).strip())

        return candidates

    def _map_response(self, response: Any, response_model: Optional[Any] = None) -> LLMResponse:
        message = response.message
        content = message.content or ""
        thinking = getattr(message, "thinking", None)
        response_round = self._next_response_round()
        tool_calls = self._map_tool_calls(getattr(message, "tool_calls", None), response_round)

        usage = UsageStats(
            input_tokens=response.prompt_eval_count or 0,
            output_tokens=response.eval_count or 0,
            completion_tokens=response.eval_count or 0,
            total_tokens=(response.prompt_eval_count or 0) + (response.eval_count or 0),
        )

        return LLMResponse(
            content=content,
            thinking=thinking,
            tool_calls=tool_calls,
            usage=usage,
            raw_dump=response.model_dump() if hasattr(response, "model_dump") else {},
            metadata={"model": self.model_name, "provider": "ollama", "host": self.host},
            parsed=self._parse_structured_output(response_model, content),
        )

    def _create_stream_state(self) -> Dict[str, Any]:
        return {
            "full_content": "",
            "emitted_tool_calls": set(),
            "response_round": self._next_response_round(),
        }

    def _map_stream_event(
        self,
        chunk: Any,
        response_model: Optional[Any] = None,
        stream_state: Optional[Dict[str, Any]] = None,
    ) -> Optional[LLMResponse]:
        stream_state = stream_state or self._create_stream_state()
        message = chunk.message

        content = message.content or ""
        thinking = getattr(message, "thinking", None) or ""
        tool_calls: List[ToolCall] = []

        if content:
            stream_state["full_content"] += content

        for index, tool_call in enumerate(getattr(message, "tool_calls", None) or []):
            if index in stream_state["emitted_tool_calls"]:
                continue
            function = getattr(tool_call, "function", None)
            if function is None or not getattr(function, "name", None):
                continue
            stream_state["emitted_tool_calls"].add(index)
            tool_calls.append(
                ToolCall(
                    id=self._tool_call_id(stream_state["response_round"], index),
                    name=function.name,
                    arguments=self._parse_tool_arguments(function.arguments),
                )
            )

        usage = UsageStats()
        if getattr(chunk, "done", False):
            input_tokens = chunk.prompt_eval_count or 0
            output_tokens = chunk.eval_count or 0
            usage = UsageStats(
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                completion_tokens=output_tokens,
                total_tokens=input_tokens + output_tokens,
            )

        parsed = self._parse_structured_output(response_model, stream_state["full_content"])
        if not content and not thinking and not tool_calls and not usage.total_tokens:
            return None

        return LLMResponse(
            content=content,
            thinking=thinking if thinking else None,
            tool_calls=tool_calls,
            usage=usage,
            raw_dump=chunk.model_dump() if hasattr(chunk, "model_dump") else {},
            metadata={"model": self.model_name, "provider": "ollama", "host": self.host},
            parsed=parsed,
        )

    def _request_once(
        self,
        request: LLMRequest,
        *,
        include_response_format: bool,
        include_tools: bool,
    ) -> LLMResponse:
        response = self.client.chat(
            **self._build_chat_kwargs(
                request,
                include_response_format=include_response_format,
                include_tools=include_tools,
            )
        )
        response_model = request.response_model if include_response_format else None
        return self._map_response(response, response_model)

    async def _arequest_once(
        self,
        request: LLMRequest,
        *,
        include_response_format: bool,
        include_tools: bool,
    ) -> LLMResponse:
        response = await self.async_client.chat(
            **self._build_chat_kwargs(
                request,
                include_response_format=include_response_format,
                include_tools=include_tools,
            )
        )
        response_model = request.response_model if include_response_format else None
        return self._map_response(response, response_model)

    def _stream_once(
        self,
        request: LLMRequest,
        *,
        include_response_format: bool,
        include_tools: bool,
    ) -> Generator[LLMResponse, None, None]:
        stream = self.client.chat(
            **self._build_chat_kwargs(
                request,
                stream=True,
                include_response_format=include_response_format,
                include_tools=include_tools,
            )
        )
        response_model = request.response_model if include_response_format else None
        stream_state = self._create_stream_state()
        for chunk in stream:
            mapped_event = self._map_stream_event(chunk, response_model, stream_state)
            if mapped_event is not None:
                yield mapped_event

    async def _astream_once(
        self,
        request: LLMRequest,
        *,
        include_response_format: bool,
        include_tools: bool,
    ) -> AsyncGenerator[LLMResponse, None]:
        stream = await self.async_client.chat(
            **self._build_chat_kwargs(
                request,
                stream=True,
                include_response_format=include_response_format,
                include_tools=include_tools,
            )
        )
        response_model = request.response_model if include_response_format else None
        stream_state = self._create_stream_state()
        try:
            async for chunk in stream:
                mapped_event = self._map_stream_event(chunk, response_model, stream_state)
                if mapped_event is not None:
                    yield mapped_event
        finally:
            aclose = getattr(stream, "aclose", None)
            if callable(aclose):
                try:
                    await aclose()
                except RuntimeError:
                    pass

    def generate(self, request: LLMRequest) -> LLMResponse:
        return self._request_once(request, include_response_format=True, include_tools=True)

    async def agenerate(self, request: LLMRequest) -> LLMResponse:
        return await self._arequest_once(request, include_response_format=True, include_tools=True)

    def stream(self, request: LLMRequest) -> Generator[LLMResponse, None, None]:
        yield from self._stream_once(request, include_response_format=True, include_tools=True)

    async def astream(self, request: LLMRequest) -> AsyncGenerator[LLMResponse, None]:
        final_stream = self._astream_once(
            request,
            include_response_format=True,
            include_tools=True,
        )
        try:
            async for response in final_stream:
                yield response
        finally:
            await final_stream.aclose()
