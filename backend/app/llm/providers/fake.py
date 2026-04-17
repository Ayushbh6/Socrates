from __future__ import annotations

import json
from collections.abc import AsyncIterator
from decimal import Decimal

from app.llm.types import (
    LLMEvent,
    LLMRequest,
    LLMResponse,
    ModelSpec,
    TextContentPart,
    UsageInfo,
)


MARKDOWN_DEMO = """# PremChat Markdown Demo

Here is a response formatted like a proper technical assistant.

## Highlights

- Clean markdown rendering
- Syntax-highlighted code blocks
- Tables, quotes, and links

```python title="app.py"
def greet(name: str) -> str:
    return f"Hello, {name}"
```

| Surface | Status |
| --- | --- |
| Transcript | Live |
| Sidebar actions | Enabled |

> Good formatting makes technical output readable at a glance.

See [OpenRouter](https://openrouter.ai/) for provider docs.
"""


class FakeProvider:
    def __init__(self, provider_name: str) -> None:
        self.provider_name = provider_name

    async def generate(self, request: LLMRequest, model_spec: ModelSpec) -> LLMResponse:
        last_user_text = ""
        for message in reversed(request.messages):
            if message.role != "user":
                continue
            text_parts = [
                part.text
                for part in message.content
                if isinstance(part, TextContentPart) and part.text
            ]
            if text_parts:
                last_user_text = "\n".join(text_parts)
                break

        content = self._build_response_text(last_user_text, model_spec.display_name)
        provider_metadata = {}
        if request.thinking_enabled:
            provider_metadata["reasoning"] = (
                f"Reasoning enabled for {model_spec.display_name}."
            )
            provider_metadata["reasoningDetails"] = [
                {"step": "analyze", "summary": "Parsed the latest user turn."},
                {"step": "respond", "summary": "Generated a deterministic fake reply."},
            ]

        structured_output = None
        if request.response_mode == "structured":
            structured_output = {
                "reply": content,
                "model": model_spec.public_id,
                "provider": model_spec.provider,
            }
            content = json.dumps(structured_output, ensure_ascii=True)

        token_count = max(32, len(content.split()) * 3)

        return LLMResponse(
            provider=model_spec.provider,
            model=model_spec.public_id,
            provider_message_id=f"fake-{model_spec.provider}-message",
            request_id=f"fake-{model_spec.provider}-request",
            output_text=content,
            structured_output=structured_output,
            finish_reason="stop",
            usage=UsageInfo(
                input_tokens=max(12, len(last_user_text.split()) * 2),
                output_tokens=token_count,
                total_tokens=max(12, len(last_user_text.split()) * 2) + token_count,
                cost_usd=Decimal("0"),
            ),
            provider_metadata=provider_metadata,
            raw_response={
                "provider": model_spec.provider,
                "model": model_spec.public_id,
                "fake": True,
                "thinkingEnabled": request.thinking_enabled,
            },
        )

    async def stream(
        self,
        request: LLMRequest,
        model_spec: ModelSpec,
    ) -> AsyncIterator[LLMEvent]:
        response = await self.generate(request, model_spec)

        yield LLMEvent(
            event_type="response.started",
            event_index=0,
            provider=model_spec.provider,
            model=model_spec.public_id,
            message_id=request.message_id,
            payload={},
        )

        event_index = 1
        reasoning_text = response.provider_metadata.get("reasoning")
        if isinstance(reasoning_text, str) and reasoning_text:
            yield LLMEvent(
                event_type="reasoning.delta",
                event_index=event_index,
                provider=model_spec.provider,
                model=model_spec.public_id,
                message_id=request.message_id,
                payload={"delta": reasoning_text},
            )
            event_index += 1

        for token in response.output_text.split():
            yield LLMEvent(
                event_type="text.delta",
                event_index=event_index,
                provider=model_spec.provider,
                model=model_spec.public_id,
                message_id=request.message_id,
                payload={"delta": f"{token} "},
            )
            event_index += 1

        yield LLMEvent(
            event_type="response.completed",
            event_index=event_index,
            provider=model_spec.provider,
            model=model_spec.public_id,
            message_id=request.message_id,
            payload={
                "provider_message_id": response.provider_message_id,
                "request_id": response.request_id,
                "finish_reason": response.finish_reason,
                "provider_metadata": response.provider_metadata,
                "raw_response": response.raw_response,
                "tool_calls": [],
                "usage": {
                    "input_tokens": response.usage.input_tokens,
                    "output_tokens": response.usage.output_tokens,
                    "total_tokens": response.usage.total_tokens,
                    "cost_usd": str(response.usage.cost_usd),
                },
            },
            input_tokens=response.usage.input_tokens,
            output_tokens=response.usage.output_tokens,
        )

    def _build_response_text(self, prompt: str, display_name: str) -> str:
        lowered = prompt.lower()
        if "markdown" in lowered or "table" in lowered or "code block" in lowered:
            return MARKDOWN_DEMO

        return (
            f"Hey there! I’m {display_name}, and this reply is coming through PremChat’s "
            f"persisted backend chat flow.\n\nYou said: {prompt}"
        )
