import os
import sys
from collections.abc import AsyncGenerator
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = ROOT_DIR / "backend"

if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.constants import DEV_USER_DISPLAY_NAME, DEV_USER_EMAIL, DEV_USER_ID
from app.db.base import Base
from app.db.models.user import User
from app.db.session import get_db_session
from app.main import app


def _get_test_database_url() -> str:
    database_url = os.getenv("TEST_DATABASE_URL") or os.getenv("DATABASE_URL")
    if not database_url:
        pytest.skip("Set TEST_DATABASE_URL or DATABASE_URL to run backend integration tests.")
    return database_url


@pytest.fixture
async def session_factory():
    database_url = _get_test_database_url()
    engine = create_async_engine(database_url, future=True)

    async with engine.begin() as connection:
        await connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await connection.run_sync(Base.metadata.drop_all)
        await connection.run_sync(Base.metadata.create_all)

    factory = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)

    async with factory() as session:
        session.add(
            User(
                id=DEV_USER_ID,
                email=DEV_USER_EMAIL,
                display_name=DEV_USER_DISPLAY_NAME,
                status="active",
                metadata_json={},
            )
        )
        await session.commit()

    try:
        yield factory
    finally:
        await engine.dispose()


@pytest.fixture
async def db_session(session_factory) -> AsyncGenerator[AsyncSession, None]:
    async with session_factory() as session:
        yield session


@pytest.fixture
async def client(session_factory):
    async def override_get_db_session():
        async with session_factory() as session:
            yield session

    app.dependency_overrides[get_db_session] = override_get_db_session

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
    ) as test_client:
        yield test_client

    app.dependency_overrides.clear()
