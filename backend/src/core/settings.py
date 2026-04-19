import os
import platform
from functools import lru_cache
from pathlib import Path
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
    app_data_dir: Optional[Path] = Field(default=None, validation_alias="APP_DATA_DIR")
    database_url: Optional[str] = Field(default=None, validation_alias="DATABASE_URL")
    uploads_dir: Optional[Path] = Field(default=None, validation_alias="UPLOADS_DIR")
    logs_dir: Optional[Path] = Field(default=None, validation_alias="LOGS_DIR")
    cache_dir: Optional[Path] = Field(default=None, validation_alias="CACHE_DIR")
    projects_dir: Optional[Path] = Field(default=None, validation_alias="PROJECTS_DIR")
    host_workspaces_dir: Optional[Path] = Field(default=None, validation_alias="HOST_WORKSPACES_DIR")

    model_config = SettingsConfigDict(
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    def model_post_init(self, __context: object) -> None:
        if self.app_data_dir is None:
            self.app_data_dir = self._default_app_data_dir(self.app_name)

        data_dir = self.app_data_dir / "data"
        if self.database_url is None:
            self.database_url = f"sqlite:///{(data_dir / 'premchat.db').resolve()}"

        if self.uploads_dir is None:
            self.uploads_dir = self.app_data_dir / "files" / "uploads"

        if self.logs_dir is None:
            self.logs_dir = self.app_data_dir / "logs"

        if self.cache_dir is None:
            self.cache_dir = self.app_data_dir / "cache"

        if self.projects_dir is None:
            self.projects_dir = self.app_data_dir / "projects"

        if self.host_workspaces_dir is None:
            self.host_workspaces_dir = self.app_data_dir / "host-workspaces"

    @staticmethod
    def _default_app_data_dir(app_name: str) -> Path:
        home = Path.home()
        system = platform.system()
        if system == "Darwin":
            return home / "Library" / "Application Support" / app_name
        if system == "Windows":
            local_app_data = os.environ.get("LOCALAPPDATA")
            if local_app_data:
                return Path(local_app_data) / app_name
            return home / "AppData" / "Local" / app_name
        return home / ".local" / "share" / app_name

@lru_cache
def get_settings() -> Settings:
    return Settings()
