import pytest
from types import SimpleNamespace
from unittest.mock import MagicMock, AsyncMock, patch
from backend.src.providers.openai_adapter import OpenAIAdapter
from backend.src.core.schema import (
    LLMRequest, 
    Message, 
    MessageRole, 
    ToolCall,
    ToolDefinition,
    ThinkingLevel, 
    GenConfig
)

@pytest.fixture
def mock_openai_client():
    with patch("backend.src.providers.openai_adapter.OpenAI") as mock:
        yield mock

@pytest.fixture
def mock_async_openai_client():
    with patch("backend.src.providers.openai_adapter.AsyncOpenAI") as mock:
        yield mock

def test_prepare_input_mapping():
    """Verify that LLMRequest is correctly mapped to OpenAI Responses API items."""
    adapter = OpenAIAdapter(model_name="gpt-5.4-mini", api_key="test-key")
    
    request = LLMRequest(
        system_prompt="You are a unit test helper.",
        query="Hello!",
        history=[
            Message(role=MessageRole.USER, content="Past hi"),
            Message(role=MessageRole.ASSISTANT, content="Past hello")
        ],
        config=GenConfig(thinking=ThinkingLevel.LOW)
    )
    
    openai_input = adapter._prepare_input(request)
    
    # Assertions on mapping
    assert len(openai_input) == 3 # 2 history + 1 current
    assert openai_input[0]["role"] == "user"
    assert openai_input[0]["content"][0]["type"] == "input_text"
    assert openai_input[0]["content"][0]["text"] == "Past hi"
    assert openai_input[1]["role"] == "assistant"
    assert openai_input[1]["content"][0]["type"] == "output_text"
    assert openai_input[1]["content"][0]["text"] == "Past hello"
    assert openai_input[2]["role"] == "user"
    assert openai_input[2]["content"][0]["text"] == "Hello!"

def test_thinking_level_mapping():
    """Verify that ThinkingLevel enum maps to correct OpenAI strings."""
    adapter = OpenAIAdapter(model_name="gpt-5.4-mini", api_key="test-key")
    
    assert adapter._map_thinking_level(ThinkingLevel.OFF) == "none"
    assert adapter._map_thinking_level(ThinkingLevel.LOW) == "low"
    assert adapter._map_thinking_level(ThinkingLevel.MEDIUM) == "medium"
    assert adapter._map_thinking_level(ThinkingLevel.HIGH) == "high"

def test_prepare_input_tool_call_mapping():
    """Verify assistant tool calls are replayed with Responses API function_call input items."""
    adapter = OpenAIAdapter(model_name="gpt-5.4-mini", api_key="test-key")

    request = LLMRequest(
        system_prompt="You are a unit test helper.",
        query="Continue",
        history=[
            Message(
                role=MessageRole.ASSISTANT,
                tool_calls=[ToolCall(id="call_123", name="get_weather", arguments={"city": "Paris"})],
            )
        ],
    )

    openai_input = adapter._prepare_input(request)

    assert openai_input[0]["type"] == "function_call"
    assert openai_input[0]["call_id"] == "call_123"
    assert openai_input[0]["name"] == "get_weather"
    assert openai_input[0]["arguments"] == '{"city":"Paris"}'


def test_prepare_tools_does_not_force_strict_function_schema():
    adapter = OpenAIAdapter(model_name="gpt-5.4-mini", api_key="test-key")

    tools = [
        ToolDefinition(
            name="list_files",
            description="List project files.",
            parameters={
                "type": "object",
                "properties": {
                    "scope": {"type": "string"},
                    "path": {"type": "string", "default": "."},
                },
                "required": ["scope"],
            },
        )
    ]

    prepared = adapter._prepare_tools(tools)

    assert prepared is not None
    assert prepared[0]["name"] == "list_files"
    assert "strict" not in prepared[0]
    assert prepared[0]["parameters"]["required"] == ["scope"]

def test_map_stream_event_recovers_tool_name_from_output_item():
    """Verify streamed function-call args can be normalized even when the done event omits the function name."""
    adapter = OpenAIAdapter(model_name="gpt-5.4-mini", api_key="test-key")
    stream_state = adapter._create_stream_state()

    output_item_event = SimpleNamespace(
        type="response.output_item.added",
        item=SimpleNamespace(
            type="function_call",
            id="fc_123",
            call_id="call_123",
            name="get_weather",
            arguments="",
        ),
    )
    arguments_done_event = SimpleNamespace(
        type="response.function_call_arguments.done",
        item_id="fc_123",
        name=None,
        arguments='{"city":"Paris"}',
        model_dump=lambda: {"type": "response.function_call_arguments.done"},
    )

    adapter._map_stream_event(output_item_event, stream_state=stream_state)
    mapped = adapter._map_stream_event(arguments_done_event, stream_state=stream_state)

    assert mapped is not None
    assert mapped.tool_calls[0].id == "call_123"
    assert mapped.tool_calls[0].name == "get_weather"
    assert mapped.tool_calls[0].arguments == {"city": "Paris"}


def test_map_stream_completed_omits_duplicate_content_after_deltas():
    adapter = OpenAIAdapter(model_name="gpt-5.4-mini", api_key="test-key")
    stream_state = adapter._create_stream_state()

    delta_event = SimpleNamespace(
        type="response.output_text.delta",
        delta="Hello",
        model_dump=lambda: {"type": "response.output_text.delta"},
    )
    completed_event = SimpleNamespace(
        type="response.completed",
        response=SimpleNamespace(
            output=[
                SimpleNamespace(
                    type="message",
                    content=[SimpleNamespace(type="output_text", text="Hello")],
                )
            ],
            usage=SimpleNamespace(
                input_tokens=1,
                output_tokens=1,
                total_tokens=2,
                output_tokens_details=SimpleNamespace(reasoning_tokens=0),
            ),
            model_dump=lambda: {"type": "response.completed"},
        ),
    )

    adapter._map_stream_event(delta_event, stream_state=stream_state)
    mapped = adapter._map_stream_event(completed_event, stream_state=stream_state)

    assert mapped is not None
    assert mapped.content == ""

def test_generate_sync(mock_openai_client):
    """Verify sync generate call uses correct parameters."""
    mock_instance = mock_openai_client.return_value
    
    # Create a complex mock for the response
    mock_response = MagicMock()
    mock_response.output = []
    mock_response.usage = MagicMock()
    mock_response.usage.input_tokens = 10
    mock_response.usage.output_tokens = 20
    mock_response.usage.total_tokens = 30
    mock_response.usage.output_tokens_details.reasoning_tokens = 0
    mock_response.model_dump.return_value = {"status": "mocked"}
    
    mock_instance.responses.create.return_value = mock_response
    
    adapter = OpenAIAdapter(model_name="gpt-5.4-mini", api_key="test-key")
    request = LLMRequest(
        system_prompt="Test instructions",
        query="Test query",
        config=GenConfig(thinking=ThinkingLevel.HIGH)
    )
    
    adapter.generate(request)
    
    args, kwargs = mock_instance.responses.create.call_args
    assert kwargs["instructions"] == "Test instructions"
    assert kwargs["reasoning"]["effort"] == "high"

@pytest.mark.asyncio
async def test_generate_async(mock_async_openai_client):
    """Verify async agenerate call uses correct parameters."""
    mock_instance = mock_async_openai_client.return_value
    
    mock_response = MagicMock()
    mock_response.output = []
    mock_response.usage = MagicMock()
    mock_response.usage.input_tokens = 10
    mock_response.usage.output_tokens = 20
    mock_response.usage.total_tokens = 30
    mock_response.usage.output_tokens_details.reasoning_tokens = 0
    mock_response.model_dump.return_value = {"status": "mocked"}
    
    mock_instance.responses.create = AsyncMock(return_value=mock_response)
    
    adapter = OpenAIAdapter(model_name="gpt-5.4-mini", api_key="test-key")
    request = LLMRequest(
        system_prompt="Async test",
        query="Async query",
        config=GenConfig(thinking=ThinkingLevel.MEDIUM)
    )
    
    await adapter.agenerate(request)
    
    args, kwargs = mock_instance.responses.create.call_args
    assert kwargs["instructions"] == "Async test"
    assert kwargs["reasoning"]["effort"] == "medium"
