import time
from collections.abc import Callable

import pytest
from ollama import ResponseError
from openai import AuthenticationError
from pydantic import BaseModel, Field

from backend.src.agent import AgentRequest, AgentRunner, AgentTurnTelemetry
from backend.src.agent.events import AgentEventType
from backend.src.core.schema import Attachment, GenConfig, ThinkingLevel, ToolCall, ToolDefinition, UsageStats
from backend.src.core.settings import get_settings


class Output(BaseModel):
    final_ans: str = Field(description="Final answer that includes image observation plus tool-backed travel facts.")
    confidence_score: int = Field(description="Confidence score from 1 to 100.")


RED_SQUARE_PNG_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAANUlEQVR4nO3QsQ0AMAzDsLT//9yeoCkbeYAN6LzZdZf3x0GSKEmUJEoSJYmSREmiJFGSaMoHo8QBPwYSAhsAAAAASUVORK5CYII="
)


def _debug(capsys: pytest.CaptureFixture[str], message: str) -> None:
    with capsys.disabled():
        print(message, flush=True)


def get_weather(city: str) -> dict[str, object]:
    lookup = {"paris": {"city": "Paris", "temperature_c": 18, "condition": "sunny"}}
    result = lookup.get(city.strip().lower())
    if result is None:
        raise ValueError(f"Unsupported city: {city}")
    return result


def get_distance(origin: str, destination: str) -> dict[str, object]:
    lookup = {
        ("london", "paris"): {"origin": "London", "destination": "Paris", "distance_km": 344},
        ("paris", "london"): {"origin": "Paris", "destination": "London", "distance_km": 344},
    }
    result = lookup.get((origin.strip().lower(), destination.strip().lower()))
    if result is None:
        raise ValueError(f"Unsupported route: {origin} -> {destination}")
    return result


def convert_km_to_miles(km: float) -> dict[str, object]:
    return {"km": float(km), "miles": round(float(km) * 0.621371, 2)}


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
            description="Get the current weather for a supported city.",
            parameters={
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        ),
        ToolDefinition(
            name="get_distance",
            description="Get the distance in kilometers between two supported cities.",
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
            description="Convert kilometers to miles using tool-backed calculation.",
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
            "Inspect the attached image, use tools for all factual travel data, "
            "and return only the requested structured output."
        ),
        query=(
            "Identify the attached image in a short phrase. "
            "Then get the weather in Paris, the distance from London to Paris in kilometers, "
            "and convert that distance to miles using the conversion tool. "
            "Your final answer must mention the image observation, the Paris weather, the distance in km and miles, "
            "and explicitly say the summary is tool-backed."
        ),
        attachments=[Attachment(mime_type="image/png", content=RED_SQUARE_PNG_BASE64, name="red-square.png")],
        tools=_build_tools(),
        response_model=Output,
        config=GenConfig(thinking=thinking),
        provider_kwargs=provider_kwargs or {},
    )


def _format_usage(usage: UsageStats) -> str:
    return (
        f"input={usage.input_tokens}, output={usage.output_tokens}, "
        f"completion={usage.completion_tokens}, total={usage.total_tokens}"
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

    _debug(capsys, f"\n=== Agent Telemetry Integration [{label}] ===")
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
            elif event.type == AgentEventType.FINAL_RESPONSE and event.response:
                _debug(capsys, f"{prefix} [final-content] {event.response.content}")
                aggregate_usage = event.response.metadata.get("agent_usage", UsageStats())
                aggregate_elapsed_ms = event.response.metadata.get("agent_elapsed_ms", 0.0)
                turns = event.response.metadata.get("agent_turn_telemetry", [])
                _debug(capsys, f"{prefix} [agent-usage] {_format_usage(aggregate_usage)}")
                _debug(capsys, f"{prefix} [agent-elapsed-ms] {aggregate_elapsed_ms:.2f}")
                for turn in turns:
                    telemetry = AgentTurnTelemetry.model_validate(turn) if not isinstance(turn, AgentTurnTelemetry) else turn
                    _debug(
                        capsys,
                        f"{prefix} [turn-{telemetry.round_index}] phase={telemetry.phase} "
                        f"elapsed_ms={telemetry.elapsed_ms:.2f} "
                        f"tool_call_count={telemetry.tool_call_count} "
                        f"had_thinking={telemetry.had_thinking} "
                        f"parsed_output={telemetry.parsed_output} "
                        f"usage=({_format_usage(telemetry.usage)})",
                    )
                if event.response.parsed:
                    parsed_output = event.response.parsed
                    _debug(capsys, f"{prefix} [final-structured] final_ans={parsed_output.final_ans}")
                    _debug(capsys, f"{prefix} [final-structured] confidence_score={parsed_output.confidence_score}")
    except AuthenticationError as exc:
        pytest.fail(f"{label} authentication failed: {exc}")
    except ResponseError as exc:
        pytest.fail(f"{label} Ollama request failed: {exc}")

    _debug(capsys, "--- Agent Stream Complete ---")

    assert parsed_output is not None, f"{label} failed to produce parsed structured output."
    assert 1 <= parsed_output.confidence_score <= 100
    assert "tool-backed" in parsed_output.final_ans.lower()
    assert "paris" in parsed_output.final_ans.lower()
    assert "mile" in parsed_output.final_ans.lower()
    assert {"get_weather", "get_distance", "convert_km_to_miles"}.issubset(set(tools_called))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("label", "model", "thinking", "provider_kwargs_factory", "skip_check"),
    [
        (
            "Gemini 3 Flash Preview",
            "gemini/gemini-3-flash-preview",
            ThinkingLevel.LOW,
            lambda settings: {"api_key": settings.gemini_api_key},
            lambda settings: settings.gemini_api_key is None,
        ),
        (
            "Ollama Gemma4 31B Cloud",
            "ollama/gemma4:31b-cloud",
            ThinkingLevel.OFF,
            lambda settings: {"host": "https://ollama.com", "api_key": settings.ollama_api_key},
            lambda settings: settings.ollama_api_key is None,
        ),
    ],
)
async def test_agent_runtime_usage_and_telemetry_pipeline(
    capsys: pytest.CaptureFixture[str],
    label: str,
    model: str,
    thinking: ThinkingLevel,
    provider_kwargs_factory: Callable[[object], dict[str, object]],
    skip_check: Callable[[object], bool],
):
    settings = get_settings()
    if skip_check(settings):
        pytest.skip(f"Missing credentials required for {label}.")

    request = _build_request(
        model=model,
        thinking=thinking,
        provider_kwargs=provider_kwargs_factory(settings),
    )
    await _run_agent_case(capsys=capsys, label=label, request=request)
