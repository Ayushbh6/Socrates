from __future__ import annotations

from abc import ABC, abstractmethod
from typing import AsyncIterator

from app.llm.types import LLMEvent, LLMRequest, LLMResponse, ModelSpec


class LLMError(Exception):
    """Base error for LLM integration failures."""


class ModelResolutionError(LLMError):
    """Raised when a model cannot be resolved to a provider."""


class LLMProviderError(LLMError):
    """Raised when a provider request fails."""


class LLMStructuredOutputError(LLMError):
    """Raised when structured output cannot be parsed or validated."""


class BaseLLMProvider(ABC):
    provider_name: str

    @abstractmethod
    async def generate(self, request: LLMRequest, model_spec: ModelSpec) -> LLMResponse:
        raise NotImplementedError

    async def stream(
        self,
        request: LLMRequest,
        model_spec: ModelSpec,
    ) -> AsyncIterator[LLMEvent]:
        raise NotImplementedError("Streaming is not implemented for this provider yet.")
