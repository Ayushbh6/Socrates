from functools import lru_cache

from app.core.config import settings
from app.llm.providers.fake import FakeProvider
from app.llm.providers.openai import OpenAIProvider
from app.llm.providers.openrouter import OpenRouterProvider
from app.llm.registry import ModelRegistry
from app.llm.service import LLMService


@lru_cache
def build_llm_service() -> LLMService:
    providers = {}

    if settings.premchat_fake_llm:
        providers["openai"] = FakeProvider("openai")
        providers["openrouter"] = FakeProvider("openrouter")
        return LLMService(
            registry=ModelRegistry(),
            providers=providers,
        )

    if settings.openai_api_key:
        providers["openai"] = OpenAIProvider(api_key=settings.openai_api_key)
    if settings.openrouter_api_key:
        providers["openrouter"] = OpenRouterProvider(
            api_key=settings.openrouter_api_key,
            base_url=settings.openrouter_base_url,
            app_url=settings.openrouter_app_url,
            app_title=settings.openrouter_app_title,
        )

    return LLMService(
        registry=ModelRegistry(),
        providers=providers,
    )
