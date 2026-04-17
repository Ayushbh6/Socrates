from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import replace

from jsonschema import Draft202012Validator

from app.llm.base import (
    BaseLLMProvider,
    LLMProviderError,
    LLMStructuredOutputError,
)
from app.llm.capabilities import validate_request_against_model
from app.llm.pricing import calculate_cost
from app.llm.registry import ModelRegistry
from app.llm.types import LLMEvent, LLMRequest, LLMResponse, ModelSpec


class LLMService:
    def __init__(
        self,
        *,
        registry: ModelRegistry,
        providers: dict[str, BaseLLMProvider],
    ):
        self.registry = registry
        self.providers = providers

    async def generate(self, request: LLMRequest) -> LLMResponse:
        model_spec = self.registry.resolve(request.model, request.provider)
        validate_request_against_model(request, model_spec)

        provider = self.providers.get(model_spec.provider)
        if provider is None:
            raise LLMProviderError(
                f"No provider adapter is configured for '{model_spec.provider}'."
            )

        response = await provider.generate(request, model_spec)
        response = self._ensure_cost(response, model_spec)

        if request.response_mode == "structured":
            response = self._validate_structured_output(request, response)

        return response

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMEvent]:
        model_spec = self.registry.resolve(request.model, request.provider)
        validate_request_against_model(request, model_spec)

        provider = self.providers.get(model_spec.provider)
        if provider is None:
            raise LLMProviderError(
                f"No provider adapter is configured for '{model_spec.provider}'."
            )

        async for event in provider.stream(request, model_spec):
            yield event

    def _ensure_cost(self, response: LLMResponse, model_spec: ModelSpec) -> LLMResponse:
        if response.usage.cost_usd != 0:
            return response

        computed_cost = calculate_cost(
            model_spec.pricing,
            response.usage.input_tokens,
            response.usage.output_tokens,
        )

        return replace(
            response,
            usage=replace(response.usage, cost_usd=computed_cost),
        )

    def _validate_structured_output(
        self,
        request: LLMRequest,
        response: LLMResponse,
    ) -> LLMResponse:
        if request.output_schema is None:
            raise LLMStructuredOutputError("Structured output requested without schema.")

        parsed = response.structured_output
        raw = response.structured_output_raw

        if parsed is None and isinstance(raw, str):
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise LLMStructuredOutputError(
                    f"Structured output was not valid JSON: {exc}"
                ) from exc

        if parsed is None:
            raise LLMStructuredOutputError("Provider returned no structured output.")

        validator = Draft202012Validator(request.output_schema.schema)
        errors = sorted(validator.iter_errors(parsed), key=lambda error: error.path)
        if errors:
            formatted = "; ".join(error.message for error in errors[:5])
            raise LLMStructuredOutputError(
                f"Structured output failed schema validation: {formatted}"
            )

        return replace(
            response,
            structured_output=parsed,
            structured_output_valid=True,
            structured_output_error=None,
        )
