import json

import pytest
from pydantic import BaseModel, Field
from backend.src.providers.openai_adapter import OpenAIAdapter
from backend.src.core.schema import (
    GenConfig,
    LLMRequest,
    Message,
    MessageRole,
    ThinkingLevel,
    ToolCall,
    ToolDefinition,
)

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
async def test_openai_gpt5_integration(capsys: pytest.CaptureFixture[str]):
    """
    Integration test to verify:
    1. o-series model execution (gpt-5.4-mini)
    2. Thinking level configuration (LOW)
    3. Tool calling (weather and distance)
    4. Structured Output parsing (FinalOutput)
    5. Asynchronous streaming (astream)
    """
    # Initialize adapter
    adapter = OpenAIAdapter(model_name="gpt-5.4-mini")

    # Define fake tools
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

    # Build the complex request
    request = LLMRequest(
        system_prompt="You are a helpful travel assistant. Use tools to provide accurate info.",
        query="What is the weather in Paris and how far is it from London? Provide the final answer in the requested structured format.",
        tools=[weather_tool, distance_tool],
        response_model=FinalOutput,
        config=GenConfig(thinking=ThinkingLevel.LOW)
    )

    _debug(capsys, "\n=== OpenAI Integration Test ===")
    _debug(capsys, f"Model: {adapter.model_name}")
    _debug(capsys, f"Query: {request.query}")
    _debug(capsys, f"Tools Available: {[tool.name for tool in request.tools or []]}")
    _debug(capsys, "--- Starting Agent Loop ---")
    
    tools_called = False
    parsed_successfully = False

    initial_query = request.query
    history: list[Message] = []
    active_query = initial_query

    for turn_number in range(1, 4):
        _debug(capsys, f"\n--- Turn {turn_number} ---")

        turn_request = LLMRequest(
            system_prompt=request.system_prompt,
            query=active_query,
            history=history,
            tools=request.tools,
            response_model=request.response_model,
            config=request.config,
        )

        turn_tool_calls: list[ToolCall] = []
        seen_tool_call_ids: set[str] = set()

        async for response in adapter.astream(turn_request):
            if response.thinking:
                _debug(capsys, f"[reasoning] {response.thinking}")

            if response.content:
                _debug(capsys, f"[content] {response.content}")

            if response.tool_calls:
                tools_called = True
                for tool_call in response.tool_calls:
                    if tool_call.id in seen_tool_call_ids:
                        continue
                    seen_tool_call_ids.add(tool_call.id)
                    turn_tool_calls.append(tool_call)
                    _debug(
                        capsys,
                        f"[tool-call] {tool_call.name} args={tool_call.arguments} call_id={tool_call.id}",
                    )

            if response.parsed:
                parsed_successfully = True
                _debug(capsys, "\n--- Final Structured Output ---")
                _debug(capsys, f"Answer: {response.parsed.final_answer}")
                _debug(capsys, f"Confidence: {response.parsed.confidence_score}%")

                assert isinstance(response.parsed, FinalOutput)
                assert 1 <= response.parsed.confidence_score <= 100
                break

        if parsed_successfully:
            break

        if not turn_tool_calls:
            break

        if not history:
            history.append(Message(role=MessageRole.USER, content=initial_query))

        history.append(Message(role=MessageRole.ASSISTANT, tool_calls=turn_tool_calls))

        for tool_call in turn_tool_calls:
            tool_result = _execute_fake_tool(tool_call)
            _debug(capsys, f"[tool-result] {tool_call.name} -> {tool_result}")
            history.append(
                Message(
                    role=MessageRole.TOOL,
                    tool_call_id=tool_call.id,
                    content=json.dumps(tool_result),
                )
            )

        active_query = "Use the tool results to return the final structured answer."

    _debug(capsys, "--- Stream Complete ---")
    assert tools_called, "Model failed to call tools."
    assert parsed_successfully, "Model failed to return the final structured output after tool execution."
