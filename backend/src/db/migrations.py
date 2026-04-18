from pathlib import Path

from alembic import command
from alembic.config import Config

from ..core.settings import get_settings


def get_alembic_config() -> Config:
    settings = get_settings()
    backend_dir = Path(__file__).resolve().parents[2]
    config = Config(str(backend_dir / "alembic.ini"))
    config.set_main_option("script_location", str(backend_dir / "alembic"))
    config.set_main_option("sqlalchemy.url", settings.database_url)
    return config


def run_migrations() -> None:
    command.upgrade(get_alembic_config(), "head")
