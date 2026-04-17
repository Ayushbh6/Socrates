import pytest
from unittest.mock import MagicMock, AsyncMock, patch
from backend.src.providers.gemini_adapter import GeminiAdapter
from backend.src.core.schema import (
    LLMRequest, 
    Message, 
    MessageRole, 
    ToolCall,
    ThinkingLevel, 
    GenConfig
)
from google.genai import types

@pytest.fixture
def mock_genai_client():
    with patch("backend.src.providers.gemini_adapter.genai.Client") as mock:
        yield mock

def test_prepare_input_mapping():
    """Verify that LLMRequest is correctly mapped to Gemini Content list."""
    adapter = GeminiAdapter(model_name="gemini-2.5-pro", api_key="test-key")
    
    request = LLMRequest(
        system_prompt="You are a unit test helper.",
        query="Hello!",
        history=[
            Message(role=MessageRole.USER, content="Past hi"),
            Message(role=MessageRole.ASSISTANT, content="Past hello")
        ],
        config=GenConfig(thinking=ThinkingLevel.LOW)
    )
    
    gemini_input = adapter._prepare_input(request)
    
    assert len(gemini_input) == 3
    assert gemini_input[0].role == "user"
    assert gemini_input[0].parts[0].text == "Past hi"
    assert gemini_input[1].role == "model"
    assert gemini_input[1].parts[0].text == "Past hello"
    assert gemini_input[2].role == "user"
    assert gemini_input[2].parts[0].text == "Hello!"

def test_thinking_level_mapping():
    """Verify that ThinkingLevel enum maps to correct Gemini ThinkingConfig."""
    adapter = GeminiAdapter(model_name="gemini-2.5-pro", api_key="test-key")
    
    off_config = adapter._map_thinking_level(ThinkingLevel.OFF)
    assert off_config.include_thoughts
    assert off_config.thinking_level == types.ThinkingLevel.MINIMAL
    
    low_config = adapter._map_thinking_level(ThinkingLevel.LOW)
    assert low_config.include_thoughts
    assert low_config.thinking_level == types.ThinkingLevel.LOW
    
    high_config = adapter._map_thinking_level(ThinkingLevel.HIGH)
    assert high_config.include_thoughts
    assert high_config.thinking_level == types.ThinkingLevel.HIGH

def test_prepare_input_tool_call_mapping():
    """Verify assistant tool calls are replayed correctly."""
    adapter = GeminiAdapter(model_name="gemini-2.5-pro", api_key="test-key")

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

    gemini_input = adapter._prepare_input(request)

    assert len(gemini_input) == 2
    assert gemini_input[0].role == "model"
    assert gemini_input[0].parts[0].function_call.name == "get_weather"
    assert gemini_input[0].parts[0].function_call.args == {"city": "Paris"}

def test_prepare_input_tool_response_mapping():
    """Verify tool responses are mapped correctly."""
    adapter = GeminiAdapter(model_name="gemini-2.5-pro", api_key="test-key")

    request = LLMRequest(
        system_prompt="You are a unit test helper.",
        query="Continue",
        history=[
            Message(
                role=MessageRole.TOOL,
                tool_call_id="get_weather",
                content='{"temp": 20}'
            )
        ],
    )

    gemini_input = adapter._prepare_input(request)

    assert len(gemini_input) == 2
    assert gemini_input[0].role == "user"
    assert gemini_input[0].parts[0].function_response.name == "get_weather"
    assert gemini_input[0].parts[0].function_response.response == {"temp": 20}

def test_generate_sync(mock_genai_client):
    """Verify sync generate call uses correct parameters."""
    mock_instance = mock_genai_client.return_value
    
    # Create a complex mock for the response
    mock_response = MagicMock()
    mock_response.candidates = []
    mock_response.usage_metadata = MagicMock()
    mock_response.usage_metadata.prompt_token_count = 10
    mock_response.usage_metadata.candidates_token_count = 20
    mock_response.usage_metadata.total_token_count = 30
    mock_response.usage_metadata.thoughts_token_count = 0
    mock_response.model_dump.return_value = {"status": "mocked"}
    
    mock_instance.models.generate_content.return_value = mock_response
    
    adapter = GeminiAdapter(model_name="gemini-2.5-pro", api_key="test-key")
    request = LLMRequest(
        system_prompt="Test instructions",
        query="Test query",
        config=GenConfig(thinking=ThinkingLevel.HIGH)
    )
    
    adapter.generate(request)
    
    args, kwargs = mock_instance.models.generate_content.call_args
    assert kwargs["model"] == "gemini-2.5-pro"
    assert kwargs["config"].system_instruction == "Test instructions"
    assert kwargs["config"].thinking_config.include_thoughts is True
    assert kwargs["config"].thinking_config.thinking_level == types.ThinkingLevel.HIGH

@pytest.mark.asyncio
async def test_generate_async(mock_genai_client):
    """Verify async agenerate call uses correct parameters."""
    mock_instance = mock_genai_client.return_value
    
    mock_response = MagicMock()
    mock_response.candidates = []
    mock_response.usage_metadata = MagicMock()
    mock_response.usage_metadata.prompt_token_count = 10
    mock_response.usage_metadata.candidates_token_count = 20
    mock_response.usage_metadata.total_token_count = 30
    mock_response.usage_metadata.thoughts_token_count = 0
    mock_response.model_dump.return_value = {"status": "mocked"}
    
    mock_instance.aio.models.generate_content = AsyncMock(return_value=mock_response)
    
    adapter = GeminiAdapter(model_name="gemini-2.5-pro", api_key="test-key")
    request = LLMRequest(
        system_prompt="Async test",
        query="Async query",
        config=GenConfig(thinking=ThinkingLevel.MEDIUM)
    )
    
    await adapter.agenerate(request)
    
    args, kwargs = mock_instance.aio.models.generate_content.call_args
    assert kwargs["model"] == "gemini-2.5-pro"
    assert kwargs["config"].system_instruction == "Async test"
    assert kwargs["config"].thinking_config.include_thoughts is True
    assert kwargs["config"].thinking_config.thinking_level == types.ThinkingLevel.MEDIUM
