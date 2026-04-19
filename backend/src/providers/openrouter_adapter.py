import base64
import os
import json
from typing import List, Any, Dict, Optional, Generator, AsyncGenerator
from openai import OpenAI, AsyncOpenAI

from ..core.schema import (
    LLMRequest, 
    LLMResponse, 
    Message, 
    Attachment, 
    ToolCall, 
    UsageStats, 
    MessageRole,
    ToolDefinition,
    ThinkingLevel
)
from ..core.interfaces import BaseProvider
from ..core.factory import ProviderFactory
from ..core.settings import get_settings

@ProviderFactory.register("openrouter")
class OpenRouterAdapter(BaseProvider):
    def __init__(self, model_name: str, **kwargs: Any):
        super().__init__(model_name, **kwargs)
        settings = get_settings()
        api_key = kwargs.get("api_key") or settings.openrouter_api_key or os.environ.get("OPENROUTER_API_KEY")
        
        if not api_key:
            raise ValueError(
                "OpenRouter API key is missing. Please set OPENROUTER_API_KEY "
                "in your environment or .env file."
            )
            
        base_url = kwargs.get("base_url") or settings.openrouter_base_url or os.environ.get("OPENROUTER_BASE_URL")
        
        # OpenRouter specific headers
        headers = {
            "HTTP-Referer": settings.app_url or "https://github.com/ayush/PremChat",
            "X-Title": settings.app_name or "PremChat",
        }
        
        self.client = OpenAI(api_key=api_key, base_url=base_url, default_headers=headers)
        self.async_client = AsyncOpenAI(api_key=api_key, base_url=base_url, default_headers=headers)

    def _prepare_input(self, request: LLMRequest) -> List[Dict[str, Any]]:
        messages = []
        
        # OpenRouter requires system prompt as a 'system' role message at the start
        if request.system_prompt:
            messages.append({"role": "system", "content": request.system_prompt})

        for msg in request.history:
            formatted_msg = {"role": msg.role.value}
            
            if msg.role == MessageRole.TOOL:
                formatted_msg["tool_call_id"] = msg.tool_call_id
                formatted_msg["content"] = msg.content
            elif msg.role == MessageRole.ASSISTANT:
                if msg.content:
                    formatted_msg["content"] = msg.content
                if msg.thinking:
                    # OpenRouter style for returning reasoning in history
                    formatted_msg["reasoning"] = msg.thinking
                if msg.tool_calls:
                    formatted_msg["tool_calls"] = [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": self._serialize_tool_arguments(tc.arguments)
                            }
                        }
                        for tc in msg.tool_calls
                    ]
            elif msg.role == MessageRole.USER:
                content_parts = []
                if msg.content:
                    content_parts.append({"type": "text", "text": msg.content})
                if msg.attachments:
                    for att in msg.attachments:
                        if att.mime_type.startswith("image/"):
                            img_data = att.content
                            if isinstance(img_data, bytes):
                                img_data = base64.b64encode(img_data).decode("utf-8")
                            content_parts.append({
                                "type": "image_url",
                                "image_url": {"url": f"data:{att.mime_type};base64,{img_data}"}
                            })
                formatted_msg["content"] = content_parts if len(content_parts) > 1 else msg.content

            messages.append(formatted_msg)

        # Current query
        user_content = []
        if request.query:
            user_content.append({"type": "text", "text": request.query})
        if request.attachments:
            for att in request.attachments:
                if att.mime_type.startswith("image/"):
                    img_data = att.content
                    if isinstance(img_data, bytes):
                        img_data = base64.b64encode(img_data).decode("utf-8")
                    user_content.append({
                        "type": "image_url",
                        "image_url": {"url": f"data:{att.mime_type};base64,{img_data}"}
                    })
        
        messages.append({
            "role": "user",
            "content": user_content if len(user_content) > 1 else request.query
        })
        
        return messages

    def _prepare_tools(self, tools: Optional[List[ToolDefinition]]) -> Optional[List[Dict[str, Any]]]:
        if not tools:
            return None
        return [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": self._normalize_schema(t.parameters),
                }
            }
            for t in tools
        ]

    def _normalize_schema(self, schema: Any) -> Any:
        if isinstance(schema, dict):
            normalized = {key: self._normalize_schema(value) for key, value in schema.items()}
            if normalized.get("type") == "object" and "additionalProperties" not in normalized:
                normalized["additionalProperties"] = False
            return normalized
        if isinstance(schema, list):
            return [self._normalize_schema(item) for item in schema]
        return schema

    def _build_create_kwargs(
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
            "temperature": request.config.temperature,
            "top_p": request.config.top_p,
            "stream": stream,
        }

        if request.config.max_tokens is not None:
            kwargs["max_tokens"] = request.config.max_tokens

        tools = self._prepare_tools(request.tools) if include_tools else None
        if tools:
            kwargs["tools"] = tools

        # OpenRouter Reasoning handling: explicit binary toggle
        kwargs["extra_body"] = {
            "reasoning": {
                "enabled": request.config.thinking != ThinkingLevel.OFF
            }
        }

        if include_response_format and request.response_model:
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "output",
                    "strict": True,
                    "schema": self._normalize_schema(request.response_model.model_json_schema())
                }
            }

        return kwargs

    def _request_once(self, request: LLMRequest, *, include_response_format: bool, include_tools: bool) -> LLMResponse:
        response = self.client.chat.completions.create(
            **self._build_create_kwargs(
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
        response = await self.async_client.chat.completions.create(
            **self._build_create_kwargs(
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
        stream = self.client.chat.completions.create(
            **self._build_create_kwargs(
                request,
                stream=True,
                include_response_format=include_response_format,
                include_tools=include_tools,
            )
        )
        stream_state = self._create_stream_state()
        response_model = request.response_model if include_response_format else None
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
        stream = await self.async_client.chat.completions.create(
            **self._build_create_kwargs(
                request,
                stream=True,
                include_response_format=include_response_format,
                include_tools=include_tools,
            )
        )
        stream_state = self._create_stream_state()
        response_model = request.response_model if include_response_format else None
        async for chunk in stream:
            mapped_event = self._map_stream_event(chunk, response_model, stream_state)
            if mapped_event is not None:
                yield mapped_event

    def _serialize_tool_arguments(self, arguments: Any) -> str:
        if isinstance(arguments, str):
            return arguments
        return json.dumps(arguments)

    def _parse_tool_arguments(self, arguments: Any) -> Dict[str, Any]:
        if isinstance(arguments, dict):
            return arguments
        if isinstance(arguments, str):
            try:
                parsed = json.loads(arguments)
                return parsed if isinstance(parsed, dict) else {"value": parsed}
            except json.JSONDecodeError:
                return {"raw": arguments}
        return {"value": arguments}

    def _map_response(self, response: Any, response_model: Optional[Any] = None) -> LLMResponse:
        choice = response.choices[0]
        message = choice.message
        
        content = message.content or ""
        # OpenRouter returns reasoning in message.reasoning
        thinking = getattr(message, "reasoning", None)
        
        tool_calls = []
        if message.tool_calls:
            for tc in message.tool_calls:
                tool_calls.append(
                    ToolCall(
                        id=tc.id,
                        name=tc.function.name,
                        arguments=self._parse_tool_arguments(tc.function.arguments)
                    )
                )

        parsed_obj = None
        if response_model and content:
            try:
                parsed_obj = response_model.model_validate_json(content)
            except Exception:
                pass

        usage_data = response.usage
        usage = UsageStats(
            input_tokens=usage_data.prompt_tokens,
            output_tokens=usage_data.completion_tokens,
            completion_tokens=usage_data.completion_tokens, # OpenRouter usage doesn't always split reasoning
            total_tokens=usage_data.total_tokens
        )

        return LLMResponse(
            content=content,
            thinking=thinking,
            tool_calls=tool_calls,
            usage=usage,
            raw_dump=response.model_dump(),
            metadata={"model": self.model_name, "provider": "openrouter"},
            parsed=parsed_obj
        )

    def _create_stream_state(self) -> Dict[str, Any]:
        return {"tool_calls": {}, "full_content": "", "full_thinking": ""}

    def _map_stream_event(
        self,
        chunk: Any,
        response_model: Optional[Any] = None,
        stream_state: Optional[Dict[str, Any]] = None,
    ) -> Optional[LLMResponse]:
        if not chunk.choices:
            return None

        choice = chunk.choices[0]
        delta = choice.delta
        stream_state = stream_state or self._create_stream_state()
        finish_reason = choice.finish_reason
        
        content = delta.content or ""
        thinking = getattr(delta, "reasoning", None) or ""
        tool_calls = []

        if content and finish_reason in {"stop", "length"} and stream_state["full_content"] == content:
            content = ""

        if thinking and finish_reason in {"stop", "length"} and stream_state["full_thinking"] == thinking:
            thinking = ""

        if content:
            stream_state["full_content"] += content

        if thinking:
            stream_state["full_thinking"] += thinking

        if delta.tool_calls:
            for tc_delta in delta.tool_calls:
                idx = tc_delta.index
                tool_call_state = stream_state["tool_calls"].setdefault(
                    idx,
                    {"id": None, "name": None, "arguments": ""},
                )

                if tc_delta.id:
                    tool_call_state["id"] = tc_delta.id

                function_delta = getattr(tc_delta, "function", None)
                if function_delta is not None:
                    if getattr(function_delta, "name", None):
                        tool_call_state["name"] = function_delta.name
                    if getattr(function_delta, "arguments", None):
                        tool_call_state["arguments"] += function_delta.arguments

        # Check for finished tool calls on this chunk
        if finish_reason == "tool_calls":
            for idx, tc_data in stream_state["tool_calls"].items():
                if not tc_data["id"] or not tc_data["name"]:
                    continue
                tool_calls.append(
                    ToolCall(
                        id=tc_data["id"],
                        name=tc_data["name"],
                        arguments=self._parse_tool_arguments(tc_data["arguments"])
                    )
                )
            # Clear them so we don't emit twice
            stream_state["tool_calls"] = {}

        usage = UsageStats()
        if hasattr(chunk, "usage") and chunk.usage:
            usage = UsageStats(
                input_tokens=chunk.usage.prompt_tokens,
                output_tokens=chunk.usage.completion_tokens,
                total_tokens=chunk.usage.total_tokens
            )

        parsed_obj = None
        if response_model and stream_state["full_content"]:
            try:
                parsed_obj = response_model.model_validate_json(stream_state["full_content"])
            except Exception:
                pass

        if not content and not thinking and not tool_calls and not usage.total_tokens:
            return None

        return LLMResponse(
            content=content,
            thinking=thinking if thinking else None,
            tool_calls=tool_calls,
            usage=usage,
            raw_dump=chunk.model_dump(),
            metadata={"model": self.model_name, "provider": "openrouter"},
            parsed=parsed_obj
        )

    def generate(self, request: LLMRequest) -> LLMResponse:
        return self._request_once(request, include_response_format=True, include_tools=True)

    async def agenerate(self, request: LLMRequest) -> LLMResponse:
        return await self._arequest_once(request, include_response_format=True, include_tools=True)

    def stream(self, request: LLMRequest) -> Generator[LLMResponse, None, None]:
        yield from self._stream_once(request, include_response_format=True, include_tools=True)

    async def astream(self, request: LLMRequest) -> AsyncGenerator[LLMResponse, None]:
        async for response in self._astream_once(request, include_response_format=True, include_tools=True):
            yield response
