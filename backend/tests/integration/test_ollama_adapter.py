import base64
import os

import pytest
from ollama import Client, ResponseError
from pydantic import BaseModel, Field

from backend.src.core.schema import Attachment, GenConfig, LLMRequest, ThinkingLevel, ToolCall, ToolDefinition
from backend.src.core.settings import get_settings
from backend.src.providers.ollama_adapter import OllamaAdapter


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


async def _run_travel_stream_test(
    *,
    adapter: OllamaAdapter,
    request: LLMRequest,
    capsys: pytest.CaptureFixture[str],
) -> tuple[bool, bool, FinalOutput | None]:
    parsed_successfully = False
    tools_called = False
    parsed_output: FinalOutput | None = None

    stream = adapter.astream(request)
    try:
        async for response in stream:
            if response.thinking:
                _debug(capsys, f"[reasoning] {response.thinking}")
            if response.content:
                _debug(capsys, f"[content] {response.content}")
            if response.tool_calls:
                tools_called = True
                for tool_call in response.tool_calls:
                    _debug(capsys, f"[tool-call] {tool_call.name} args={tool_call.arguments} call_id={tool_call.id}")
                    _debug(capsys, f"[tool-result] {tool_call.name} -> {_execute_fake_tool(tool_call)}")
            if response.parsed:
                parsed_successfully = True
                parsed_output = response.parsed
                _debug(capsys, "\n--- Final Structured Output ---")
                _debug(capsys, f"Answer: {response.parsed.final_answer}")
                _debug(capsys, f"Confidence: {response.parsed.confidence_score}%")
                break
    finally:
        await stream.aclose()

    return tools_called, parsed_successfully, parsed_output


def _require_local_model(model_name: str) -> None:
    settings = get_settings()
    try:
        models = Client(host=settings.ollama_host).list().models
    except Exception as exc:
        pytest.skip(f"Local Ollama is not reachable at {settings.ollama_host}: {exc}")

    available = {model.model for model in models}
    if model_name not in available:
        pytest.skip(f"Local Ollama model '{model_name}' is not installed.")


@pytest.mark.asyncio
async def test_ollama_local_tool_structured_output_integration(capsys: pytest.CaptureFixture[str]):
    model_name = os.environ.get("OLLAMA_TEXT_MODEL")
    if not model_name:
        pytest.skip("Set OLLAMA_TEXT_MODEL to run the local Ollama tool/structured-output test.")

    _require_local_model(model_name)

    adapter = OllamaAdapter(
        model_name=model_name,
        tool_executor=_execute_fake_tool,
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
    distance_tool = ToolDefinition(
        name="get_distance",
        description="Get distance between two cities",
        parameters={
            "type": "object",
            "properties": {
                "origin": {"type": "string"},
                "destination": {"type": "string"},
            },
            "required": ["origin", "destination"],
        },
    )

    request = LLMRequest(
        system_prompt="You are a helpful travel assistant. Use tools to provide accurate info.",
        query="What is the weather in Paris and how far is it from London? Provide the final answer in the requested structured format.",
        tools=[weather_tool, distance_tool],
        response_model=FinalOutput,
        config=GenConfig(thinking=ThinkingLevel.LOW),
    )

    _debug(capsys, f"\n=== Ollama Local Integration Test [{model_name}] ===")
    tools_called, parsed_successfully, parsed_output = await _run_travel_stream_test(
        adapter=adapter,
        request=request,
        capsys=capsys,
    )

    assert tools_called, "Model failed to call tools."
    assert parsed_successfully, "Model failed to return the final structured output."
    assert isinstance(parsed_output, FinalOutput)
    assert 1 <= parsed_output.confidence_score <= 100


@pytest.mark.asyncio
async def test_ollama_local_vision_integration(capsys: pytest.CaptureFixture[str]):
    model_name = os.environ.get("OLLAMA_VISION_MODEL")
    if not model_name:
        pytest.skip("Set OLLAMA_VISION_MODEL to run the local Ollama vision test.")

    _require_local_model(model_name)

    adapter = OllamaAdapter(model_name=model_name)
    red_dot_png = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z/C/HwAFgwJ/l7wHouAAAAAASUVORK5CYII="
    )

    request = LLMRequest(
        system_prompt="Describe images briefly and directly.",
        query="Describe this image in one short sentence.",
        attachments=[Attachment(mime_type="image/png", content=red_dot_png)],
        config=GenConfig(thinking=ThinkingLevel.OFF),
    )

    response = await adapter.agenerate(request)
    _debug(capsys, f"\n=== Ollama Vision Integration Test [{model_name}] ===")
    _debug(capsys, f"[content] {response.content}")

    assert response.content.strip(), "Vision model returned empty content."


@pytest.mark.asyncio
async def test_ollama_direct_cloud_integration(capsys: pytest.CaptureFixture[str]):
    settings = get_settings()
    model_name = os.environ.get("OLLAMA_CLOUD_MODEL")
    if not model_name:
        pytest.skip("Set OLLAMA_CLOUD_MODEL to run the direct Ollama Cloud test.")
    if not settings.ollama_api_key:
        pytest.skip("OLLAMA_API_KEY is required for the direct Ollama Cloud test.")

    adapter = OllamaAdapter(
        model_name=model_name,
        host="https://ollama.com",
        api_key=settings.ollama_api_key,
        tool_executor=_execute_fake_tool,
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
    distance_tool = ToolDefinition(
        name="get_distance",
        description="Get distance between two cities",
        parameters={
            "type": "object",
            "properties": {
                "origin": {"type": "string"},
                "destination": {"type": "string"},
            },
            "required": ["origin", "destination"],
        },
    )

    request = LLMRequest(
        system_prompt="You are a helpful travel assistant. Use tools to provide accurate info.",
        query="What is the weather in Paris and how far is it from London? Provide the final answer in the requested structured format.",
        tools=[weather_tool, distance_tool],
        response_model=FinalOutput,
        config=GenConfig(
            thinking=ThinkingLevel.LOW if model_name.lower().startswith("gpt-oss") else ThinkingLevel.OFF
        ),
    )

    _debug(capsys, f"\n=== Ollama Cloud Integration Test [{model_name}] ===")
    try:
        tools_called, parsed_successfully, parsed_output = await _run_travel_stream_test(
            adapter=adapter,
            request=request,
            capsys=capsys,
        )
    except ResponseError as exc:
        if exc.status_code == 404:
            pytest.skip(f"Cloud model '{model_name}' is not available: {exc}")
        raise

    assert tools_called, "Model failed to call tools."
    assert parsed_successfully, "Model failed to return the final structured output."
    assert isinstance(parsed_output, FinalOutput)
    assert 1 <= parsed_output.confidence_score <= 100
