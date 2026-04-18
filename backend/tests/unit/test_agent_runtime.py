import json
from types import SimpleNamespace

import pytest
from pydantic import BaseModel

from backend.src.agent import AgentRequest, AgentRunner
from backend.src.agent.events import AgentEventType
from backend.src.core.schema import GenConfig, LLMResponse, MessageRole, ThinkingLevel, ToolCall, ToolDefinition, UsageStats


class FinalOutput(BaseModel):
    final_answer: str
    confidence_score: int


class FakeAsyncStream:
    def __init__(self, chunks):
        self._chunks = list(chunks)
        self._index = 0
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._index >= len(self._chunks):
            raise StopAsyncIteration
        chunk = self._chunks[self._index]
        self._index += 1
        return chunk

    async def aclose(self):
        self.closed = True


class FakeProvider:
    def __init__(self, turns):
        self.model_name = "fake-model"
        self.turns = list(turns)
        self.requests = []
        self.streams = []

    async def agenerate(self, request):
        self.requests.append(request)
        return self.turns.pop(0)["fallback"]

    def astream(self, request):
        self.requests.append(request)
        turn = self.turns.pop(0)
        stream = FakeAsyncStream(turn["chunks"])
        self.streams.append(stream)
        return stream


@pytest.mark.asyncio
async def test_agent_request_defaults():
    request = AgentRequest(
        model="openai/gpt-5.4-mini",
        system_prompt="sys",
        query="hello",
    )

    assert request.agent.stream is True
    assert request.agent.emit_thinking is True
    assert request.agent.max_tool_rounds == 100
    assert request.provider_kwargs == {}


@pytest.mark.asyncio
async def test_agent_runner_streams_tool_loop_and_final_output(monkeypatch):
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Looking up weather.",
                        thinking="Need tool data.",
                        tool_calls=[ToolCall(id="call_1", name="get_weather", arguments={"city": "Paris"})],
                        usage=UsageStats(input_tokens=11, output_tokens=7, completion_tokens=5, total_tokens=18),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content='{"final_answer":"Paris is sunny","confidence_score":91}',
                        parsed=FinalOutput(final_answer="Paris is sunny", confidence_score=91),
                        usage=UsageStats(input_tokens=9, output_tokens=6, completion_tokens=6, total_tokens=15),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

    runner = AgentRunner(tool_handlers={"get_weather": lambda city: {"city": city, "temperature_c": 18}})
    request = AgentRequest(
        model="fake/fake-model",
        system_prompt="You are a helper.",
        query="What is the weather in Paris?",
        tools=[
            ToolDefinition(
                name="get_weather",
                description="Get weather",
                parameters={
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            )
        ],
        response_model=FinalOutput,
        config=GenConfig(thinking=ThinkingLevel.LOW),
    )

    events = [event async for event in runner.stream(request)]
    event_types = [event.type for event in events]

    assert AgentEventType.THINKING in event_types
    assert AgentEventType.CONTENT in event_types
    assert AgentEventType.TOOL_CALL in event_types
    assert AgentEventType.TOOL_RESULT in event_types
    assert AgentEventType.FINAL_RESPONSE in event_types

    tool_result_event = next(event for event in events if event.type == AgentEventType.TOOL_RESULT)
    assert json.loads(tool_result_event.tool_result)["ok"] is True

    final_event = next(event for event in events if event.type == AgentEventType.FINAL_RESPONSE)
    assert final_event.response is not None
    assert final_event.response.parsed is not None
    assert final_event.response.parsed.final_answer == "Paris is sunny"
    aggregated_usage = final_event.response.metadata["agent_usage"]
    assert aggregated_usage.input_tokens == 20
    assert aggregated_usage.output_tokens == 13
    assert aggregated_usage.completion_tokens == 11
    assert aggregated_usage.total_tokens == 33
    turn_telemetry = final_event.response.metadata["agent_turn_telemetry"]
    assert len(turn_telemetry) == 2
    assert turn_telemetry[0].phase == "tool"
    assert turn_telemetry[1].phase == "tool"
    assert turn_telemetry[0].tool_call_count == 1
    assert turn_telemetry[1].parsed_output is True
    assert final_event.response.metadata["agent_elapsed_ms"] >= 0


@pytest.mark.asyncio
async def test_agent_runner_returns_constructive_tool_failure(monkeypatch):
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Calling tool.",
                        tool_calls=[ToolCall(id="call_1", name="get_weather", arguments={})],
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content='{"final_answer":"Tool failed, handled gracefully","confidence_score":70}',
                        parsed=FinalOutput(final_answer="Tool failed, handled gracefully", confidence_score=70),
                        usage=UsageStats(total_tokens=9),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

    runner = AgentRunner(tool_handlers={"get_weather": lambda city: {"city": city}})
    request = AgentRequest(
        model="fake/fake-model",
        system_prompt="sys",
        query="Weather?",
        tools=[
            ToolDefinition(
                name="get_weather",
                description="Get weather",
                parameters={"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
            )
        ],
        response_model=FinalOutput,
    )

    events = [event async for event in runner.stream(request)]
    tool_error = next(event for event in events if event.type == AgentEventType.TOOL_RESULT)
    payload = json.loads(tool_error.tool_result)

    assert payload["ok"] is False
    assert payload["error_type"] == "validation_error"
    assert payload["retryable"] is True
    assert "Call the tool again" in payload["suggestion"]


@pytest.mark.asyncio
async def test_agent_runner_uses_final_structured_output_pass(monkeypatch):
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="Paris is sunny.",
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
            {
                "chunks": [
                    LLMResponse(
                        content='{"final_answer":"Paris is sunny","confidence_score":88}',
                        parsed=FinalOutput(final_answer="Paris is sunny", confidence_score=88),
                        usage=UsageStats(total_tokens=8),
                        raw_dump={"turn": 2},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            },
        ]
    )
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

    runner = AgentRunner()
    request = AgentRequest(
        model="fake/fake-model",
        system_prompt="sys",
        query="Answer in JSON.",
        response_model=FinalOutput,
    )

    result = await runner.arun(request)

    assert result.final_response.parsed is not None
    assert result.usage.total_tokens == 8
    assert len(result.turns) == 2
    assert result.turns[1].phase == "final_structured_output"
    assert len(provider.requests) == 2
    final_request = provider.requests[1]
    assert final_request.config.temperature == 0
    assert "JSON schema" in final_request.query
    assert final_request.tools is None


@pytest.mark.asyncio
async def test_agent_runner_closes_underlying_stream_on_early_break(monkeypatch):
    provider = FakeProvider(
        [
            {
                "chunks": [
                    LLMResponse(
                        content="chunk-1",
                        usage=UsageStats(),
                        raw_dump={"turn": 1},
                        metadata={"provider": "fake", "model": "fake-model"},
                    )
                ]
            }
        ]
    )
    monkeypatch.setattr("backend.src.agent.runtime.get_provider", lambda model, **kwargs: provider)

    runner = AgentRunner()
    request = AgentRequest(model="fake/fake-model", system_prompt="sys", query="hello")

    stream = runner.stream(request)
    async for event in stream:
        assert event.type == AgentEventType.CONTENT
        break
    await stream.aclose()

    assert provider.streams[0].closed is True
