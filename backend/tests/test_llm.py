import json
import httpx
from decimal import Decimal

import pytest

from app.llm.base import LLMProviderError, LLMStructuredOutputError, ModelResolutionError
from app.llm.providers.openai import OpenAIProvider
from app.llm.providers.openrouter import OpenRouterProvider
from app.llm.registry import ModelRegistry
from app.llm.runtime import build_llm_service
from app.llm.service import LLMService
from app.llm.types import (
    ImageContentPart,
    LLMInputMessage,
    LLMRequest,
    StructuredOutputSchema,
    TextContentPart,
    ToolDefinition,
)


class FakeResponsesClient:
    def __init__(self, response):
        self.response = response
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


class FakeOpenAIClient:
    def __init__(self, response):
        self.responses = FakeResponsesClient(response)
        self.chat = None


class FakeOpenAIResponse:
    def __init__(self, payload):
        self.payload = payload
        self.output_text = payload.get("output_text", "")
        self._request_id = "req_test_123"

    def model_dump(self, mode="json"):
        return self.payload


class MockOpenRouterTransport(httpx.AsyncBaseTransport):
    def __init__(self, status_code: int = 200, payload: dict | None = None):
        self.status_code = status_code
        self.payload = payload or {}
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(
            status_code=self.status_code,
            json=self.payload,
            request=request,
            headers={"x-request-id": "or_req_123"},
        )


class StaticAsyncByteStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]):
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk


class MockOpenRouterStreamingTransport(httpx.AsyncBaseTransport):
    def __init__(self, chunks: list[str], status_code: int = 200):
        self.status_code = status_code
        self.chunks = chunks
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(
            status_code=self.status_code,
            request=request,
            headers={"content-type": "text/event-stream"},
            stream=StaticAsyncByteStream([chunk.encode("utf-8") for chunk in self.chunks]),
        )


class FakeOpenAIChatCompletions:
    def __init__(self, chunks: list[dict]):
        self.chunks = chunks
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return FakeOpenAIChatCompletionStream(self.chunks)


class FakeOpenAIChatCompletionStream:
    def __init__(self, chunks: list[dict]):
        self.chunks = chunks

    def __aiter__(self):
        async def iterator():
            for chunk in self.chunks:
                yield FakeOpenAIChunk(chunk)

        return iterator()


class FakeOpenAIChunk:
    def __init__(self, payload: dict):
        self.payload = payload

    def model_dump(self, mode="json"):
        return self.payload


@pytest.mark.asyncio
async def test_openai_provider_builds_structured_multimodal_payload():
    fake_response = FakeOpenAIResponse(
        {
            "id": "resp_123",
            "status": "completed",
            "usage": {"input_tokens": 12, "output_tokens": 34, "total_tokens": 46},
            "output": [],
        }
    )
    client = FakeOpenAIClient(fake_response)
    provider = OpenAIProvider(api_key="test-key", client=client)
    registry = ModelRegistry()
    service = LLMService(registry=registry, providers={"openai": provider})

    request = LLMRequest(
        model="gpt-5.2",
        thinking_enabled=True,
        response_mode="structured",
        output_schema=StructuredOutputSchema(
            name="code_analysis",
            strict=True,
            schema={
                "type": "object",
                "properties": {"summary": {"type": "string"}},
                "required": ["summary"],
                "additionalProperties": False,
            },
        ),
        messages=[
            LLMInputMessage(
                role="user",
                content=[
                    TextContentPart(text="Summarize this screenshot"),
                    ImageContentPart(
                        image_url="https://example.com/screenshot.png",
                        detail="high",
                    ),
                ],
            )
        ],
        tools=[
            ToolDefinition(
                name="web_search",
                description="Search the web",
                input_schema={
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                    "additionalProperties": False,
                },
            )
        ],
        max_output_tokens=500,
    )

    with pytest.raises(LLMStructuredOutputError):
        await service.generate(request)

    payload = client.responses.calls[0]
    assert payload["model"] == "gpt-5.2"
    assert payload["reasoning"]["effort"] == "medium"
    assert payload["text"]["format"]["type"] == "json_schema"
    assert payload["text"]["format"]["name"] == "code_analysis"
    assert payload["tools"][0]["type"] == "function"
    assert payload["input"][0]["content"][0]["type"] == "input_text"
    assert payload["input"][0]["content"][1]["type"] == "input_image"
    assert payload["input"][0]["content"][1]["detail"] == "high"


@pytest.mark.asyncio
async def test_llm_service_returns_valid_structured_output():
    fake_response = FakeOpenAIResponse(
        {
            "id": "resp_456",
            "status": "completed",
            "usage": {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120},
            "output_text": '{"summary":"done"}',
            "output": [
                {
                    "type": "message",
                    "status": "completed",
                    "content": [{"type": "output_text", "text": '{"summary":"done"}'}],
                }
            ],
        }
    )
    provider = OpenAIProvider(api_key="test-key", client=FakeOpenAIClient(fake_response))
    service = LLMService(registry=ModelRegistry(), providers={"openai": provider})

    response = await service.generate(
        LLMRequest(
            model="gpt-5.4-mini",
            response_mode="structured",
            output_schema=StructuredOutputSchema(
                name="code_analysis",
                schema={
                    "type": "object",
                    "properties": {"summary": {"type": "string"}},
                    "required": ["summary"],
                    "additionalProperties": False,
                },
            ),
            messages=[
                LLMInputMessage(
                    role="user",
                    content=[TextContentPart(text="Return JSON")],
                )
            ],
        )
    )

    assert response.structured_output == {"summary": "done"}
    assert response.structured_output_valid is True
    assert response.usage.total_tokens == 120
    assert response.usage.cost_usd == Decimal("0")


@pytest.mark.asyncio
async def test_openai_provider_sets_reasoning_to_none_when_thinking_is_off():
    fake_response = FakeOpenAIResponse(
        {
            "id": "resp_reasoning_none",
            "status": "completed",
            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
            "output_text": "done",
            "output": [],
        }
    )
    client = FakeOpenAIClient(fake_response)
    provider = OpenAIProvider(api_key="test-key", client=client)
    service = LLMService(registry=ModelRegistry(), providers={"openai": provider})

    await service.generate(
        LLMRequest(
            model="gpt-5.4-mini",
            messages=[
                LLMInputMessage(role="user", content=[TextContentPart(text="Hello")])
            ],
            thinking_enabled=False,
        )
    )

    assert client.responses.calls[0]["reasoning"]["effort"] == "none"


def test_model_registry_rejects_unknown_model():
    registry = ModelRegistry()

    with pytest.raises(ModelResolutionError):
        registry.resolve("unknown-model")


def test_model_registry_lists_expected_models():
    registry = ModelRegistry()

    ids = {model.public_id for model in registry.list_models()}

    assert ids == {
        "gpt-5.2",
        "gpt-5.4-mini",
        "minimax/minimax-m2.7",
        "qwen/qwen3.5-397b-a17b",
        "moonshotai/kimi-k2.5",
    }


@pytest.mark.asyncio
async def test_openrouter_provider_builds_structured_multimodal_payload():
    transport = MockOpenRouterTransport(
        payload={
            "id": "or_123",
            "choices": [{"finish_reason": "stop", "message": {"content": ""}}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 34, "total_tokens": 46},
        }
    )
    async with httpx.AsyncClient(
        transport=transport,
        base_url="https://openrouter.ai/api/v1",
    ) as client:
        provider = OpenRouterProvider(
            api_key="test-key",
            base_url="https://openrouter.ai/api/v1",
            client=client,
            app_url="https://premchat.local",
            app_title="PremChat",
        )
        service = LLMService(registry=ModelRegistry(), providers={"openrouter": provider})

        request = LLMRequest(
            model="minimax/minimax-m2.7",
            thinking_enabled=True,
            response_mode="structured",
            output_schema=StructuredOutputSchema(
                name="analysis",
                strict=True,
                schema={
                    "type": "object",
                    "properties": {"summary": {"type": "string"}},
                    "required": ["summary"],
                    "additionalProperties": False,
                },
            ),
            messages=[
                LLMInputMessage(
                    role="user",
                    content=[
                        TextContentPart(text="Analyze the screenshot"),
                        ImageContentPart(
                            image_url="https://example.com/image.png",
                            detail="high",
                        ),
                    ],
                )
            ],
            tools=[
                ToolDefinition(
                    name="web_search",
                    description="Search the web",
                    input_schema={
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"],
                        "additionalProperties": False,
                    },
                )
            ],
            max_output_tokens=200,
        )

        with pytest.raises(LLMStructuredOutputError):
            await service.generate(request)

        sent_payload = json.loads(transport.requests[0].content.decode("utf-8"))
        sent_headers = transport.requests[0].headers

        assert sent_payload["model"] == "minimax/minimax-m2.7"
        assert sent_payload["max_tokens"] == 200
        assert sent_payload["reasoning"]["enabled"] is True
        assert sent_payload["response_format"]["type"] == "json_schema"
        assert sent_payload["response_format"]["json_schema"]["name"] == "analysis"
        assert sent_payload["tools"][0]["type"] == "function"
        assert sent_payload["tools"][0]["function"]["name"] == "web_search"
        assert sent_payload["messages"][0]["content"][0]["type"] == "text"
        assert sent_payload["messages"][0]["content"][1]["type"] == "image_url"
        assert sent_payload["messages"][0]["content"][1]["image_url"]["detail"] == "high"
        assert sent_headers["authorization"] == "Bearer test-key"
        assert sent_headers["http-referer"] == "https://premchat.local"
        assert sent_headers["x-title"] == "PremChat"


@pytest.mark.asyncio
async def test_openrouter_provider_parses_text_tools_and_usage():
    transport = MockOpenRouterTransport(
        payload={
            "id": "or_456",
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "Here is the result",
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "type": "function",
                                "function": {
                                    "name": "web_search",
                                    "arguments": '{"query":"premchat"}',
                                },
                            }
                        ],
                    },
                }
            ],
            "usage": {
                "prompt_tokens": 50,
                "completion_tokens": 25,
                "total_tokens": 75,
                "cost": "0.004321",
            },
        }
    )
    async with httpx.AsyncClient(
        transport=transport,
        base_url="https://openrouter.ai/api/v1",
    ) as client:
        provider = OpenRouterProvider(
            api_key="test-key",
            base_url="https://openrouter.ai/api/v1",
            client=client,
        )
        service = LLMService(registry=ModelRegistry(), providers={"openrouter": provider})

        response = await service.generate(
            LLMRequest(
                model="qwen/qwen3.5-397b-a17b",
                messages=[
                    LLMInputMessage(
                        role="user",
                        content=[TextContentPart(text="Search the web")],
                    )
                ],
                tools=[
                    ToolDefinition(
                        name="web_search",
                        description="Search the web",
                        input_schema={"type": "object"},
                    )
                ],
            )
        )

        assert response.output_text == "Here is the result"
        assert response.finish_reason == "tool_calls"
        assert response.usage.input_tokens == 50
        assert response.usage.output_tokens == 25
        assert response.usage.total_tokens == 75
        assert response.usage.cost_usd == Decimal("0.004321")
        assert response.tool_calls[0].tool_call_id == "call_1"
        assert response.tool_calls[0].tool_name == "web_search"
        assert response.tool_calls[0].arguments_json == {"query": "premchat"}


@pytest.mark.asyncio
async def test_openrouter_provider_validates_structured_output():
    transport = MockOpenRouterTransport(
        payload={
            "id": "or_789",
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"content": '{"summary":"done"}'},
                }
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
        }
    )
    async with httpx.AsyncClient(
        transport=transport,
        base_url="https://openrouter.ai/api/v1",
    ) as client:
        provider = OpenRouterProvider(
            api_key="test-key",
            base_url="https://openrouter.ai/api/v1",
            client=client,
        )
        service = LLMService(registry=ModelRegistry(), providers={"openrouter": provider})

        response = await service.generate(
            LLMRequest(
                model="moonshotai/kimi-k2.5",
                response_mode="structured",
                output_schema=StructuredOutputSchema(
                    name="analysis",
                    schema={
                        "type": "object",
                        "properties": {"summary": {"type": "string"}},
                        "required": ["summary"],
                        "additionalProperties": False,
                    },
                ),
                messages=[
                    LLMInputMessage(
                        role="user",
                        content=[TextContentPart(text="Return JSON")],
                    )
                ],
            )
        )

        assert response.structured_output == {"summary": "done"}
        assert response.structured_output_valid is True


@pytest.mark.asyncio
async def test_openrouter_provider_handles_invalid_tool_arguments():
    transport = MockOpenRouterTransport(
        payload={
            "id": "or_invalid",
            "choices": [
                {
                    "finish_reason": "tool_calls",
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "call_bad",
                                "type": "function",
                                "function": {
                                    "name": "web_search",
                                    "arguments": "{not-json}",
                                },
                            }
                        ],
                    },
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
    )
    async with httpx.AsyncClient(
        transport=transport,
        base_url="https://openrouter.ai/api/v1",
    ) as client:
        provider = OpenRouterProvider(
            api_key="test-key",
            base_url="https://openrouter.ai/api/v1",
            client=client,
        )
        service = LLMService(registry=ModelRegistry(), providers={"openrouter": provider})

        response = await service.generate(
            LLMRequest(
                model="qwen/qwen3.5-397b-a17b",
                messages=[
                    LLMInputMessage(
                        role="user",
                        content=[TextContentPart(text="Call a tool")],
                    )
                ],
            )
        )

        assert response.tool_calls[0].arguments_json == {"raw": "{not-json}"}


@pytest.mark.asyncio
async def test_openrouter_provider_raises_on_http_errors():
    transport = MockOpenRouterTransport(
        status_code=400,
        payload={"error": {"message": "Bad request"}},
    )
    async with httpx.AsyncClient(
        transport=transport,
        base_url="https://openrouter.ai/api/v1",
    ) as client:
        provider = OpenRouterProvider(
            api_key="test-key",
            base_url="https://openrouter.ai/api/v1",
            client=client,
        )
        service = LLMService(registry=ModelRegistry(), providers={"openrouter": provider})

        with pytest.raises(LLMProviderError):
            await service.generate(
                LLMRequest(
                    model="minimax/minimax-m2.7",
                    messages=[
                        LLMInputMessage(
                            role="user",
                            content=[TextContentPart(text="Hello")],
                        )
                    ],
                )
            )


@pytest.mark.asyncio
async def test_openrouter_provider_streams_reasoning_and_text_deltas():
    transport = MockOpenRouterStreamingTransport(
        chunks=[
            'data: {"id":"or_stream_1","choices":[{"delta":{"reasoning":"Thinking step 1. "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"Answer "}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"done."},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"cost":"0.0012"}}\n\n',
            "data: [DONE]\n\n",
        ]
    )
    async with httpx.AsyncClient(
        transport=transport,
        base_url="https://openrouter.ai/api/v1",
    ) as client:
        provider = OpenRouterProvider(
            api_key="test-key",
            base_url="https://openrouter.ai/api/v1",
            client=client,
        )
        service = LLMService(registry=ModelRegistry(), providers={"openrouter": provider})

        events = [
            event
            async for event in service.stream(
                LLMRequest(
                    model="qwen/qwen3.5-397b-a17b",
                    thinking_enabled=True,
                    messages=[
                        LLMInputMessage(
                            role="user",
                            content=[TextContentPart(text="Stream this")],
                        )
                    ],
                )
            )
        ]

        assert [event.event_type for event in events] == [
            "response.started",
            "reasoning.delta",
            "text.delta",
            "text.delta",
            "response.completed",
        ]
        assert events[1].payload["delta"] == "Thinking step 1. "
        assert events[2].payload["delta"] == "Answer "
        assert events[3].payload["delta"] == "done."
        assert events[-1].payload["usage"]["total_tokens"] == 18
        sent_payload = json.loads(transport.requests[0].content.decode("utf-8"))
        assert sent_payload["stream"] is True


@pytest.mark.asyncio
async def test_openai_provider_streams_text_deltas():
    fake_response = FakeOpenAIResponse(
        {
            "id": "resp_unused",
            "status": "completed",
            "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
            "output_text": "done",
            "output": [],
        }
    )
    client = FakeOpenAIClient(fake_response)
    client.chat = type(
        "FakeChatNamespace",
        (),
        {
            "completions": FakeOpenAIChatCompletions(
                [
                    {
                        "id": "chatcmpl_1",
                        "choices": [{"delta": {"content": "Hello "}}],
                    },
                    {
                        "choices": [{"delta": {"content": "world"}, "finish_reason": "stop"}],
                        "usage": {
                            "prompt_tokens": 9,
                            "completion_tokens": 4,
                            "total_tokens": 13,
                        },
                    },
                ]
            )
        },
    )()
    provider = OpenAIProvider(api_key="test-key", client=client)
    service = LLMService(registry=ModelRegistry(), providers={"openai": provider})

    events = [
        event
        async for event in service.stream(
            LLMRequest(
                model="gpt-5.2",
                thinking_enabled=True,
                messages=[
                    LLMInputMessage(role="user", content=[TextContentPart(text="Hello")])
                ],
            )
        )
    ]

    assert [event.event_type for event in events] == [
        "response.started",
        "text.delta",
        "text.delta",
        "response.completed",
    ]
    assert events[1].payload["delta"] == "Hello "
    assert events[2].payload["delta"] == "world"
    assert events[-1].payload["usage"]["total_tokens"] == 13
    assert client.chat.completions.calls[0]["stream"] is True
    assert client.chat.completions.calls[0]["reasoning_effort"] == "medium"


def test_runtime_registers_openrouter_provider(monkeypatch):
    import app.llm.runtime as runtime_module

    runtime_module.build_llm_service.cache_clear()
    monkeypatch.setattr(runtime_module.settings, "openai_api_key", None)
    monkeypatch.setattr(runtime_module.settings, "openrouter_api_key", "router-key")
    monkeypatch.setattr(
        runtime_module.settings,
        "openrouter_base_url",
        "https://openrouter.ai/api/v1",
    )
    monkeypatch.setattr(runtime_module.settings, "openrouter_app_url", None)
    monkeypatch.setattr(runtime_module.settings, "openrouter_app_title", None)

    service = build_llm_service()

    assert "openrouter" in service.providers
    runtime_module.build_llm_service.cache_clear()


@pytest.mark.asyncio
async def test_openrouter_provider_disables_reasoning_when_thinking_is_off():
    transport = MockOpenRouterTransport(
        payload={
            "id": "or_reasoning_off",
            "choices": [{"finish_reason": "stop", "message": {"content": "done"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
    )
    async with httpx.AsyncClient(
        transport=transport,
        base_url="https://openrouter.ai/api/v1",
    ) as client:
        provider = OpenRouterProvider(
            api_key="test-key",
            base_url="https://openrouter.ai/api/v1",
            client=client,
        )
        service = LLMService(registry=ModelRegistry(), providers={"openrouter": provider})

        await service.generate(
            LLMRequest(
                model="minimax/minimax-m2.7",
                messages=[
                    LLMInputMessage(
                        role="user",
                        content=[TextContentPart(text="Hello")],
                    )
                ],
                thinking_enabled=False,
            )
        )

        sent_payload = json.loads(transport.requests[0].content.decode("utf-8"))
        assert sent_payload["reasoning"]["enabled"] is True
        assert sent_payload["reasoning"]["exclude"] is True
