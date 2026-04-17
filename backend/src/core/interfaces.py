from abc import ABC, abstractmethod
from typing import AsyncGenerator, Generator, Any, Optional

from .schema import LLMRequest, LLMResponse

class BaseProvider(ABC):
    """
    Abstract base class for all LLM providers.
    Ensures a consistent, provider-agnostic interface across the application.
    """

    def __init__(self, model_name: str, **kwargs: Any):
        """
        Initialize the provider with a specific model name and any extra config 
        (like API keys, endpoint URLs, etc.).
        """
        self.model_name = model_name
        self.config = kwargs

    @abstractmethod
    def generate(self, request: LLMRequest) -> LLMResponse:
        """Synchronously generates a full response."""
        pass

    @abstractmethod
    async def agenerate(self, request: LLMRequest) -> LLMResponse:
        """Asynchronously generates a full response."""
        pass

    @abstractmethod
    def stream(self, request: LLMRequest) -> Generator[LLMResponse, None, None]:
        """Synchronously streams response chunks."""
        pass

    @abstractmethod
    def astream(self, request: LLMRequest) -> AsyncGenerator[LLMResponse, None]:
        """Asynchronously streams response chunks."""
        yield  # Placeholder for abstract method
