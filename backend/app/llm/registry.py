from decimal import Decimal

from app.llm.base import ModelResolutionError
from app.llm.types import ModelPricing, ModelSpec


class ModelRegistry:
    def __init__(self, models: list[ModelSpec] | None = None):
        resolved = models or default_models()
        self._models = {model.public_id: model for model in resolved}

    def resolve(self, model_id: str, provider: str | None = None) -> ModelSpec:
        model = self._models.get(model_id)
        if model is None:
            raise ModelResolutionError(f"Unknown model '{model_id}'.")
        if provider is not None and model.provider != provider:
            raise ModelResolutionError(
                f"Model '{model_id}' is registered under provider '{model.provider}', not '{provider}'."
            )
        return model

    def list_models(self) -> list[ModelSpec]:
        return list(self._models.values())


def default_models() -> list[ModelSpec]:
    return [
        ModelSpec(
            public_id="gpt-5.2",
            provider="openai",
            upstream_model_id="gpt-5.2",
            display_name="GPT-5.2",
            supports_thinking=True,
            pricing=ModelPricing(
                input_per_million_usd=Decimal("0"),
                output_per_million_usd=Decimal("0"),
            ),
        ),
        ModelSpec(
            public_id="gpt-5.4-mini",
            provider="openai",
            upstream_model_id="gpt-5.4-mini",
            display_name="GPT-5.4 Mini",
            supports_thinking=True,
        ),
        ModelSpec(
            public_id="minimax/minimax-m2.7",
            provider="openrouter",
            upstream_model_id="minimax/minimax-m2.7",
            display_name="MiniMax M2.7",
            supports_thinking=True,
            supports_reasoning_continuity=True,
            reasoning_cannot_be_disabled=True,
        ),
        ModelSpec(
            public_id="qwen/qwen3.5-397b-a17b",
            provider="openrouter",
            upstream_model_id="qwen/qwen3.5-397b-a17b",
            display_name="Qwen 3.5 397B A17B",
            supports_thinking=True,
            supports_reasoning_continuity=True,
            reasoning_cannot_be_disabled=True,
        ),
        ModelSpec(
            public_id="moonshotai/kimi-k2.5",
            provider="openrouter",
            upstream_model_id="moonshotai/kimi-k2.5",
            display_name="Kimi K2.5",
            supports_thinking=True,
            supports_reasoning_continuity=True,
            reasoning_cannot_be_disabled=True,
        ),
    ]
