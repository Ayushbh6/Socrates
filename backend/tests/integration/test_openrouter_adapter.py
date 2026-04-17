import json
import pytest
from openai import AuthenticationError
from pydantic import BaseModel, Field
from backend.src.providers.openrouter_adapter import OpenRouterAdapter
from backend.src.core.schema import (
    GenConfig,
    LLMRequest,
    Message,
    MessageRole,
    ThinkingLevel,
    ToolCall,
    ToolDefinition,
)
from backend.src.core.settings import get_settings

# 1. Define the Structured Output Schema
class FinalOutput(BaseModel):
    final_answer: str = Field(description="The final synthesized answer based on tool outputs.")
    confidence_score: int = Field(description="Confidence score from 1-100%")

def _debug(capsys: pytest.CaptureFixture[str], message: str) -> None:
    with capsys.disabled():
        print(message, flush=True)

def _execute_fake_tool(tool_call: ToolCall) -> dict[str, object]:
    if tool_call.name == "get_weather":
        city = tool_call.arguments["city"]
        return {
            "city": city,
            "temperature_c": 18,
            "condition": "sunny",
        }

    if tool_call.name == "get_distance":
        origin = tool_call.arguments["origin"]
        destination = tool_call.arguments["destination"]
        return {
            "origin": origin,
            "destination": destination,
            "distance_km": 344,
        }

    raise AssertionError(f"Unexpected tool call: {tool_call.name}")

@pytest.mark.asyncio
async def test_openrouter_integration(capsys: pytest.CaptureFixture[str]):
    """
    Integration test for OpenRouterAdapter using:
    1. Settings/.env-based credential loading
    2. A tool-capable OpenRouter model
    3. Tool calling (weather and distance)
    4. Structured Output parsing (FinalOutput)
    5. Asynchronous streaming (astream)
    """
    settings = get_settings()
    if not settings.openrouter_api_key:
        pytest.skip("OPENROUTER_API_KEY not found in settings or environment")

    model_name = "z-ai/glm-5.1:nitro"
    adapter = OpenRouterAdapter(model_name=model_name, tool_executor=_execute_fake_tool)

    weather_tool = ToolDefinition(
        name="get_weather",
        description="Get current weather for a city",
        parameters={
            "type": "object",
            "properties": {
                "city": {"type": "string"}
            },
            "required": ["city"]
        }
    )

    distance_tool = ToolDefinition(
        name="get_distance",
        description="Get distance between two cities",
        parameters={
            "type": "object",
            "properties": {
                "origin": {"type": "string"},
                "destination": {"type": "string"}
            },
            "required": ["origin", "destination"]
        }
    )

    request = LLMRequest(
        system_prompt="You are a helpful travel assistant. Use tools to provide accurate info.",
        query="What is the weather in Paris and how far is it from London? Provide the final answer in the requested structured format.",
        tools=[weather_tool, distance_tool],
        response_model=FinalOutput,
        config=GenConfig(thinking=ThinkingLevel.MEDIUM)
    )

    _debug(capsys, f"\n=== OpenRouter Integration Test [{model_name}] ===")
    _debug(capsys, f"Model: {adapter.model_name}")
    _debug(capsys, f"Query: {request.query}")
    _debug(capsys, f"Tools Available: {[tool.name for tool in request.tools or []]}")
    _debug(capsys, "--- Starting Adapter Stream ---")

    tools_called = False
    parsed_successfully = False

    try:
        async for response in adapter.astream(request):
            if response.thinking:
                _debug(capsys, f"[reasoning] {response.thinking}")

            if response.content:
                _debug(capsys, f"[content] {response.content}")

            if response.tool_calls:
                tools_called = True
                for tool_call in response.tool_calls:
                    _debug(
                        capsys,
                        f"[tool-call] {tool_call.name} args={tool_call.arguments} call_id={tool_call.id}",
                    )
                    _debug(capsys, f"[tool-result] {tool_call.name} -> {_execute_fake_tool(tool_call)}")

            if response.parsed:
                parsed_successfully = True
                _debug(capsys, "\n--- Final Structured Output ---")
                _debug(capsys, f"Answer: {response.parsed.final_answer}")
                _debug(capsys, f"Confidence: {response.parsed.confidence_score}%")

                assert isinstance(response.parsed, FinalOutput)
                assert 1 <= response.parsed.confidence_score <= 100
                final_answer = response.parsed.final_answer.lower()
                assert "paris" in final_answer
                assert "london" in final_answer
                assert "18" in final_answer
                assert "sunny" in final_answer
                assert "344" in final_answer
                break
    except AuthenticationError as exc:
        pytest.fail(
            "OpenRouter rejected the OPENROUTER_API_KEY loaded from settings/.env during "
            "chat/completions. The env-loading path is working, but the configured key is not "
            f"usable for completions. Original error: {exc}"
        )

    _debug(capsys, "--- Stream Complete ---")
    assert tools_called, "Model failed to call tools."
    assert parsed_successfully, "Model failed to return the final structured output after tool execution."
