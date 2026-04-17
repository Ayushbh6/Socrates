from functools import lru_cache
from typing import Optional
from dotenv import find_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = find_dotenv(usecwd=True) or None

class Settings(BaseSettings):
    openai_api_key: Optional[str] = Field(default=None, validation_alias="OPENAI_API_KEY")
    openai_base_url: Optional[str] = Field(default=None, validation_alias="OPENAI_BASE_URL")
    gemini_api_key: Optional[str] = Field(default=None, validation_alias="GEMINI_API_KEY")
    openrouter_api_key: Optional[str] = Field(default=None, validation_alias="OPENROUTER_API_KEY")
    openrouter_base_url: str = Field(default="https://openrouter.ai/api/v1", validation_alias="OPENROUTER_BASE_URL")
    ollama_host: str = Field(default="http://localhost:11434", validation_alias="OLLAMA_HOST")
    ollama_api_key: Optional[str] = Field(default=None, validation_alias="OLLAMA_API_KEY")
    app_url: Optional[str] = Field(default=None, validation_alias="APP_URL")
    app_name: str = Field(default="PremChat", validation_alias="APP_NAME")

    model_config = SettingsConfigDict(
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

@lru_cache
def get_settings() -> Settings:
    return Settings()
