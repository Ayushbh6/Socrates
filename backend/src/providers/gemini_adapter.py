import base64
import os
import json
from typing import List, Any, Dict, Optional, Generator, AsyncGenerator
from google import genai
from google.genai import types

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

@ProviderFactory.register("gemini")
class GeminiAdapter(BaseProvider):
    def __init__(self, model_name: str, **kwargs: Any):
        super().__init__(model_name, **kwargs)
        settings = get_settings()
        # Fallback to direct env vars if settings doesn't have them yet
        api_key = kwargs.get("api_key") or getattr(settings, "gemini_api_key", None) or os.environ.get("GEMINI_API_KEY")
        
        self.client = genai.Client(api_key=api_key)

    def _prepare_input(self, request: LLMRequest) -> List[types.Content]:
        gemini_input = []
        
        # We need a way to find the function name for a tool response
        # Since our Message schema only has tool_call_id (which is the call ID),
        # we might need to look back in history to find the corresponding name.
        call_id_to_name = {}
        for msg in request.history:
            if msg.role == MessageRole.ASSISTANT and msg.tool_calls:
                for tc in msg.tool_calls:
                    call_id_to_name[tc.id] = tc.name

        for msg in request.history:
            if msg.role == MessageRole.TOOL:
                func_name = call_id_to_name.get(msg.tool_call_id) or msg.tool_call_id or "unknown"
                gemini_input.append(
                    types.Content(
                        role="user",
                        parts=[
                            types.Part(
                                function_response=types.FunctionResponse(
                                    name=func_name,
                                    id=msg.tool_call_id,
                                    # Wrap in "result" to match what model might expect or just the dict
                                    response=self._parse_tool_arguments(msg.content)
                                )
                            )
                        ]
                    )
                )
            elif msg.role == MessageRole.ASSISTANT:
                parts = []
                if msg.content:
                    parts.append(types.Part.from_text(text=msg.content))
                if msg.tool_calls:
                    for tc in msg.tool_calls:
                        parts.append(types.Part(
                            function_call=types.FunctionCall(
                                name=tc.name,
                                args=tc.arguments,
                                id=tc.id
                            )
                        ))
                if parts:
                    gemini_input.append(types.Content(role="model", parts=parts))
            elif msg.role == MessageRole.USER:
                parts = []
                if msg.content:
                    parts.append(types.Part.from_text(text=msg.content))
                if msg.attachments:
                    for att in msg.attachments:
                        if att.mime_type.startswith("image/"):
                            img_data = att.content
                            if isinstance(img_data, str):
                                img_data = base64.b64decode(img_data)
                            parts.append(types.Part.from_bytes(data=img_data, mime_type=att.mime_type))
                if parts:
                    gemini_input.append(types.Content(role="user", parts=parts))

        # Add the current query
        current_parts = [types.Part.from_text(text=request.query)]
        if request.attachments:
            for att in request.attachments:
                if att.mime_type.startswith("image/"):
                    img_data = att.content
                    if isinstance(img_data, str):
                        img_data = base64.b64decode(img_data)
                    current_parts.append(types.Part.from_bytes(data=img_data, mime_type=att.mime_type))
        
        gemini_input.append(types.Content(role="user", parts=current_parts))
        
        return gemini_input

    def _prepare_tools(self, tools: Optional[List[ToolDefinition]]) -> Optional[List[types.Tool]]:
        if not tools:
            return None
        declarations = []
        for t in tools:
            declarations.append(types.FunctionDeclaration(
                name=t.name,
                description=t.description,
                parameters=t.parameters
            ))
        return [types.Tool(function_declarations=declarations)]

    def _map_thinking_level(self, level: ThinkingLevel) -> types.ThinkingConfig:
        """Maps unified ThinkingLevel to Gemini's ThinkingConfig."""
        mapping = {
            ThinkingLevel.OFF: types.ThinkingLevel.MINIMAL,
            ThinkingLevel.LOW: types.ThinkingLevel.LOW,
            ThinkingLevel.MEDIUM: types.ThinkingLevel.MEDIUM,
            ThinkingLevel.HIGH: types.ThinkingLevel.HIGH
        }
        return types.ThinkingConfig(
            include_thoughts=True,
            thinking_level=mapping.get(level, types.ThinkingLevel.HIGH)
        )

    def _build_config(self, request: LLMRequest) -> types.GenerateContentConfig:
        config_kwargs: Dict[str, Any] = {
            "system_instruction": request.system_prompt,
            "temperature": request.config.temperature,
            "top_p": request.config.top_p,
        }

        if request.config.max_tokens is not None:
            config_kwargs["max_output_tokens"] = request.config.max_tokens

        if request.config.stop_sequences:
            config_kwargs["stop_sequences"] = request.config.stop_sequences

        tools = self._prepare_tools(request.tools)
        if tools:
            config_kwargs["tools"] = tools

        config_kwargs["thinking_config"] = self._map_thinking_level(request.config.thinking)

        if request.response_model:
            config_kwargs["response_mime_type"] = "application/json"
            config_kwargs["response_schema"] = request.response_model.model_json_schema()

        return types.GenerateContentConfig(**config_kwargs)

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

    def _create_stream_state(self) -> Dict[str, Any]:
        return {"tool_calls": {}, "full_content": ""}

    def _map_stream_event(
        self,
        chunk: Any,
        response_model: Optional[Any] = None,
        stream_state: Optional[Dict[str, Any]] = None,
    ) -> Optional[LLMResponse]:
        """
        Maps a Gemini stream chunk to our unified LLMResponse.
        Gemini chunks aggregate tool_call arguments.
        """
        metadata = {"model": self.model_name, "provider": "gemini"}
        stream_state = stream_state or self._create_stream_state()
        
        content = ""
        thinking = ""
        tool_calls = []

        if chunk.candidates and chunk.candidates[0].content and chunk.candidates[0].content.parts:
            for part in chunk.candidates[0].content.parts:
                if getattr(part, "thought", False):
                    thinking += part.text or ""
                elif part.function_call:
                    tool_calls.append(
                        ToolCall(
                            id=getattr(part.function_call, "id", None) or part.function_call.name,
                            name=part.function_call.name,
                            arguments=self._parse_tool_arguments(part.function_call.args)
                        )
                    )
                elif part.text:
                    content += part.text

        # Aggregate content for structured parsing
        if content:
            stream_state["full_content"] += content

        # Get Usage if available (usually on the last chunk)
        usage = UsageStats()
        if chunk.usage_metadata:
            u = chunk.usage_metadata
            thoughts_tokens = u.thoughts_token_count or 0
            usage = UsageStats(
                input_tokens=u.prompt_token_count or 0,
                output_tokens=u.candidates_token_count or 0,
                completion_tokens=(u.candidates_token_count or 0) - thoughts_tokens,
                total_tokens=u.total_token_count or 0
            )

        if not content and not thinking and not tool_calls and not chunk.usage_metadata:
            return None

        parsed_obj = None
        if response_model and stream_state["full_content"]:
            try:
                # Attempt parsing. For streaming, this might fail until the JSON is complete.
                parsed_obj = response_model.model_validate_json(stream_state["full_content"])
            except Exception:
                pass

        return LLMResponse(
            content=content,
            thinking=thinking if thinking else None,
            tool_calls=tool_calls,
            usage=usage,
            raw_dump=chunk.model_dump() if hasattr(chunk, "model_dump") else {},
            metadata=metadata,
            parsed=parsed_obj
        )

    def _map_response(self, response: Any, response_model: Optional[Any] = None) -> LLMResponse:
        content = ""
        thinking = ""
        tool_calls = []
        parsed_obj = None

        if response.candidates and response.candidates[0].content and response.candidates[0].content.parts:
            for part in response.candidates[0].content.parts:
                if getattr(part, "thought", False):
                    thinking += part.text or ""
                elif part.function_call:
                    tool_calls.append(
                        ToolCall(
                            id=getattr(part.function_call, "id", None) or part.function_call.name,
                            name=part.function_call.name,
                            arguments=self._parse_tool_arguments(part.function_call.args)
                        )
                    )
                elif part.text:
                    content += part.text

        if response_model and content:
            try:
                parsed_obj = response_model.model_validate_json(content)
            except Exception:
                pass

        usage = UsageStats()
        if response.usage_metadata:
            u = response.usage_metadata
            thoughts_tokens = u.thoughts_token_count or 0
            usage = UsageStats(
                input_tokens=u.prompt_token_count or 0,
                output_tokens=u.candidates_token_count or 0,
                completion_tokens=(u.candidates_token_count or 0) - thoughts_tokens,
                total_tokens=u.total_token_count or 0
            )

        return LLMResponse(
            content=content,
            thinking=thinking if thinking else None,
            tool_calls=tool_calls,
            usage=usage,
            raw_dump=response.model_dump() if hasattr(response, "model_dump") else {},
            metadata={"model": self.model_name, "provider": "gemini"},
            parsed=parsed_obj
        )

    def generate(self, request: LLMRequest) -> LLMResponse:
        response = self.client.models.generate_content(
            model=self.model_name,
            contents=self._prepare_input(request),
            config=self._build_config(request)
        )
        return self._map_response(response, request.response_model)

    async def agenerate(self, request: LLMRequest) -> LLMResponse:
        response = await self.client.aio.models.generate_content(
            model=self.model_name,
            contents=self._prepare_input(request),
            config=self._build_config(request)
        )
        return self._map_response(response, request.response_model)

    def stream(self, request: LLMRequest) -> Generator[LLMResponse, None, None]:
        stream = self.client.models.generate_content_stream(
            model=self.model_name,
            contents=self._prepare_input(request),
            config=self._build_config(request)
        )
        stream_state = self._create_stream_state()
        for chunk in stream:
            mapped_event = self._map_stream_event(chunk, request.response_model, stream_state)
            if mapped_event is not None:
                yield mapped_event

    async def astream(self, request: LLMRequest) -> AsyncGenerator[LLMResponse, None]:
        stream = await self.client.aio.models.generate_content_stream(
            model=self.model_name,
            contents=self._prepare_input(request),
            config=self._build_config(request)
        )
        stream_state = self._create_stream_state()
        async for chunk in stream:
            mapped_event = self._map_stream_event(chunk, request.response_model, stream_state)
            if mapped_event is not None:
                yield mapped_event
