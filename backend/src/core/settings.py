from functools import lru_cache

from dotenv import find_dotenv
from pydantic_settings import BaseSettings, SettingsConfigDict


_ENV_FILE = find_dotenv(usecwd=True) or None


class Settings(BaseSettings):
    openai_api_key: str | None = None
    openai_base_url: str | None = None

    model_config = SettingsConfigDict(
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()