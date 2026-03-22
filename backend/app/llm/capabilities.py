from app.llm.base import LLMProviderError
from app.llm.types import LLMRequest, ModelSpec


def validate_request_against_model(request: LLMRequest, model_spec: ModelSpec) -> None:
    has_images = any(
        part.type == "image"
        for message in request.messages
        for part in message.content
    )

    if request.tools and not model_spec.supports_tools:
        raise LLMProviderError(f"Model '{model_spec.public_id}' does not support tools.")

    if has_images and not model_spec.supports_images:
        raise LLMProviderError(f"Model '{model_spec.public_id}' does not support images.")

    if request.thinking_enabled and not model_spec.supports_thinking:
        raise LLMProviderError(
            f"Model '{model_spec.public_id}' does not support thinking mode."
        )

    if request.response_mode == "structured":
        if request.output_schema is None:
            raise LLMProviderError("Structured response mode requires an output schema.")
        if not model_spec.supports_structured_output:
            raise LLMProviderError(
                f"Model '{model_spec.public_id}' does not support structured output."
            )
        if request.output_schema.strict and not model_spec.supports_strict_schema:
            raise LLMProviderError(
                f"Model '{model_spec.public_id}' does not support strict structured schemas."
            )
