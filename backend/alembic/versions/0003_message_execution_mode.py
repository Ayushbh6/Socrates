"""add message execution mode

Revision ID: 0003_message_execution_mode
Revises: 0002_task_backed_agent
Create Date: 2026-04-19
"""

from alembic import op
import sqlalchemy as sa


revision = "0003_message_execution_mode"
down_revision = "0002_task_backed_agent"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "messages",
        sa.Column("execution_mode", sa.String(length=32), nullable=False, server_default=sa.text("'chat'")),
    )
    op.execute("UPDATE messages SET execution_mode = 'task' WHERE task_id IS NOT NULL")
    op.execute(
        """
        UPDATE messages
        SET execution_mode = 'task'
        WHERE task_id IS NULL
          AND agent_run_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM agent_runs
            WHERE agent_runs.id = messages.agent_run_id
              AND agent_runs.execution_mode = 'task'
          )
        """
    )


def downgrade() -> None:
    op.drop_column("messages", "execution_mode")
