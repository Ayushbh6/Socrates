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

@ProviderFactory.register("openai")
class OpenAIAdapter(BaseProvider):
    def __init__(self, model_name: str, **kwargs: Any):
        super().__init__(model_name, **kwargs)
        settings = get_settings()
        api_key = kwargs.get("api_key") or settings.openai_api_key or os.environ.get("OPENAI_API_KEY")
        base_url = kwargs.get("base_url") or settings.openai_base_url or os.environ.get("OPENAI_BASE_URL")
        
        self.client = OpenAI(api_key=api_key, base_url=base_url)
        self.async_client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    def _prepare_input(self, request: LLMRequest) -> List[Dict[str, Any]]:
        openai_input = []
        
        def format_content(msg: Message) -> List[Dict[str, Any]]:
            parts = []
            if msg.content:
                parts.append({"type": "input_text", "text": msg.content})
            if msg.attachments:
                for att in msg.attachments:
                    if att.mime_type.startswith("image/"):
                        img_data = att.content
                        if isinstance(img_data, bytes):
                            img_data = base64.b64encode(img_data).decode("utf-8")
                        parts.append({
                            "type": "input_image",
                            "image_url": f"data:{att.mime_type};base64,{img_data}"
                        })
            return parts

        for msg in request.history:
            if msg.role == MessageRole.TOOL:
                openai_input.append({
                    "type": "function_call_output",
                    "call_id": msg.tool_call_id,
                    "output": msg.content
                })
            elif msg.role == MessageRole.ASSISTANT and msg.tool_calls:
                for tc in msg.tool_calls:
                    openai_input.append({
                        "type": "function_call",
                        "call_id": tc.id,
                        "name": tc.name,
                        "arguments": self._serialize_tool_arguments(tc.arguments),
                    })
                if msg.content:
                    openai_input.append({"role": "assistant", "content": format_content(msg)})
            else:
                openai_input.append({"role": msg.role.value, "content": format_content(msg)})

        current_msg = Message(role=MessageRole.USER, content=request.query, attachments=request.attachments)
        openai_input.append({"role": "user", "content": format_content(current_msg)})
        return openai_input

    def _prepare_tools(self, tools: Optional[List[ToolDefinition]]) -> Optional[List[Dict[str, Any]]]:
        if not tools:
            return None
        return [
            {
                "type": "function",
                "name": t.name,
                "description": t.description,
                "parameters": self._normalize_schema(t.parameters),
                "strict": True,
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

    def _map_thinking_level(self, level: ThinkingLevel) -> str:
        """Maps unified ThinkingLevel to OpenAI Responses reasoning effort."""
        mapping = {
            ThinkingLevel.OFF: "none",
            ThinkingLevel.LOW: "low",
            ThinkingLevel.MEDIUM: "medium",
            ThinkingLevel.HIGH: "high"
        }
        return mapping.get(level, "none")

    def _prepare_reasoning(self, level: ThinkingLevel) -> Dict[str, Any]:
        return {"effort": self._map_thinking_level(level)}

    def _prepare_text_config(self, response_model: Optional[Any]) -> Optional[Dict[str, Any]]:
        if not response_model:
            return None
        return {
            "format": {
                "type": "json_schema",
                "name": "output",
                "schema": self._normalize_schema(response_model.model_json_schema()),
                "strict": True,
            }
        }

    def _is_reasoning_model(self) -> bool:
        normalized_name = self.model_name.lower()
        return normalized_name.startswith("gpt-5") or normalized_name.startswith("o")

    def _build_create_kwargs(self, request: LLMRequest, *, stream: bool = False) -> Dict[str, Any]:
        kwargs: Dict[str, Any] = {
            "model": self.model_name,
            "input": self._prepare_input(request),
            "instructions": request.system_prompt,
            "reasoning": self._prepare_reasoning(request.config.thinking),
        }

        if not self._is_reasoning_model():
            kwargs["temperature"] = request.config.temperature
            kwargs["top_p"] = request.config.top_p

        tools = self._prepare_tools(request.tools)
        if tools:
            kwargs["tools"] = tools

        text = self._prepare_text_config(request.response_model)
        if text:
            kwargs["text"] = text

        if request.config.max_tokens is not None:
            kwargs["max_output_tokens"] = request.config.max_tokens

        if stream:
            kwargs["stream"] = True

        return kwargs

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

    def _serialize_tool_arguments(self, arguments: Any) -> str:
        if isinstance(arguments, str):
            return arguments
        return json.dumps(arguments, separators=(",", ":"))

    def _tool_call_identifier(self, item: Any) -> str:
        return getattr(item, "call_id", None) or getattr(item, "id", None)

    def _record_stream_tool_call(self, stream_state: Dict[str, Any], item: Any) -> None:
        item_id = getattr(item, "id", None)
        if not item_id:
            return

        stream_state["tool_calls"][item_id] = {
            "id": self._tool_call_identifier(item),
            "name": getattr(item, "name", None),
            "arguments": getattr(item, "arguments", "") or "",
        }

    def _create_stream_state(self) -> Dict[str, Any]:
        return {"tool_calls": {}}

    def _map_stream_event(
        self,
        event: Any,
        response_model: Optional[Any] = None,
        stream_state: Optional[Dict[str, Any]] = None,
    ) -> Optional[LLMResponse]:
        event_type = getattr(event, "type", None)
        metadata = {"model": self.model_name, "provider": "openai"}
        stream_state = stream_state or self._create_stream_state()

        if event_type in {"response.output_item.added", "response.output_item.done"}:
            item = getattr(event, "item", None)
            if getattr(item, "type", None) == "function_call":
                self._record_stream_tool_call(stream_state, item)
            return None

        if event_type == "response.output_text.delta":
            return LLMResponse(
                content=event.delta,
                usage=UsageStats(),
                raw_dump=event.model_dump(),
                metadata=metadata,
            )

        if event_type in {"response.reasoning_text.delta", "response.reasoning_summary_text.delta"}:
            return LLMResponse(
                content="",
                thinking=event.delta,
                usage=UsageStats(),
                raw_dump=event.model_dump(),
                metadata=metadata,
            )

        if event_type == "response.function_call_arguments.delta":
            tool_call_state = stream_state["tool_calls"].setdefault(
                event.item_id,
                {"id": event.item_id, "name": None, "arguments": ""},
            )
            tool_call_state["arguments"] += event.delta
            return None

        if event_type == "response.function_call_arguments.done":
            tool_call_state = stream_state["tool_calls"].get(event.item_id, {})
            tool_call_name = event.name or tool_call_state.get("name")
            if not tool_call_name:
                return None

            tool_call_id = tool_call_state.get("id") or event.item_id
            tool_call_arguments = event.arguments or tool_call_state.get("arguments", "")
            return LLMResponse(
                content="",
                tool_calls=[
                    ToolCall(
                        id=tool_call_id,
                        name=tool_call_name,
                        arguments=self._parse_tool_arguments(tool_call_arguments),
                    )
                ],
                usage=UsageStats(),
                raw_dump=event.model_dump(),
                metadata=metadata,
            )

        if event_type == "response.completed":
            return self._map_response(event.response, response_model)

        return None

    def _map_response(self, response: Any, response_model: Optional[Any] = None) -> LLMResponse:
        content = ""
        thinking = ""
        tool_calls = []
        parsed_obj = None
        
        for item in response.output:
            if item.type == "message":
                for part in item.content:
                    if getattr(part, "type", None) in {"text", "output_text"}:
                        content += part.text
            elif item.type == "reasoning":
                if getattr(item, "content", None):
                    thinking += " ".join(
                        entry.text for entry in item.content if getattr(entry, "text", None)
                    )
                if getattr(item, "summary", None):
                    if thinking:
                        thinking += " "
                    thinking += " ".join(
                        summary.text for summary in item.summary if getattr(summary, "text", None)
                    )
            elif item.type == "function_call":
                tool_calls.append(
                    ToolCall(
                        id=self._tool_call_identifier(item),
                        name=item.name,
                        arguments=self._parse_tool_arguments(item.arguments),
                    )
                )

        if response_model and content:
            try:
                parsed_obj = response_model.model_validate_json(content)
            except Exception:
                pass

        usage_data = response.usage
        reasoning_tokens = getattr(usage_data.output_tokens_details, "reasoning_tokens", 0)
        usage = UsageStats(
            input_tokens=usage_data.input_tokens,
            output_tokens=usage_data.output_tokens,
            completion_tokens=usage_data.output_tokens - reasoning_tokens,
            total_tokens=usage_data.total_tokens
        )

        return LLMResponse(
            content=content,
            thinking=thinking if thinking else None,
            tool_calls=tool_calls,
            usage=usage,
            raw_dump=response.model_dump(),
            metadata={"model": self.model_name, "provider": "openai"},
            parsed=parsed_obj
        )

    def generate(self, request: LLMRequest) -> LLMResponse:
        response = self.client.responses.create(**self._build_create_kwargs(request))
        return self._map_response(response, request.response_model)

    async def agenerate(self, request: LLMRequest) -> LLMResponse:
        response = await self.async_client.responses.create(**self._build_create_kwargs(request))
        return self._map_response(response, request.response_model)

    def stream(self, request: LLMRequest) -> Generator[LLMResponse, None, None]:
        stream = self.client.responses.create(**self._build_create_kwargs(request, stream=True))
        stream_state = self._create_stream_state()
        for event in stream:
            mapped_event = self._map_stream_event(event, request.response_model, stream_state)
            if mapped_event is not None:
                yield mapped_event

    async def astream(self, request: LLMRequest) -> AsyncGenerator[LLMResponse, None]:
        stream = await self.async_client.responses.create(**self._build_create_kwargs(request, stream=True))
        stream_state = self._create_stream_state()
        async for event in stream:
            mapped_event = self._map_stream_event(event, request.response_model, stream_state)
            if mapped_event is not None:
                yield mapped_event
