import base64
import time
from collections.abc import Callable

import pytest
from openai import AuthenticationError
from pydantic import BaseModel, Field

from backend.src.agent import AgentRequest, AgentRunner
from backend.src.agent.events import AgentEventType
from backend.src.core.schema import Attachment, GenConfig, ThinkingLevel, ToolCall, ToolDefinition
from backend.src.core.settings import get_settings


class Output(BaseModel):
    final_ans: str = Field(description="Final answer that includes the image observation and tool-backed travel summary.")
    confidence_score: int = Field(description="Confidence score from 1 to 100.")


RED_SQUARE_PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAANUlEQVR4nO3QsQ0AMAzDsLT//9yeoCkbeYAN6LzZdZf3x0GSKEmUJEoSJYmSREmiJFGSaMoHo8QBPwYSAhsAAAAASUVORK5CYII="
)


def _debug(capsys: pytest.CaptureFixture[str], message: str) -> None:
    with capsys.disabled():
        print(message, flush=True)


def get_weather(city: str) -> dict[str, object]:
    weather_by_city = {
        "paris": {"city": "Paris", "temperature_c": 18, "condition": "sunny"},
    }
    normalized = city.strip().lower()
    if normalized not in weather_by_city:
        raise ValueError(f"Unsupported city: {city}")
    return weather_by_city[normalized]


def get_distance(origin: str, destination: str) -> dict[str, object]:
    known_routes = {
        ("london", "paris"): {"origin": "London", "destination": "Paris", "distance_km": 344},
        ("paris", "london"): {"origin": "Paris", "destination": "London", "distance_km": 344},
    }
    key = (origin.strip().lower(), destination.strip().lower())
    if key not in known_routes:
        raise ValueError(f"Unsupported route: {origin} -> {destination}")
    return known_routes[key]


def convert_km_to_miles(km: float) -> dict[str, object]:
    miles = round(float(km) * 0.621371, 2)
    return {"km": float(km), "miles": miles}


def _execute_tool(tool_call: ToolCall) -> dict[str, object]:
    handlers: dict[str, Callable[..., dict[str, object]]] = {
        "get_weather": get_weather,
        "get_distance": get_distance,
        "convert_km_to_miles": convert_km_to_miles,
    }
    handler = handlers.get(tool_call.name)
    if handler is None:
        raise AssertionError(f"Unexpected tool call: {tool_call.name}")
    return handler(**tool_call.arguments)


def _build_tools() -> list[ToolDefinition]:
    return [
        ToolDefinition(
            name="get_weather",
            description="Get the current weather for a supported city. Use this when weather is requested.",
            parameters={
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        ),
        ToolDefinition(
            name="get_distance",
            description="Get the distance in kilometers between two supported cities. Use this before any unit conversion.",
            parameters={
                "type": "object",
                "properties": {
                    "origin": {"type": "string"},
                    "destination": {"type": "string"},
                },
                "required": ["origin", "destination"],
            },
        ),
        ToolDefinition(
            name="convert_km_to_miles",
            description="Convert kilometers to miles. You must use this tool instead of mental math whenever miles are requested.",
            parameters={
                "type": "object",
                "properties": {"km": {"type": "number"}},
                "required": ["km"],
            },
        ),
    ]


def _build_request(*, model: str, thinking: ThinkingLevel, provider_kwargs: dict[str, object] | None = None) -> AgentRequest:
    return AgentRequest(
        model=model,
        system_prompt=(
            "You are a careful multimodal travel assistant. "
            "You must inspect the attached image, then use all three available tools exactly once if possible, "
            "and then return the final answer only in the requested structured output."
        ),
        query=(
            "Look at the attached image and identify it in a short phrase. "
            "Then find the weather in Paris, the distance from London to Paris in kilometers, "
            "and convert that distance to miles using the conversion tool. "
            "Your final answer must mention the image observation, the Paris weather, the distance in km and miles, "
            "and explicitly mention that the summary is tool-backed."
        ),
        attachments=[Attachment(mime_type="image/png", content=RED_SQUARE_PNG_BASE64, name="red-square.png")],
        tools=_build_tools(),
        response_model=Output,
        config=GenConfig(thinking=thinking),
        provider_kwargs=provider_kwargs or {},
    )


async def _run_agent_case(
    *,
    capsys: pytest.CaptureFixture[str],
    label: str,
    request: AgentRequest,
) -> None:
    runner = AgentRunner(tool_executor=_execute_tool)
    started_at = time.perf_counter()
    tools_called: list[str] = []
    parsed_output: Output | None = None
    seen_tool_call_ids: set[str] = set()

    _debug(capsys, f"\n=== Agent Runtime Integration [{label}] ===")
    _debug(capsys, f"Model: {request.model}")
    _debug(capsys, f"Thinking: {request.config.thinking.value}")
    _debug(capsys, f"Tools: {[tool.name for tool in request.tools or []]}")
    _debug(capsys, "--- Starting Agent Stream ---")

    try:
        async for event in runner.stream(request):
            elapsed = time.perf_counter() - started_at
            prefix = f"[{elapsed:0.2f}s]"

            if event.type == AgentEventType.THINKING and event.response and event.response.thinking:
                _debug(capsys, f"{prefix} [reasoning] {event.response.thinking}")
            elif event.type == AgentEventType.CONTENT and event.response and event.response.content:
                _debug(capsys, f"{prefix} [content] {event.response.content}")
            elif event.type == AgentEventType.TOOL_CALL and event.tool_call:
                if event.tool_call.id in seen_tool_call_ids:
                    continue
                seen_tool_call_ids.add(event.tool_call.id)
                tools_called.append(event.tool_call.name)
                _debug(
                    capsys,
                    f"{prefix} [tool-call] {event.tool_call.name} args={event.tool_call.arguments} call_id={event.tool_call.id}",
                )
            elif event.type == AgentEventType.TOOL_RESULT and event.tool_call and event.tool_result:
                _debug(capsys, f"{prefix} [tool-result] {event.tool_call.name} -> {event.tool_result}")
            elif event.type == AgentEventType.ASSISTANT_MESSAGE and event.message:
                _debug(
                    capsys,
                    f"{prefix} [assistant-message] content={event.message.content!r} tool_calls={len(event.message.tool_calls or [])}",
                )
            elif event.type == AgentEventType.ERROR and event.error:
                _debug(capsys, f"{prefix} [error] {event.error}")
            elif event.type == AgentEventType.FINAL_RESPONSE and event.response:
                _debug(capsys, f"{prefix} [final-content] {event.response.content}")
                if event.response.parsed:
                    parsed_output = event.response.parsed
                    _debug(capsys, f"{prefix} [final-structured] final_ans={parsed_output.final_ans}")
                    _debug(capsys, f"{prefix} [final-structured] confidence_score={parsed_output.confidence_score}")
    except AuthenticationError as exc:
        pytest.fail(f"{label} authentication failed: {exc}")

    _debug(capsys, "--- Agent Stream Complete ---")

    assert parsed_output is not None, f"{label} failed to produce parsed structured output."
    assert 1 <= parsed_output.confidence_score <= 100
    assert parsed_output.final_ans.strip()
    assert "red" in parsed_output.final_ans.lower() or "square" in parsed_output.final_ans.lower()
    assert "paris" in parsed_output.final_ans.lower()
    assert "km" in parsed_output.final_ans.lower() or "kilometer" in parsed_output.final_ans.lower()
    assert "mile" in parsed_output.final_ans.lower()
    assert {"get_weather", "get_distance", "convert_km_to_miles"}.issubset(set(tools_called)), (
        f"{label} did not call all required tools. Saw: {tools_called}"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("label", "model", "thinking", "provider_kwargs_factory"),
    [
        (
            "OpenAI GPT-5.4 Mini",
            "openai/gpt-5.4-mini",
            ThinkingLevel.LOW,
            lambda settings: {},
        ),
        (
            "OpenRouter Qwen 3.6 Plus",
            "openrouter/qwen/qwen3.6-plus",
            ThinkingLevel.LOW,
            lambda settings: {},
        ),
    ],
)
async def test_agent_runtime_multimodal_pipeline(
    capsys: pytest.CaptureFixture[str],
    label: str,
    model: str,
    thinking: ThinkingLevel,
    provider_kwargs_factory: Callable[[object], dict[str, object]],
):
    settings = get_settings()

    if model.startswith("openai/") and not settings.openai_api_key:
        pytest.skip("OPENAI_API_KEY not found in settings or environment")
    if model.startswith("openrouter/") and not settings.openrouter_api_key:
        pytest.skip("OPENROUTER_API_KEY not found in settings or environment")

    request = _build_request(
        model=model,
        thinking=thinking,
        provider_kwargs=provider_kwargs_factory(settings),
    )
    await _run_agent_case(capsys=capsys, label=label, request=request)
