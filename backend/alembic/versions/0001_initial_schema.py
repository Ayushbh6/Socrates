"""initial schema

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-04-18
"""

from alembic import op
import sqlalchemy as sa


revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def _utcnow():
    return sa.text("CURRENT_TIMESTAMP")


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.Column("onboarding_completed_at", sa.DateTime(timezone=True)),
        sa.Column("preferences_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )

    op.create_table(
        "projects",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("user_id", sa.String(length=36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("status", sa.String(length=64), nullable=False, server_default=sa.text("'active'")),
        sa.Column("default_system_prompt", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_projects_user_id", "projects", ["user_id"])

    op.create_table(
        "project_workspaces",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("project_id", sa.String(length=36), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("label", sa.String(length=255), nullable=False),
        sa.Column("root_path", sa.Text(), nullable=False),
        sa.Column("editor_type", sa.String(length=64), nullable=False, server_default=sa.text("'vscode'")),
        sa.Column("is_primary", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("access_granted", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("access_granted_at", sa.DateTime(timezone=True)),
        sa.Column("access_revoked_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
    )
    op.create_index("ix_project_workspaces_project_id", "project_workspaces", ["project_id"])

    op.create_table(
        "conversations",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("project_id", sa.String(length=36), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("summary", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_conversations_project_id", "conversations", ["project_id"])

    op.create_table(
        "agent_runs",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("project_id", sa.String(length=36), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("conversation_id", sa.String(length=36), sa.ForeignKey("conversations.id"), nullable=False),
        sa.Column("trigger_message_id", sa.String(length=36)),
        sa.Column("response_message_id", sa.String(length=36)),
        sa.Column("status", sa.String(length=64), nullable=False, server_default=sa.text("'queued'")),
        sa.Column("provider", sa.String(length=64)),
        sa.Column("model", sa.String(length=255), nullable=False),
        sa.Column("input_mode", sa.String(length=32), nullable=False, server_default=sa.text("'text'")),
        sa.Column("system_prompt_text", sa.Text(), nullable=False),
        sa.Column("query_text", sa.Text(), nullable=False),
        sa.Column("request_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("final_response_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("final_parsed_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("aggregated_metadata_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("usage_input_tokens", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("usage_output_tokens", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("usage_completion_tokens", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("usage_total_tokens", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("elapsed_ms", sa.Float(), nullable=False, server_default=sa.text("0")),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("error_message", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
    )
    op.create_index("ix_agent_runs_project_id", "agent_runs", ["project_id"])
    op.create_index("ix_agent_runs_conversation_id", "agent_runs", ["conversation_id"])
    op.create_index("ix_agent_runs_status", "agent_runs", ["status"])
    op.create_index("ix_agent_runs_trigger_message_id", "agent_runs", ["trigger_message_id"])
    op.create_index("ix_agent_runs_response_message_id", "agent_runs", ["response_message_id"])

    op.create_table(
        "messages",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("project_id", sa.String(length=36), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("conversation_id", sa.String(length=36), sa.ForeignKey("conversations.id"), nullable=False),
        sa.Column("agent_run_id", sa.String(length=36), sa.ForeignKey("agent_runs.id")),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("input_mode", sa.String(length=32), nullable=False, server_default=sa.text("'text'")),
        sa.Column("content_text", sa.Text()),
        sa.Column("thinking_text", sa.Text()),
        sa.Column("status", sa.String(length=64), nullable=False, server_default=sa.text("'completed'")),
        sa.Column("sequence_no", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=64)),
        sa.Column("model", sa.String(length=255)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.Column("failed_at", sa.DateTime(timezone=True)),
        sa.Column("metadata_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.UniqueConstraint("conversation_id", "sequence_no", name="uq_messages_conversation_sequence"),
    )
    op.create_index("ix_messages_project_id", "messages", ["project_id"])
    op.create_index("ix_messages_conversation_id", "messages", ["conversation_id"])
    op.create_index("ix_messages_agent_run_id", "messages", ["agent_run_id"])
    op.create_index("ix_messages_project_conversation", "messages", ["project_id", "conversation_id"])

    op.create_table(
        "assets",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("project_id", sa.String(length=36), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("uploaded_by_user_id", sa.String(length=36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("source_type", sa.String(length=64), nullable=False, server_default=sa.text("'upload'")),
        sa.Column("original_name", sa.String(length=255), nullable=False),
        sa.Column("mime_type", sa.String(length=255), nullable=False),
        sa.Column("storage_path", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.Column("deleted_at", sa.DateTime(timezone=True)),
        sa.Column("metadata_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.create_index("ix_assets_project_id", "assets", ["project_id"])
    op.create_index("ix_assets_uploaded_by_user_id", "assets", ["uploaded_by_user_id"])

    op.create_table(
        "message_assets",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("message_id", sa.String(length=36), sa.ForeignKey("messages.id"), nullable=False),
        sa.Column("asset_id", sa.String(length=36), sa.ForeignKey("assets.id"), nullable=False),
        sa.Column("relation_type", sa.String(length=64), nullable=False, server_default=sa.text("'attachment'")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
    )
    op.create_index("ix_message_assets_message_id", "message_assets", ["message_id"])
    op.create_index("ix_message_assets_asset_id", "message_assets", ["asset_id"])

    op.create_table(
        "agent_run_turns",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("agent_run_id", sa.String(length=36), sa.ForeignKey("agent_runs.id"), nullable=False),
        sa.Column("round_index", sa.Integer(), nullable=False),
        sa.Column("phase", sa.String(length=64), nullable=False, server_default=sa.text("'tool'")),
        sa.Column("provider", sa.String(length=64)),
        sa.Column("model", sa.String(length=255)),
        sa.Column("request_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("response_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("raw_dump_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("parsed_output_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("metadata_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("had_thinking", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("tool_call_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("parsed_output_present", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("usage_input_tokens", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("usage_output_tokens", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("usage_completion_tokens", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("usage_total_tokens", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("elapsed_ms", sa.Float(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.UniqueConstraint("agent_run_id", "round_index", name="uq_run_turn_round"),
    )
    op.create_index("ix_agent_run_turns_agent_run_id", "agent_run_turns", ["agent_run_id"])

    op.create_table(
        "agent_events",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("agent_run_id", sa.String(length=36), sa.ForeignKey("agent_runs.id"), nullable=False),
        sa.Column("agent_run_turn_id", sa.String(length=36), sa.ForeignKey("agent_run_turns.id")),
        sa.Column("sequence_no", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=64), nullable=False, server_default=sa.text("'ok'")),
        sa.Column("content_text", sa.Text()),
        sa.Column("thinking_text", sa.Text()),
        sa.Column("tool_call_ref", sa.String(length=255)),
        sa.Column("payload_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
        sa.UniqueConstraint("agent_run_id", "sequence_no", name="uq_agent_events_sequence"),
    )
    op.create_index("ix_agent_events_agent_run_id", "agent_events", ["agent_run_id"])
    op.create_index("ix_agent_events_agent_run_turn_id", "agent_events", ["agent_run_turn_id"])
    op.create_index("ix_agent_events_run_turn", "agent_events", ["agent_run_id", "agent_run_turn_id"])

    op.create_table(
        "tool_executions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("agent_run_id", sa.String(length=36), sa.ForeignKey("agent_runs.id")),
        sa.Column("agent_run_turn_id", sa.String(length=36), sa.ForeignKey("agent_run_turns.id")),
        sa.Column("agent_event_id", sa.String(length=36), sa.ForeignKey("agent_events.id")),
        sa.Column("tool_call_id", sa.String(length=255)),
        sa.Column("tool_name", sa.String(length=255), nullable=False),
        sa.Column("arguments_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("status", sa.String(length=64), nullable=False, server_default=sa.text("'pending'")),
        sa.Column("result_text", sa.Text()),
        sa.Column("result_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("error_text", sa.Text()),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("duration_ms", sa.Float()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
    )
    op.create_index("ix_tool_executions_agent_run_id", "tool_executions", ["agent_run_id"])
    op.create_index("ix_tool_executions_agent_run_turn_id", "tool_executions", ["agent_run_turn_id"])
    op.create_index("ix_tool_executions_agent_event_id", "tool_executions", ["agent_event_id"])
    op.create_index("ix_tool_executions_tool_call_id", "tool_executions", ["tool_call_id"])

    op.create_table(
        "workspace_actions",
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("project_workspace_id", sa.String(length=36), sa.ForeignKey("project_workspaces.id")),
        sa.Column("agent_run_id", sa.String(length=36), sa.ForeignKey("agent_runs.id")),
        sa.Column("tool_execution_id", sa.String(length=36), sa.ForeignKey("tool_executions.id")),
        sa.Column("action_type", sa.String(length=64), nullable=False),
        sa.Column("target_path", sa.Text()),
        sa.Column("command_text", sa.Text()),
        sa.Column("arguments_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("stdout_text", sa.Text()),
        sa.Column("stderr_text", sa.Text()),
        sa.Column("exit_code", sa.Integer()),
        sa.Column("success", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_utcnow()),
    )
    op.create_index("ix_workspace_actions_project_workspace_id", "workspace_actions", ["project_workspace_id"])
    op.create_index("ix_workspace_actions_agent_run_id", "workspace_actions", ["agent_run_id"])
    op.create_index("ix_workspace_actions_tool_execution_id", "workspace_actions", ["tool_execution_id"])


def downgrade() -> None:
    op.drop_index("ix_workspace_actions_tool_execution_id", table_name="workspace_actions")
    op.drop_index("ix_workspace_actions_agent_run_id", table_name="workspace_actions")
    op.drop_index("ix_workspace_actions_project_workspace_id", table_name="workspace_actions")
    op.drop_table("workspace_actions")
    op.drop_index("ix_tool_executions_tool_call_id", table_name="tool_executions")
    op.drop_index("ix_tool_executions_agent_event_id", table_name="tool_executions")
    op.drop_index("ix_tool_executions_agent_run_turn_id", table_name="tool_executions")
    op.drop_index("ix_tool_executions_agent_run_id", table_name="tool_executions")
    op.drop_table("tool_executions")
    op.drop_index("ix_agent_events_run_turn", table_name="agent_events")
    op.drop_index("ix_agent_events_agent_run_turn_id", table_name="agent_events")
    op.drop_index("ix_agent_events_agent_run_id", table_name="agent_events")
    op.drop_table("agent_events")
    op.drop_index("ix_agent_run_turns_agent_run_id", table_name="agent_run_turns")
    op.drop_table("agent_run_turns")
    op.drop_index("ix_message_assets_asset_id", table_name="message_assets")
    op.drop_index("ix_message_assets_message_id", table_name="message_assets")
    op.drop_table("message_assets")
    op.drop_index("ix_assets_uploaded_by_user_id", table_name="assets")
    op.drop_index("ix_assets_project_id", table_name="assets")
    op.drop_table("assets")
    op.drop_index("ix_messages_project_conversation", table_name="messages")
    op.drop_index("ix_messages_agent_run_id", table_name="messages")
    op.drop_index("ix_messages_conversation_id", table_name="messages")
    op.drop_index("ix_messages_project_id", table_name="messages")
    op.drop_table("messages")
    op.drop_index("ix_agent_runs_response_message_id", table_name="agent_runs")
    op.drop_index("ix_agent_runs_trigger_message_id", table_name="agent_runs")
    op.drop_index("ix_agent_runs_status", table_name="agent_runs")
    op.drop_index("ix_agent_runs_conversation_id", table_name="agent_runs")
    op.drop_index("ix_agent_runs_project_id", table_name="agent_runs")
    op.drop_table("agent_runs")
    op.drop_index("ix_conversations_project_id", table_name="conversations")
    op.drop_table("conversations")
    op.drop_index("ix_project_workspaces_project_id", table_name="project_workspaces")
    op.drop_table("project_workspaces")
    op.drop_index("ix_projects_user_id", table_name="projects")
    op.drop_table("projects")
    op.drop_table("users")
