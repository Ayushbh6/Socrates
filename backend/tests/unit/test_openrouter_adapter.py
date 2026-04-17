import pytest
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from pydantic import BaseModel
from backend.src.providers.openrouter_adapter import OpenRouterAdapter
from backend.src.core.schema import (
    LLMRequest, Message, MessageRole, ToolDefinition, GenConfig, ThinkingLevel
)


class FinalOutput(BaseModel):
    final_answer: str
    confidence_score: int

@pytest.fixture
def adapter():
    return OpenRouterAdapter(model_name="test-model", api_key="test-key")

def test_prepare_input_with_thinking(adapter):
    history = [
        Message(role=MessageRole.USER, content="Hello"),
        Message(role=MessageRole.ASSISTANT, content="Hi", thinking="I should say hi"),
    ]
    request = LLMRequest(
        system_prompt="You are a helper",
        query="What is up?",
        history=history,
        config=GenConfig(thinking=ThinkingLevel.MEDIUM)
    )
    
    messages = adapter._prepare_input(request)
    
    assert messages[0] == {"role": "system", "content": "You are a helper"}
    assert messages[1] == {"role": "user", "content": "Hello"}
    assert messages[2] == {"role": "assistant", "content": "Hi", "reasoning": "I should say hi"}
    assert messages[3] == {"role": "user", "content": "What is up?"}

def test_build_create_kwargs_with_thinking_enabled(adapter):
    request = LLMRequest(
        system_prompt="sys",
        query="query",
        config=GenConfig(thinking=ThinkingLevel.MEDIUM)
    )
    
    kwargs = adapter._build_create_kwargs(request)
    
    assert kwargs["extra_body"] == {"reasoning": {"enabled": True}}

def test_build_create_kwargs_with_thinking_off(adapter):
    request = LLMRequest(
        system_prompt="sys",
        query="query",
        config=GenConfig(thinking=ThinkingLevel.OFF)
    )
    
    kwargs = adapter._build_create_kwargs(request)
    
    assert kwargs["extra_body"] == {"reasoning": {"enabled": False}}

def test_map_response_with_reasoning(adapter):
    mock_response = MagicMock()
    mock_response.choices = [MagicMock()]
    mock_response.choices[0].message.content = "Answer"
    mock_response.choices[0].message.reasoning = "Thinking process"
    mock_response.choices[0].message.tool_calls = None
    mock_response.usage.prompt_tokens = 10
    mock_response.usage.completion_tokens = 20
    mock_response.usage.total_tokens = 30
    mock_response.model_dump.return_value = {}
    
    llm_response = adapter._map_response(mock_response)
    
    assert llm_response.content == "Answer"
    assert llm_response.thinking == "Thinking process"
    assert llm_response.usage.input_tokens == 10
    assert llm_response.usage.output_tokens == 20

def test_map_stream_event_reconstructs_split_tool_call(adapter):
    stream_state = adapter._create_stream_state()

    first_chunk = SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(
                    content="",
                    reasoning=None,
                    tool_calls=[
                        SimpleNamespace(
                            index=0,
                            id="call_123",
                            function=SimpleNamespace(name=None, arguments="{"),
                        )
                    ],
                ),
                finish_reason=None,
            )
        ],
        usage=None,
        model_dump=lambda: {"chunk": 1},
    )
    second_chunk = SimpleNamespace(
        choices=[
            SimpleNamespace(
                delta=SimpleNamespace(
                    content="",
                    reasoning=None,
                    tool_calls=[
                        SimpleNamespace(
                            index=0,
                            id=None,
                            function=SimpleNamespace(name="get_weather", arguments='"city":"Paris"}'),
                        )
                    ],
                ),
                finish_reason="tool_calls",
            )
        ],
        usage=None,
        model_dump=lambda: {"chunk": 2},
    )

    assert adapter._map_stream_event(first_chunk, stream_state=stream_state) is None

    mapped = adapter._map_stream_event(second_chunk, stream_state=stream_state)

    assert mapped is not None
    assert mapped.tool_calls[0].id == "call_123"
    assert mapped.tool_calls[0].name == "get_weather"
    assert mapped.tool_calls[0].arguments == {"city": "Paris"}

@pytest.mark.asyncio
async def test_agenerate_uses_two_phase_flow_for_tools_and_response_model():
    adapter = OpenRouterAdapter(
        model_name="test-model",
        api_key="test-key",
        tool_handlers={"get_weather": lambda city: {"city": city, "temperature_c": 18, "condition": "sunny"}},
    )

    first_response = MagicMock()
    first_response.choices = [MagicMock()]
    first_response.choices[0].message.content = "Fetching weather"
    first_response.choices[0].message.reasoning = "Need weather"
    first_response.choices[0].message.tool_calls = [
        SimpleNamespace(
            id="call_123",
            function=SimpleNamespace(name="get_weather", arguments='{"city":"Paris"}'),
        )
    ]
    first_response.usage.prompt_tokens = 10
    first_response.usage.completion_tokens = 5
    first_response.usage.total_tokens = 15
    first_response.model_dump.return_value = {"phase": 1}

    second_response = MagicMock()
    second_response.choices = [MagicMock()]
    second_response.choices[0].message.content = "Paris is sunny and 18 C."
    second_response.choices[0].message.reasoning = None
    second_response.choices[0].message.tool_calls = None
    second_response.usage.prompt_tokens = 12
    second_response.usage.completion_tokens = 8
    second_response.usage.total_tokens = 20
    second_response.model_dump.return_value = {"phase": 2}

    third_response = MagicMock()
    third_response.choices = [MagicMock()]
    third_response.choices[0].message.content = '{"final_answer":"Paris is sunny and 18 C.","confidence_score":88}'
    third_response.choices[0].message.reasoning = None
    third_response.choices[0].message.tool_calls = None
    third_response.usage.prompt_tokens = 14
    third_response.usage.completion_tokens = 9
    third_response.usage.total_tokens = 23
    third_response.model_dump.return_value = {"phase": 3}

    adapter.async_client.chat.completions.create = AsyncMock(
        side_effect=[first_response, second_response, third_response]
    )

    weather_tool = ToolDefinition(
        name="get_weather",
        description="Get current weather for a city",
        parameters={
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    )

    request = LLMRequest(
        system_prompt="You are a helper",
        query="What is the weather in Paris?",
        tools=[weather_tool],
        response_model=FinalOutput,
        config=GenConfig(thinking=ThinkingLevel.MEDIUM),
    )

    response = await adapter.agenerate(request)

    assert response.parsed is not None
    assert response.parsed.final_answer == "Paris is sunny and 18 C."

    first_call = adapter.async_client.chat.completions.create.call_args_list[0].kwargs
    second_call = adapter.async_client.chat.completions.create.call_args_list[1].kwargs
    third_call = adapter.async_client.chat.completions.create.call_args_list[2].kwargs

    assert "tools" in first_call
    assert "response_format" not in first_call
    assert "tools" in second_call
    assert "response_format" not in second_call
    assert "tools" not in third_call
    assert third_call["response_format"]["type"] == "json_schema"
