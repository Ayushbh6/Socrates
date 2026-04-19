"""task backed agent

Revision ID: 0002_task_backed_agent
Revises: 0002_conversation_model_preferences
Create Date: 2026-04-19
"""

from alembic import op
import sqlalchemy as sa


revision = "0002_task_backed_agent"
down_revision = "0002_conversation_model_preferences"
branch_labels = None
depends_on = None


def _utcnow():
    return sa.text("CURRENT_TIMESTAMP")


def upgrade() -> None:
    op.create_table(
        "tasks",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("project_id", sa.String(length=36), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("conversation_id", sa.String(length=36), sa.ForeignKey("conversations.id"), nullable=False),
        sa.Column("project_workspace_id", sa.String(length=36), sa.ForeignKey("project_workspaces.id")),
        sa.Column("created_from_agent_run_id", sa.String(length=36), sa.ForeignKey("agent_runs.id")),
        sa.Column("last_agent_run_id", sa.String(length=36), sa.ForeignKey("agent_runs.id")),
        sa.Column("status", sa.String(length=64), nullable=False, server_default=sa.text("'active'")),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("goal_text", sa.Text(), nullable=False),
        sa.Column("success_criteria_text", sa.Text()),
        sa.Column("brief_markdown", sa.Text(), nullable=False),
        sa.Column("workspace_root", sa.Text(), nullable=False),
        sa.Column("venv_path", sa.Text(), nullable=False),
        sa.Column("result_summary", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("failed_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_tasks_project_id", "tasks", ["project_id"])
    op.create_index("ix_tasks_conversation_id", "tasks", ["conversation_id"])
    op.create_index("ix_tasks_project_workspace_id", "tasks", ["project_workspace_id"])
    op.create_index("ix_tasks_created_from_agent_run_id", "tasks", ["created_from_agent_run_id"])
    op.create_index("ix_tasks_last_agent_run_id", "tasks", ["last_agent_run_id"])
    op.create_index("ix_tasks_status", "tasks", ["status"])

    op.add_column("agent_runs", sa.Column("task_id", sa.String(length=36)))
    op.add_column("agent_runs", sa.Column("execution_mode", sa.String(length=32), nullable=False, server_default=sa.text("'chat'")))
    op.create_index("ix_agent_runs_task_id", "agent_runs", ["task_id"])

    op.add_column("messages", sa.Column("task_id", sa.String(length=36)))
    op.create_index("ix_messages_task_id", "messages", ["task_id"])

    op.add_column("assets", sa.Column("created_by_task_id", sa.String(length=36)))
    op.create_index("ix_assets_created_by_task_id", "assets", ["created_by_task_id"])

    op.add_column("tool_executions", sa.Column("task_id", sa.String(length=36)))
    op.create_index("ix_tool_executions_task_id", "tool_executions", ["task_id"])

    op.add_column("workspace_actions", sa.Column("task_id", sa.String(length=36)))
    op.add_column(
        "workspace_actions",
        sa.Column("workspace_scope", sa.String(length=32), nullable=False, server_default=sa.text("'managed_task'")),
    )
    op.create_index("ix_workspace_actions_task_id", "workspace_actions", ["task_id"])

    op.create_table(
        "task_approvals",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("task_id", sa.String(length=36), sa.ForeignKey("tasks.id"), nullable=False),
        sa.Column("agent_run_id", sa.String(length=36), sa.ForeignKey("agent_runs.id")),
        sa.Column("tool_execution_id", sa.String(length=36), sa.ForeignKey("tool_executions.id")),
        sa.Column("approval_type", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default=sa.text("'pending'")),
        sa.Column("request_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("decision_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("requested_at", sa.DateTime(timezone=True)),
        sa.Column("resolved_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
    )
    op.create_index("ix_task_approvals_task_id", "task_approvals", ["task_id"])
    op.create_index("ix_task_approvals_agent_run_id", "task_approvals", ["agent_run_id"])
    op.create_index("ix_task_approvals_tool_execution_id", "task_approvals", ["tool_execution_id"])
    op.create_index("ix_task_approvals_status", "task_approvals", ["status"])

    op.create_table(
        "task_artifacts",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("task_id", sa.String(length=36), sa.ForeignKey("tasks.id"), nullable=False),
        sa.Column("asset_id", sa.String(length=36), sa.ForeignKey("assets.id")),
        sa.Column("relative_path", sa.Text(), nullable=False),
        sa.Column("artifact_role", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("mime_type", sa.String(length=255)),
        sa.Column("size_bytes", sa.Integer()),
        sa.Column("sha256", sa.String(length=64)),
        sa.Column("promoted_to_asset", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("metadata_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
    )
    op.create_index("ix_task_artifacts_task_id", "task_artifacts", ["task_id"])
    op.create_index("ix_task_artifacts_asset_id", "task_artifacts", ["asset_id"])


def downgrade() -> None:
    op.drop_index("ix_task_artifacts_asset_id", table_name="task_artifacts")
    op.drop_index("ix_task_artifacts_task_id", table_name="task_artifacts")
    op.drop_table("task_artifacts")

    op.drop_index("ix_task_approvals_status", table_name="task_approvals")
    op.drop_index("ix_task_approvals_tool_execution_id", table_name="task_approvals")
    op.drop_index("ix_task_approvals_agent_run_id", table_name="task_approvals")
    op.drop_index("ix_task_approvals_task_id", table_name="task_approvals")
    op.drop_table("task_approvals")

    op.drop_index("ix_workspace_actions_task_id", table_name="workspace_actions")
    op.drop_column("workspace_actions", "workspace_scope")
    op.drop_column("workspace_actions", "task_id")

    op.drop_index("ix_tool_executions_task_id", table_name="tool_executions")
    op.drop_column("tool_executions", "task_id")

    op.drop_index("ix_assets_created_by_task_id", table_name="assets")
    op.drop_column("assets", "created_by_task_id")

    op.drop_index("ix_messages_task_id", table_name="messages")
    op.drop_column("messages", "task_id")

    op.drop_index("ix_agent_runs_task_id", table_name="agent_runs")
    op.drop_column("agent_runs", "execution_mode")
    op.drop_column("agent_runs", "task_id")

    op.drop_index("ix_tasks_status", table_name="tasks")
    op.drop_index("ix_tasks_last_agent_run_id", table_name="tasks")
    op.drop_index("ix_tasks_created_from_agent_run_id", table_name="tasks")
    op.drop_index("ix_tasks_project_workspace_id", table_name="tasks")
    op.drop_index("ix_tasks_conversation_id", table_name="tasks")
    op.drop_index("ix_tasks_project_id", table_name="tasks")
    op.drop_table("tasks")
