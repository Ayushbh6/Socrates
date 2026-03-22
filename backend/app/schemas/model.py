from app.schemas.base import APIModel


class ModelResponse(APIModel):
    id: str
    provider: str
    display_name: str
    supports_thinking: bool
    supports_images: bool
    supports_tools: bool
    supports_structured_output: bool


class ModelListEnvelope(APIModel):
    models: list[ModelResponse]
