import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import BaseModel

from backend.src.core.schema import (
    Attachment,
    GenConfig,
    LLMRequest,
    Message,
    MessageRole,
    ThinkingLevel,
    ToolCall,
    ToolDefinition,
)
from backend.src.providers.ollama_adapter import OllamaAdapter


class FinalOutput(BaseModel):
    final_answer: str
    confidence_score: int


@pytest.fixture
def adapter() -> OllamaAdapter:
    return OllamaAdapter(model_name="llama3.2", host="http://localhost:11434")


def test_init_local_and_cloud_auth_headers():
    with patch("backend.src.providers.ollama_adapter.Client") as mock_client, patch(
        "backend.src.providers.ollama_adapter.AsyncClient"
    ) as mock_async_client:
        OllamaAdapter(model_name="llama3.2", host="http://localhost:11434")
        OllamaAdapter(model_name="gpt-oss:latest", host="https://ollama.com", api_key="cloud-key")

    assert mock_client.call_args_list[0].kwargs == {"host": "http://localhost:11434", "headers": None}
    assert mock_async_client.call_args_list[0].kwargs == {"host": "http://localhost:11434", "headers": None}
    assert mock_client.call_args_list[1].kwargs == {
        "host": "https://ollama.com",
        "headers": {"Authorization": "Bearer cloud-key"},
    }
    assert mock_async_client.call_args_list[1].kwargs == {
        "host": "https://ollama.com",
        "headers": {"Authorization": "Bearer cloud-key"},
    }


def test_prepare_input_maps_text_images_tool_calls_and_tool_results(adapter: OllamaAdapter):
    image_data = base64.b64encode(b"fake-image-bytes").decode("utf-8")
    request = LLMRequest(
        system_prompt="You are a helper.",
        query="What is in the image?",
        attachments=[Attachment(mime_type="image/png", content=image_data)],
        history=[
            Message(role=MessageRole.USER, content="Hello"),
                Message(
                    role=MessageRole.ASSISTANT,
                    content="Let me check",
                    thinking="Need to inspect first",
                    tool_calls=[
                        ToolCall(id="tool_1", name="look_up", arguments={"target": "image"}),
                    ],
                ),
            Message(role=MessageRole.TOOL, tool_call_id="tool_1", content='{"result":"done"}'),
        ],
    )

    messages = adapter._prepare_input(request)

    assert messages[0] == {"role": "system", "content": "You are a helper."}
    assert messages[1] == {"role": "user", "content": "Hello"}
    assert messages[2]["role"] == "assistant"
    assert messages[2]["thinking"] == "Need to inspect first"
    assert messages[2]["tool_calls"] == [
        {"function": {"name": "look_up", "arguments": {"target": "image"}}}
    ]
    assert messages[3] == {"role": "tool", "tool_name": "look_up", "content": '{"result":"done"}'}
    assert messages[4]["role"] == "user"
    assert messages[4]["content"] == "What is in the image?"
    assert messages[4]["images"] == [image_data]


def test_prepare_input_tool_name_falls_back_to_tool_call_id(adapter: OllamaAdapter):
    request = LLMRequest(
        system_prompt="You are a helper.",
        query="Continue",
        history=[
            Message(role=MessageRole.TOOL, tool_call_id="missing_name", content="{}"),
        ],
    )

    messages = adapter._prepare_input(request)

    assert messages[1] == {"role": "tool", "tool_name": "missing_name", "content": "{}"}


def test_thinking_resolution_for_boolean_and_gpt_oss():
    adapter = OllamaAdapter(model_name="llama3.2", host="http://localhost:11434")
    assert adapter._thinking_profile() == "boolean"
    assert adapter._resolve_think_parameter(ThinkingLevel.OFF) is False
    assert adapter._resolve_think_parameter(ThinkingLevel.HIGH) is True

    gpt_oss_adapter = OllamaAdapter(model_name="gpt-oss:20b", host="http://localhost:11434")
    assert gpt_oss_adapter._thinking_profile() == "discrete_levels"
    assert gpt_oss_adapter._resolve_think_parameter(ThinkingLevel.LOW) == "low"
    with pytest.raises(ValueError, match="does not support thinking level 'off'"):
        gpt_oss_adapter._resolve_think_parameter(ThinkingLevel.OFF)


def test_map_response_generates_synthetic_tool_call_ids(adapter: OllamaAdapter):
    response = SimpleNamespace(
        message=SimpleNamespace(
            content='{"final_answer":"Paris is sunny","confidence_score":88}',
            thinking="Need weather",
            tool_calls=[
                SimpleNamespace(function=SimpleNamespace(name="get_weather", arguments={"city": "Paris"})),
                SimpleNamespace(function=SimpleNamespace(name="get_distance", arguments={"origin": "London"})),
            ],
        ),
        prompt_eval_count=12,
        eval_count=7,
        model_dump=lambda: {"status": "ok"},
    )

    mapped = adapter._map_response(response, FinalOutput)

    assert mapped.parsed is not None
    assert mapped.parsed.final_answer == "Paris is sunny"
    assert [tool_call.id for tool_call in mapped.tool_calls] == ["ollama_call_1_0", "ollama_call_1_1"]
    assert mapped.usage.input_tokens == 12
    assert mapped.usage.output_tokens == 7
    assert mapped.usage.completion_tokens == 7


def test_parse_structured_output_accepts_markdown_fenced_json(adapter: OllamaAdapter):
    parsed = adapter._parse_structured_output(
        FinalOutput,
        '```json\n{"final_answer":"Paris is sunny","confidence_score":88}\n```',
    )

    assert parsed is not None
    assert parsed.final_answer == "Paris is sunny"
    assert parsed.confidence_score == 88


def test_map_stream_event_accumulates_content_thinking_and_tool_calls(adapter: OllamaAdapter):
    stream_state = adapter._create_stream_state()

    first_chunk = SimpleNamespace(
        message=SimpleNamespace(content='{"final_answer":"', thinking="Need weather", tool_calls=None),
        done=False,
        model_dump=lambda: {"chunk": 1},
    )
    second_chunk = SimpleNamespace(
        message=SimpleNamespace(
            content='Paris is sunny","confidence_score":88}',
            thinking="",
            tool_calls=[
                SimpleNamespace(function=SimpleNamespace(name="get_weather", arguments={"city": "Paris"}))
            ],
        ),
        done=True,
        prompt_eval_count=10,
        eval_count=5,
        model_dump=lambda: {"chunk": 2},
    )

    mapped_first = adapter._map_stream_event(first_chunk, FinalOutput, stream_state)
    mapped_second = adapter._map_stream_event(second_chunk, FinalOutput, stream_state)

    assert mapped_first is not None
    assert mapped_first.thinking == "Need weather"
    assert mapped_first.parsed is None

    assert mapped_second is not None
    assert mapped_second.parsed is not None
    assert mapped_second.parsed.confidence_score == 88
    assert mapped_second.tool_calls[0].id == "ollama_call_1_0"
    assert mapped_second.usage.total_tokens == 15


@pytest.mark.asyncio
async def test_agenerate_uses_two_phase_flow_for_tools_and_response_model():
    adapter = OllamaAdapter(
        model_name="llama3.2",
        host="http://localhost:11434",
        tool_handlers={
            "get_weather": lambda city: {"city": city, "temperature_c": 18, "condition": "sunny"},
        },
    )

    first_response = SimpleNamespace(
        message=SimpleNamespace(
            content="Fetching weather",
            thinking="Need weather",
            tool_calls=[
                SimpleNamespace(function=SimpleNamespace(name="get_weather", arguments={"city": "Paris"}))
            ],
        ),
        prompt_eval_count=10,
        eval_count=5,
        model_dump=lambda: {"phase": 1},
    )
    second_response = SimpleNamespace(
        message=SimpleNamespace(
            content="Paris is sunny and 18 C.",
            thinking=None,
            tool_calls=None,
        ),
        prompt_eval_count=11,
        eval_count=6,
        model_dump=lambda: {"phase": 2},
    )
    third_response = SimpleNamespace(
        message=SimpleNamespace(
            content='{"final_answer":"Paris is sunny and 18 C.","confidence_score":90}',
            thinking=None,
            tool_calls=None,
        ),
        prompt_eval_count=12,
        eval_count=7,
        model_dump=lambda: {"phase": 3},
    )

    adapter.async_client.chat = AsyncMock(side_effect=[first_response, second_response, third_response])

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
        system_prompt="You are a helper.",
        query="What is the weather in Paris?",
        tools=[weather_tool],
        response_model=FinalOutput,
        config=GenConfig(thinking=ThinkingLevel.MEDIUM),
    )

    response = await adapter.agenerate(request)

    assert response.parsed is not None
    assert response.parsed.final_answer == "Paris is sunny and 18 C."

    first_call = adapter.async_client.chat.call_args_list[0].kwargs
    second_call = adapter.async_client.chat.call_args_list[1].kwargs
    third_call = adapter.async_client.chat.call_args_list[2].kwargs

    assert "tools" in first_call
    assert "format" not in first_call
    assert "tools" in second_call
    assert "format" not in second_call
    assert "tools" not in third_call
    assert third_call["format"]["type"] == "object"


@pytest.mark.asyncio
async def test_astream_closes_underlying_stream_on_early_break(adapter: OllamaAdapter):
    class FakeStream:
        def __init__(self):
            self.closed = False
            self._yielded = False

        def __aiter__(self):
            return self

        async def __anext__(self):
            if self._yielded:
                raise StopAsyncIteration
            self._yielded = True
            return SimpleNamespace(
                message=SimpleNamespace(content='{"final_answer":"ok","confidence_score":42}', thinking=None, tool_calls=None),
                done=True,
                prompt_eval_count=1,
                eval_count=1,
                model_dump=lambda: {"chunk": 1},
            )

        async def aclose(self):
            self.closed = True

    fake_stream = FakeStream()
    adapter.async_client.chat = AsyncMock(return_value=fake_stream)

    request = LLMRequest(
        system_prompt="You are a helper.",
        query="Return JSON.",
        response_model=FinalOutput,
        config=GenConfig(thinking=ThinkingLevel.OFF),
    )

    stream = adapter.astream(request)
    async for response in stream:
        assert response.parsed is not None
        break
    await stream.aclose()

    assert fake_stream.closed is True
