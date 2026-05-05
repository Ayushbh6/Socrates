from functools import lru_cache
from pathlib import Path
from typing import Optional
from dotenv import find_dotenv
from pydantic import AliasChoices, Field
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
    socrates_home: Optional[Path] = Field(default=None, validation_alias="SOCRATES_HOME")
    socrates_home_host: Optional[Path] = Field(
        default=None,
        validation_alias=AliasChoices("SOCRATES_HOME_HOST", "APP_DATA_HOST_DIR"),
    )
    socrates_runtime_dir: Optional[Path] = Field(default=None, validation_alias="SOCRATES_RUNTIME_DIR")
    socrates_projects_dir: Optional[Path] = Field(
        default=None,
        validation_alias=AliasChoices("SOCRATES_PROJECTS_DIR", "PROJECTS_DIR"),
    )
    socrates_python_venv: Optional[Path] = Field(default=None, validation_alias="SOCRATES_PYTHON_VENV")
    app_data_dir: Optional[Path] = Field(default=None, validation_alias="APP_DATA_DIR")
    database_url: Optional[str] = Field(default=None, validation_alias="DATABASE_URL")
    uploads_dir: Optional[Path] = Field(default=None, validation_alias="UPLOADS_DIR")
    logs_dir: Optional[Path] = Field(default=None, validation_alias="LOGS_DIR")
    cache_dir: Optional[Path] = Field(default=None, validation_alias="CACHE_DIR")
    host_workspaces_dir: Optional[Path] = Field(default=None, validation_alias="HOST_WORKSPACES_DIR")

    stream_delta_flush_ms: int = Field(default=60, validation_alias="STREAM_DELTA_FLUSH_MS")
    stream_delta_flush_chars: int = Field(default=80, validation_alias="STREAM_DELTA_FLUSH_CHARS")
    stream_heartbeat_interval_seconds: int = Field(default=15, validation_alias="STREAM_HEARTBEAT_INTERVAL_SECONDS")

    model_config = SettingsConfigDict(
        env_file=_ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    def model_post_init(self, __context: object) -> None:
        if self.socrates_home is None:
            self.socrates_home = self.app_data_dir or self._default_socrates_home()

        if self.app_data_dir is None:
            self.app_data_dir = self.socrates_home / "app-data"

        data_dir = self.app_data_dir / "data"
        if self.database_url is None:
            self.database_url = f"sqlite:///{(data_dir / 'premchat.db').resolve()}"

        if self.uploads_dir is None:
            self.uploads_dir = self.app_data_dir / "files" / "uploads"

        if self.logs_dir is None:
            self.logs_dir = self.socrates_home / "logs"

        if self.cache_dir is None:
            self.cache_dir = self.socrates_home / "cache"

        if self.socrates_runtime_dir is None:
            self.socrates_runtime_dir = self.socrates_home / "runtime"

        if self.socrates_python_venv is None:
            self.socrates_python_venv = self.socrates_runtime_dir / "python" / "venv"

        if self.socrates_projects_dir is None:
            self.socrates_projects_dir = self.socrates_home / "projects"

        if self.host_workspaces_dir is None:
            self.host_workspaces_dir = self.socrates_home / "host-workspaces"

    @property
    def projects_dir(self) -> Path:
        return self.socrates_projects_dir

    @property
    def app_data_host_dir(self) -> Path | None:
        return self.socrates_home_host

    @staticmethod
    def _default_socrates_home() -> Path:
        return Path.home() / ".socrates"

@lru_cache
def get_settings() -> Settings:
    return Settings()
