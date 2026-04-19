from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .schema import ThinkingLevel

ThinkingProfile = Literal["standard", "binary", "discrete-no-off"]


@dataclass(frozen=True)
class SupportedModel:
    id: str
    provider: str
    label: str
    thinking_profile: ThinkingProfile


SUPPORTED_MODELS: tuple[SupportedModel, ...] = (
    SupportedModel("openai/gpt-5.4-mini", "openai", "GPT-5.4 Mini", "standard"),
    SupportedModel("openai/gpt-5.4-nano", "openai", "GPT-5.4 Nano", "standard"),
    SupportedModel("openrouter/qwen/qwen3.6-plus", "openrouter", "Qwen 3.6 Plus", "binary"),
    SupportedModel("openrouter/z-ai/glm-5.1:nitro", "openrouter", "GLM 5.1 Nitro", "binary"),
    SupportedModel("openrouter/moonshotai/kimi-k2.5:nitro", "openrouter", "Kimi K2.5 Nitro", "binary"),
    SupportedModel("openrouter/x-ai/grok-4.20", "openrouter", "Grok 4.20", "binary"),
    SupportedModel("openrouter/minimax/minimax-m2.7:nitro", "openrouter", "MiniMax M2.7 Nitro", "binary"),
    SupportedModel("gemini/gemini-3-flash-preview", "gemini", "Gemini 3 Flash Preview", "standard"),
    SupportedModel("gemini/gemini-3.1-pro-preview", "gemini", "Gemini 3.1 Pro Preview", "standard"),
    SupportedModel("ollama/gemma4:31b-cloud", "ollama", "Gemma 4 31B Cloud", "binary"),
    SupportedModel("ollama/gpt-oss:120b-cloud", "ollama", "GPT-OSS 120B Cloud", "discrete-no-off"),
)

SUPPORTED_MODELS_BY_ID = {model.id: model for model in SUPPORTED_MODELS}

DEFAULT_MODEL = "openai/gpt-5.4-mini"
DEFAULT_THINKING_LEVEL = ThinkingLevel.OFF


def get_supported_model(model_id: str) -> SupportedModel | None:
    return SUPPORTED_MODELS_BY_ID.get(model_id)


def require_supported_model(model_id: str) -> SupportedModel:
    model = get_supported_model(model_id)
    if model is None:
        raise ValueError(f"Unsupported model '{model_id}'.")
    return model


def normalize_thinking_level(model_id: str, level: ThinkingLevel) -> ThinkingLevel:
    model = require_supported_model(model_id)

    if model.thinking_profile == "standard":
        return level

    if model.thinking_profile == "binary":
        return ThinkingLevel.OFF if level == ThinkingLevel.OFF else ThinkingLevel.LOW

    if model.thinking_profile == "discrete-no-off":
        return ThinkingLevel.LOW if level == ThinkingLevel.OFF else level

    return level


def provider_for_model(model_id: str) -> str:
    return require_supported_model(model_id).provider