from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI

from .api.v1 import build_api_router
from .core.settings import get_settings
from .db.migrations import run_migrations
from .services.chat import RunManager


def ensure_app_directories() -> None:
    settings = get_settings()
    directories = [
        settings.app_data_dir,
        settings.app_data_dir / "data",
        settings.uploads_dir,
        settings.logs_dir,
        settings.cache_dir,
        settings.projects_dir,
        settings.host_workspaces_dir,
    ]
    for directory in directories:
        Path(directory).mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_app_directories()
    run_migrations()
    app.state.run_manager = RunManager()
    yield


def create_app() -> FastAPI:
    app = FastAPI(title="PremChat Backend", lifespan=lifespan)
    app.include_router(build_api_router())
    return app


app = create_app()
