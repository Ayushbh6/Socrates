import os
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text


def _sync_database_url() -> str:
    database_url = os.getenv("TEST_DATABASE_URL") or os.getenv("DATABASE_URL")
    if not database_url:
        pytest.skip("Set TEST_DATABASE_URL or DATABASE_URL to run backend migration tests.")
    return database_url.replace("+asyncpg", "+psycopg")


def test_migration_creates_schema_and_seed_user():
    database_url = _sync_database_url()
    backend_dir = Path(__file__).resolve().parents[1]
    alembic_config = Config(str(backend_dir / "alembic.ini"))
    alembic_config.set_main_option("script_location", str(backend_dir / "alembic"))
    alembic_config.set_main_option("sqlalchemy.url", database_url)

    engine = create_engine(database_url, future=True)

    with engine.begin() as connection:
        connection.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
        connection.execute(text("CREATE SCHEMA public"))
        connection.execute(text("GRANT ALL ON SCHEMA public TO PUBLIC"))
        connection.execute(text("GRANT ALL ON SCHEMA public TO CURRENT_USER"))

    command.upgrade(alembic_config, "head")

    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    indexes = {index["name"] for index in inspector.get_indexes("messages")}

    assert {
        "users",
        "conversations",
        "messages",
        "message_attachments",
        "message_tool_calls",
        "llm_events",
    }.issubset(tables)
    assert "ix_messages_conversation_id_sequence_number" in indexes
    assert "ix_messages_conversation_id_created_at" in indexes

    with engine.connect() as connection:
        pgvector_enabled = connection.execute(
            text("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')")
        ).scalar_one()
        seeded_user_count = connection.execute(
            text("SELECT COUNT(*) FROM users WHERE id = '00000000-0000-0000-0000-000000000001'")
        ).scalar_one()

    assert pgvector_enabled is True
    assert seeded_user_count == 1

    engine.dispose()
