import asyncio
import json
import time
from typing import Any, AsyncGenerator, Dict, List, Optional

from .. import providers as _providers  # noqa: F401
from ..core.factory import get_provider
from ..core.interfaces import BaseProvider
from ..core.schema import LLMRequest, LLMResponse, Message, MessageRole, ToolCall, UsageStats
from .events import AgentEvent, AgentEventType
from .schema import AgentRequest, AgentResult, AgentTurnTelemetry
from .tools import ToolExecutor, ToolHandler, execute_tool_call


class AgentRunner:
    def __init__(
        self,
        *,
        tool_executor: Optional[ToolExecutor] = None,
        tool_handlers: Optional[Dict[str, ToolHandler]] = None,
    ):
        self.tool_executor = tool_executor
        self.tool_handlers = tool_handlers or {}

    def run(self, request: AgentRequest) -> AgentResult:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.arun(request))
        raise RuntimeError("AgentRunner.run() cannot be used inside an active event loop. Use await arun(...).")

    async def arun(self, request: AgentRequest) -> AgentResult:
        final_result: Optional[AgentResult] = None
        async for event in self.stream(request):
            if event.type == AgentEventType.FINAL_RESPONSE and event.response is not None:
                final_result = AgentResult(
                    final_response=event.response,
                    tool_rounds=event.response.metadata.get("agent_tool_rounds", 0),
                    tools_called=event.response.metadata.get("agent_tools_called", []),
                    final_history=event.response.metadata.get("agent_final_history", []),
                    provider=event.provider,
                    model=event.model,
                    usage=event.response.metadata.get("agent_usage", UsageStats()),
                    elapsed_ms=event.response.metadata.get("agent_elapsed_ms", 0.0),
                    turns=event.response.metadata.get("agent_turn_telemetry", []),
                )

        if final_result is None:
            raise RuntimeError("Agent stream completed without a final response.")
        return final_result

    async def stream(self, request: AgentRequest) -> AsyncGenerator[AgentEvent, None]:
        provider = get_provider(request.model, **request.provider_kwargs)
        provider_name = self._provider_name(provider)
        history = list(request.history)
        active_query = request.query
        active_attachments = request.attachments
        initial_recorded = self._has_initial_user_message(history, request)
        all_tool_calls: List[ToolCall] = []
        tool_rounds = 0
        consecutive_failures = 0
        final_response: Optional[LLMResponse] = None
        run_started_at = time.perf_counter()
        aggregated_usage = UsageStats()
        turn_telemetry: List[AgentTurnTelemetry] = []

        for round_index in range(request.agent.max_tool_rounds):
            tool_rounds = round_index + 1
            turn_request = self._create_turn_request(
                request,
                history=history,
                query=active_query,
                attachments=active_attachments,
                response_model=None,
                tools=request.tools,
            )
            turn_started_at = time.perf_counter()
            turn_response: Optional[LLMResponse] = None
            turn_stream = provider.astream(turn_request)
            try:
                async for chunk in turn_stream:
                    turn_response = self._merge_responses(turn_response, chunk)

                    if chunk.thinking and request.agent.emit_thinking:
                        yield AgentEvent(
                            type=AgentEventType.THINKING,
                            provider=provider_name,
                            model=request.model,
                            round_index=round_index,
                            response=chunk,
                        )
                    if chunk.content:
                        yield AgentEvent(
                            type=AgentEventType.CONTENT,
                            provider=provider_name,
                            model=request.model,
                            round_index=round_index,
                            response=chunk,
                        )
                    for tool_call in chunk.tool_calls:
                        yield AgentEvent(
                            type=AgentEventType.TOOL_CALL,
                            provider=provider_name,
                            model=request.model,
                            round_index=round_index,
                            response=chunk,
                            tool_call=tool_call,
                        )
            finally:
                await turn_stream.aclose()

            if turn_response is None:
                turn_response = await provider.agenerate(turn_request)

            elapsed_ms = (time.perf_counter() - turn_started_at) * 1000
            aggregated_usage = self._add_usage(aggregated_usage, turn_response.usage)
            turn_telemetry.append(
                AgentTurnTelemetry(
                    round_index=round_index,
                    phase="tool",
                    elapsed_ms=elapsed_ms,
                    usage=turn_response.usage,
                    tool_call_count=len(turn_response.tool_calls),
                    parsed_output=turn_response.parsed is not None,
                    had_thinking=bool(turn_response.thinking),
                )
            )

            assistant_message = self._assistant_message_from_response(turn_response)
            if turn_response.tool_calls:
                if not initial_recorded:
                    history.append(self._initial_user_message(request))
                    initial_recorded = True

                if assistant_message is not None:
                    history.append(assistant_message)
                    yield AgentEvent(
                        type=AgentEventType.ASSISTANT_MESSAGE,
                        provider=provider_name,
                        model=request.model,
                        round_index=round_index,
                        message=assistant_message,
                    )

                round_failed = False
                round_succeeded = False
                for tool_call in turn_response.tool_calls:
                    all_tool_calls.append(tool_call)
                    tool_result = await execute_tool_call(
                        tool_call,
                        tool_executor=self.tool_executor,
                        tool_handlers=self.tool_handlers,
                    )
                    history.append(
                        Message(
                            role=MessageRole.TOOL,
                            tool_call_id=tool_call.id,
                            content=tool_result,
                        )
                    )
                    if request.agent.emit_tool_results:
                        yield AgentEvent(
                            type=AgentEventType.TOOL_RESULT,
                            provider=provider_name,
                            model=request.model,
                            round_index=round_index,
                            tool_call=tool_call,
                            tool_result=tool_result,
                        )

                    if self._tool_result_ok(tool_result):
                        round_succeeded = True
                    else:
                        round_failed = True

                if round_succeeded:
                    consecutive_failures = 0
                elif round_failed:
                    consecutive_failures += 1

                if consecutive_failures >= request.agent.max_consecutive_failures:
                    yield AgentEvent(
                        type=AgentEventType.ERROR,
                        provider=provider_name,
                        model=request.model,
                        round_index=round_index,
                        error=(
                            "Stopping after repeated consecutive tool failures. "
                            "The tool loop reached the configured failure limit."
                        ),
                    )
                    break

                active_query = self._continue_tool_query()
                active_attachments = None
                continue

            if assistant_message is not None:
                if not initial_recorded:
                    history.append(self._initial_user_message(request))
                    initial_recorded = True
                history.append(assistant_message)
                yield AgentEvent(
                    type=AgentEventType.ASSISTANT_MESSAGE,
                    provider=provider_name,
                    model=request.model,
                    round_index=round_index,
                    message=assistant_message,
                )

            final_response = turn_response
            break
        else:
            yield AgentEvent(
                type=AgentEventType.ERROR,
                provider=provider_name,
                model=request.model,
                round_index=tool_rounds,
                error="Stopping after reaching max_tool_rounds.",
            )

        if (
            request.response_model
            and request.agent.force_structured_output_final_pass
            and (final_response is None or final_response.parsed is None)
        ):
            final_request = self._create_final_structured_request(request, history)
            structured_response: Optional[LLMResponse] = None
            final_started_at = time.perf_counter()
            final_stream = provider.astream(final_request)
            try:
                async for chunk in final_stream:
                    structured_response = self._merge_responses(structured_response, chunk)

                    if chunk.thinking and request.agent.emit_thinking:
                        yield AgentEvent(
                            type=AgentEventType.THINKING,
                            provider=provider_name,
                            model=request.model,
                            round_index=tool_rounds,
                            response=chunk,
                        )
                    if chunk.content:
                        yield AgentEvent(
                            type=AgentEventType.CONTENT,
                            provider=provider_name,
                            model=request.model,
                            round_index=tool_rounds,
                            response=chunk,
                        )
                    for tool_call in chunk.tool_calls:
                        yield AgentEvent(
                            type=AgentEventType.TOOL_CALL,
                            provider=provider_name,
                            model=request.model,
                            round_index=tool_rounds,
                            response=chunk,
                            tool_call=tool_call,
                        )
            finally:
                await final_stream.aclose()

            if structured_response is None:
                structured_response = await provider.agenerate(final_request)

            final_response = structured_response
            elapsed_ms = (time.perf_counter() - final_started_at) * 1000
            aggregated_usage = self._add_usage(aggregated_usage, final_response.usage)
            turn_telemetry.append(
                AgentTurnTelemetry(
                    round_index=tool_rounds,
                    phase="final_structured_output",
                    elapsed_ms=elapsed_ms,
                    usage=final_response.usage,
                    tool_call_count=len(final_response.tool_calls),
                    parsed_output=final_response.parsed is not None,
                    had_thinking=bool(final_response.thinking),
                )
            )

            assistant_message = self._assistant_message_from_response(final_response)
            if assistant_message is not None:
                history.append(assistant_message)
                yield AgentEvent(
                    type=AgentEventType.ASSISTANT_MESSAGE,
                    provider=provider_name,
                    model=request.model,
                    round_index=tool_rounds,
                    message=assistant_message,
                )

        if final_response is None:
            final_response = LLMResponse(
                content="",
                usage=UsageStats(),
                raw_dump={},
                metadata={"model": provider.model_name, "provider": provider_name},
            )

        final_response.metadata = {
            **final_response.metadata,
            "agent_tool_rounds": tool_rounds,
            "agent_tools_called": all_tool_calls,
            "agent_final_history": history,
            "agent_usage": aggregated_usage,
            "agent_turn_telemetry": turn_telemetry,
            "agent_elapsed_ms": (time.perf_counter() - run_started_at) * 1000,
        }

        yield AgentEvent(
            type=AgentEventType.FINAL_RESPONSE,
            provider=provider_name,
            model=request.model,
            round_index=tool_rounds,
            response=final_response,
        )

    def _provider_name(self, provider: BaseProvider) -> str:
        return provider.__class__.__name__.removesuffix("Adapter").lower()

    def _create_turn_request(
        self,
        request: AgentRequest,
        *,
        history: List[Message],
        query: str,
        attachments: Optional[List[Any]],
        response_model: Optional[Any],
        tools: Optional[List[Any]],
    ) -> LLMRequest:
        return LLMRequest(
            system_prompt=request.system_prompt,
            query=query,
            history=history,
            attachments=attachments,
            tools=tools,
            response_model=response_model,
            input_mode=request.input_mode,
            config=request.config,
        )

    def _create_final_structured_request(self, request: AgentRequest, history: List[Message]) -> LLMRequest:
        schema_json = json.dumps(
            request.response_model.model_json_schema(),
            ensure_ascii=True,
            separators=(",", ":"),
        )
        final_query = (
            "Based on the conversation and tool results above, return only a valid JSON object "
            "that matches this JSON schema exactly. Do not include markdown fences, prose, or "
            "extra keys. Use these exact field names and types.\n\n"
            f"JSON schema:\n{schema_json}"
        )
        final_config = request.config.model_copy(update={"temperature": 0})
        return LLMRequest(
            system_prompt=request.system_prompt,
            query=final_query,
            history=history,
            response_model=request.response_model,
            input_mode=request.input_mode,
            config=final_config,
        )

    def _merge_responses(self, aggregate: Optional[LLMResponse], chunk: LLMResponse) -> LLMResponse:
        if aggregate is None:
            return LLMResponse(
                content=chunk.content,
                thinking=chunk.thinking,
                tool_calls=list(chunk.tool_calls),
                usage=chunk.usage,
                raw_dump=chunk.raw_dump,
                metadata=dict(chunk.metadata),
                parsed=chunk.parsed,
            )

        content = aggregate.content + chunk.content
        thinking = (aggregate.thinking or "") + (chunk.thinking or "")
        seen_ids = {tool_call.id for tool_call in aggregate.tool_calls}
        tool_calls = list(aggregate.tool_calls)
        for tool_call in chunk.tool_calls:
            if tool_call.id not in seen_ids:
                tool_calls.append(tool_call)
                seen_ids.add(tool_call.id)

        usage = chunk.usage if chunk.usage.total_tokens else aggregate.usage
        parsed = chunk.parsed or aggregate.parsed

        return LLMResponse(
            content=content,
            thinking=thinking or None,
            tool_calls=tool_calls,
            usage=usage,
            raw_dump=chunk.raw_dump or aggregate.raw_dump,
            metadata=chunk.metadata or aggregate.metadata,
            parsed=parsed,
        )

    def _assistant_message_from_response(self, response: LLMResponse) -> Optional[Message]:
        if not response.content and not response.thinking and not response.tool_calls:
            return None
        return Message(
            role=MessageRole.ASSISTANT,
            content=response.content or None,
            thinking=response.thinking,
            tool_calls=response.tool_calls or None,
        )

    def _initial_user_message(self, request: AgentRequest) -> Message:
        return Message(
            role=MessageRole.USER,
            content=request.query,
            attachments=request.attachments,
        )

    def _has_initial_user_message(self, history: List[Message], request: AgentRequest) -> bool:
        return any(
            msg.role == MessageRole.USER
            and msg.content == request.query
            and msg.attachments == request.attachments
            for msg in history
        )

    def _continue_tool_query(self) -> str:
        return "Continue using the available tool results until you are ready to answer."

    def _tool_result_ok(self, tool_result: str) -> bool:
        try:
            payload = json.loads(tool_result)
        except json.JSONDecodeError:
            return False
        return bool(payload.get("ok"))

    def _add_usage(self, left: UsageStats, right: UsageStats) -> UsageStats:
        return UsageStats(
            input_tokens=left.input_tokens + right.input_tokens,
            output_tokens=left.output_tokens + right.output_tokens,
            completion_tokens=left.completion_tokens + right.completion_tokens,
            total_tokens=left.total_tokens + right.total_tokens,
        )


async def arun_agent(
    request: AgentRequest,
    *,
    tool_executor: Optional[ToolExecutor] = None,
    tool_handlers: Optional[Dict[str, ToolHandler]] = None,
) -> AgentResult:
    runner = AgentRunner(tool_executor=tool_executor, tool_handlers=tool_handlers)
    return await runner.arun(request)


async def astream_agent(
    request: AgentRequest,
    *,
    tool_executor: Optional[ToolExecutor] = None,
    tool_handlers: Optional[Dict[str, ToolHandler]] = None,
) -> AsyncGenerator[AgentEvent, None]:
    runner = AgentRunner(tool_executor=tool_executor, tool_handlers=tool_handlers)
    async for event in runner.stream(request):
        yield event
