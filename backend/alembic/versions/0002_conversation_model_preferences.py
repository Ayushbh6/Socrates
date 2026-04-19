"""add conversation model preferences

Revision ID: 0002_conversation_model_preferences
Revises: 0001_initial_schema
Create Date: 2026-04-19
"""

from alembic import op
import sqlalchemy as sa


revision = "0002_conversation_model_preferences"
down_revision = "0001_initial_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column(
            "model",
            sa.String(length=255),
            nullable=False,
            server_default=sa.text("'openai/gpt-5.4-mini'"),
        ),
    )
    op.add_column(
        "conversations",
        sa.Column(
            "thinking_level",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'off'"),
        ),
    )


def downgrade() -> None:
    op.drop_column("conversations", "thinking_level")
    op.drop_column("conversations", "model")