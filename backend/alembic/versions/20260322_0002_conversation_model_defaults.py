"""add conversation model defaults

Revision ID: 20260322_0002
Revises: 20260320_0001
Create Date: 2026-03-22 10:30:00
"""

from alembic import op
import sqlalchemy as sa


revision = "20260322_0002"
down_revision = "20260320_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "conversations",
        sa.Column("default_provider", sa.String(length=32), nullable=False, server_default="openai"),
    )
    op.add_column(
        "conversations",
        sa.Column("default_model", sa.String(length=255), nullable=False, server_default="gpt-5.2"),
    )
    op.add_column(
        "conversations",
        sa.Column("thinking_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    op.execute(
        """
        UPDATE conversations
        SET default_provider = 'openai',
            default_model = 'gpt-5.2',
            thinking_enabled = false
        """
    )

    op.alter_column("conversations", "default_provider", server_default=None)
    op.alter_column("conversations", "default_model", server_default=None)
    op.alter_column("conversations", "thinking_enabled", server_default=None)


def downgrade() -> None:
    op.drop_column("conversations", "thinking_enabled")
    op.drop_column("conversations", "default_model")
    op.drop_column("conversations", "default_provider")
