from fastapi import APIRouter

from app.llm.registry import ModelRegistry
from app.schemas.model import ModelListEnvelope, ModelResponse


router = APIRouter()


@router.get("", response_model=ModelListEnvelope)
async def get_models() -> ModelListEnvelope:
    registry = ModelRegistry()
    models = [
        ModelResponse(
            id=model.public_id,
            provider=model.provider,
            display_name=model.display_name,
            supports_thinking=model.supports_thinking,
            supports_images=model.supports_images,
            supports_tools=model.supports_tools,
            supports_structured_output=model.supports_structured_output,
        )
        for model in registry.list_models()
    ]
    return ModelListEnvelope(models=models)
