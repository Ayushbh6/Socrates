import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from .base import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def uuid_str() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    display_name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)
    onboarding_completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    preferences_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    projects: Mapped[list["Project"]] = relationship(back_populates="user")


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(64), default="active", nullable=False)
    default_system_prompt: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)
    archived_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    user: Mapped["User"] = relationship(back_populates="projects")
    conversations: Mapped[list["Conversation"]] = relationship(back_populates="project")
    assets: Mapped[list["Asset"]] = relationship(back_populates="project")
    workspaces: Mapped[list["ProjectWorkspace"]] = relationship(back_populates="project")
    tasks: Mapped[list["Task"]] = relationship(back_populates="project")


class ProjectWorkspace(Base):
    __tablename__ = "project_workspaces"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True, nullable=False)
    label: Mapped[str] = mapped_column(String(255), nullable=False)
    root_path: Mapped[str] = mapped_column(Text, nullable=False)
    editor_type: Mapped[str] = mapped_column(String(64), default="vscode", nullable=False)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    access_granted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    access_granted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    access_revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)

    project: Mapped["Project"] = relationship(back_populates="workspaces")


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    summary: Mapped[Optional[str]] = mapped_column(Text)
    model: Mapped[str] = mapped_column(String(255), nullable=False, default="openai/gpt-5.4-mini")
    thinking_level: Mapped[str] = mapped_column(String(32), nullable=False, default="off")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)
    archived_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    project: Mapped["Project"] = relationship(back_populates="conversations")
    messages: Mapped[list["MessageRecord"]] = relationship(back_populates="conversation")
    tasks: Mapped[list["Task"]] = relationship(back_populates="conversation")


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True, nullable=False)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True, nullable=False)
    project_workspace_id: Mapped[Optional[str]] = mapped_column(ForeignKey("project_workspaces.id"), index=True)
    created_from_agent_run_id: Mapped[Optional[str]] = mapped_column(ForeignKey("agent_runs.id"), index=True)
    last_agent_run_id: Mapped[Optional[str]] = mapped_column(ForeignKey("agent_runs.id"), index=True)
    status: Mapped[str] = mapped_column(String(64), default="active", nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    goal_text: Mapped[str] = mapped_column(Text, nullable=False)
    success_criteria_text: Mapped[Optional[str]] = mapped_column(Text)
    brief_markdown: Mapped[str] = mapped_column(Text, nullable=False)
    workspace_root: Mapped[str] = mapped_column(Text, nullable=False)
    venv_path: Mapped[str] = mapped_column(Text, nullable=False)
    result_summary: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    failed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    project: Mapped["Project"] = relationship(back_populates="tasks")
    conversation: Mapped["Conversation"] = relationship(back_populates="tasks")
    artifacts: Mapped[list["TaskArtifact"]] = relationship(back_populates="task")
    approvals: Mapped[list["TaskApproval"]] = relationship(back_populates="task")


class AgentRun(Base):
    __tablename__ = "agent_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True, nullable=False)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True, nullable=False)
    task_id: Mapped[Optional[str]] = mapped_column(ForeignKey("tasks.id"), index=True)
    trigger_message_id: Mapped[Optional[str]] = mapped_column(String(36), index=True)
    response_message_id: Mapped[Optional[str]] = mapped_column(String(36), index=True)
    status: Mapped[str] = mapped_column(String(64), default="queued", nullable=False, index=True)
    execution_mode: Mapped[str] = mapped_column(String(32), default="chat", nullable=False)
    provider: Mapped[Optional[str]] = mapped_column(String(64))
    model: Mapped[str] = mapped_column(String(255), nullable=False)
    input_mode: Mapped[str] = mapped_column(String(32), default="text", nullable=False)
    system_prompt_text: Mapped[str] = mapped_column(Text, nullable=False)
    query_text: Mapped[str] = mapped_column(Text, nullable=False)
    request_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    final_response_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    final_parsed_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    aggregated_metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    usage_input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    usage_output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    usage_completion_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    usage_total_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    elapsed_ms: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    error_message: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    messages: Mapped[list["MessageRecord"]] = relationship(back_populates="agent_run")
    turns: Mapped[list["AgentRunTurn"]] = relationship(back_populates="agent_run")
    events: Mapped[list["AgentEventRecord"]] = relationship(back_populates="agent_run")


class MessageRecord(Base):
    __tablename__ = "messages"
    __table_args__ = (
        UniqueConstraint("conversation_id", "sequence_no", name="uq_messages_conversation_sequence"),
        Index("ix_messages_project_conversation", "project_id", "conversation_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True, nullable=False)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True, nullable=False)
    agent_run_id: Mapped[Optional[str]] = mapped_column(ForeignKey("agent_runs.id"), index=True)
    task_id: Mapped[Optional[str]] = mapped_column(ForeignKey("tasks.id"), index=True)
    execution_mode: Mapped[str] = mapped_column(String(32), default="chat", nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    input_mode: Mapped[str] = mapped_column(String(32), default="text", nullable=False)
    content_text: Mapped[Optional[str]] = mapped_column(Text)
    thinking_text: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(64), default="completed", nullable=False)
    sequence_no: Mapped[int] = mapped_column(Integer, nullable=False)
    provider: Mapped[Optional[str]] = mapped_column(String(64))
    model: Mapped[Optional[str]] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)
    failed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    conversation: Mapped["Conversation"] = relationship(back_populates="messages")
    agent_run: Mapped[Optional["AgentRun"]] = relationship(back_populates="messages")
    asset_links: Mapped[list["MessageAsset"]] = relationship(back_populates="message")


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True, nullable=False)
    uploaded_by_user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True, nullable=False)
    created_by_task_id: Mapped[Optional[str]] = mapped_column(ForeignKey("tasks.id"), index=True)
    kind: Mapped[str] = mapped_column(String(64), nullable=False)
    source_type: Mapped[str] = mapped_column(String(64), default="upload", nullable=False)
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)

    project: Mapped["Project"] = relationship(back_populates="assets")
    message_links: Mapped[list["MessageAsset"]] = relationship(back_populates="asset")


class MessageAsset(Base):
    __tablename__ = "message_assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    message_id: Mapped[str] = mapped_column(ForeignKey("messages.id"), index=True, nullable=False)
    asset_id: Mapped[str] = mapped_column(ForeignKey("assets.id"), index=True, nullable=False)
    relation_type: Mapped[str] = mapped_column(String(64), default="attachment", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    message: Mapped["MessageRecord"] = relationship(back_populates="asset_links")
    asset: Mapped["Asset"] = relationship(back_populates="message_links")


class AgentRunTurn(Base):
    __tablename__ = "agent_run_turns"
    __table_args__ = (UniqueConstraint("agent_run_id", "round_index", name="uq_run_turn_round"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    agent_run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), index=True, nullable=False)
    round_index: Mapped[int] = mapped_column(Integer, nullable=False)
    phase: Mapped[str] = mapped_column(String(64), default="tool", nullable=False)
    provider: Mapped[Optional[str]] = mapped_column(String(64))
    model: Mapped[Optional[str]] = mapped_column(String(255))
    request_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    response_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    raw_dump_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    parsed_output_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    had_thinking: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    tool_call_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    parsed_output_present: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    usage_input_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    usage_output_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    usage_completion_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    usage_total_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    elapsed_ms: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    agent_run: Mapped["AgentRun"] = relationship(back_populates="turns")
    events: Mapped[list["AgentEventRecord"]] = relationship(back_populates="turn")


class AgentEventRecord(Base):
    __tablename__ = "agent_events"
    __table_args__ = (
        UniqueConstraint("agent_run_id", "sequence_no", name="uq_agent_events_sequence"),
        Index("ix_agent_events_run_turn", "agent_run_id", "agent_run_turn_id"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    agent_run_id: Mapped[str] = mapped_column(ForeignKey("agent_runs.id"), index=True, nullable=False)
    agent_run_turn_id: Mapped[Optional[str]] = mapped_column(ForeignKey("agent_run_turns.id"), index=True)
    sequence_no: Mapped[int] = mapped_column(Integer, nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(64), default="ok", nullable=False)
    content_text: Mapped[Optional[str]] = mapped_column(Text)
    thinking_text: Mapped[Optional[str]] = mapped_column(Text)
    tool_call_ref: Mapped[Optional[str]] = mapped_column(String(255))
    payload_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    agent_run: Mapped["AgentRun"] = relationship(back_populates="events")
    turn: Mapped[Optional["AgentRunTurn"]] = relationship(back_populates="events")


class ToolExecution(Base):
    __tablename__ = "tool_executions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    agent_run_id: Mapped[Optional[str]] = mapped_column(ForeignKey("agent_runs.id"), index=True)
    agent_run_turn_id: Mapped[Optional[str]] = mapped_column(ForeignKey("agent_run_turns.id"), index=True)
    agent_event_id: Mapped[Optional[str]] = mapped_column(ForeignKey("agent_events.id"), index=True)
    task_id: Mapped[Optional[str]] = mapped_column(ForeignKey("tasks.id"), index=True)
    tool_call_id: Mapped[Optional[str]] = mapped_column(String(255), index=True)
    tool_name: Mapped[str] = mapped_column(String(255), nullable=False)
    arguments_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    status: Mapped[str] = mapped_column(String(64), default="pending", nullable=False)
    result_text: Mapped[Optional[str]] = mapped_column(Text)
    result_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    error_text: Mapped[Optional[str]] = mapped_column(Text)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    duration_ms: Mapped[Optional[float]] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class WorkspaceAction(Base):
    __tablename__ = "workspace_actions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    project_workspace_id: Mapped[Optional[str]] = mapped_column(ForeignKey("project_workspaces.id"), index=True)
    agent_run_id: Mapped[Optional[str]] = mapped_column(ForeignKey("agent_runs.id"), index=True)
    tool_execution_id: Mapped[Optional[str]] = mapped_column(ForeignKey("tool_executions.id"), index=True)
    task_id: Mapped[Optional[str]] = mapped_column(ForeignKey("tasks.id"), index=True)
    workspace_scope: Mapped[str] = mapped_column(String(32), default="managed_task", nullable=False)
    action_type: Mapped[str] = mapped_column(String(64), nullable=False)
    target_path: Mapped[Optional[str]] = mapped_column(Text)
    command_text: Mapped[Optional[str]] = mapped_column(Text)
    arguments_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    stdout_text: Mapped[Optional[str]] = mapped_column(Text)
    stderr_text: Mapped[Optional[str]] = mapped_column(Text)
    exit_code: Mapped[Optional[int]] = mapped_column(Integer)
    success: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class TaskApproval(Base):
    __tablename__ = "task_approvals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True, nullable=False)
    agent_run_id: Mapped[Optional[str]] = mapped_column(ForeignKey("agent_runs.id"), index=True)
    tool_execution_id: Mapped[Optional[str]] = mapped_column(ForeignKey("tool_executions.id"), index=True)
    approval_type: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False, index=True)
    request_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    decision_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    requested_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    task: Mapped["Task"] = relationship(back_populates="approvals")


class TaskArtifact(Base):
    __tablename__ = "task_artifacts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uuid_str)
    task_id: Mapped[str] = mapped_column(ForeignKey("tasks.id"), index=True, nullable=False)
    asset_id: Mapped[Optional[str]] = mapped_column(ForeignKey("assets.id"), index=True)
    relative_path: Mapped[str] = mapped_column(Text, nullable=False)
    artifact_role: Mapped[str] = mapped_column(String(64), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    mime_type: Mapped[Optional[str]] = mapped_column(String(255))
    size_bytes: Mapped[Optional[int]] = mapped_column(Integer)
    sha256: Mapped[Optional[str]] = mapped_column(String(64))
    promoted_to_asset: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

    task: Mapped["Task"] = relationship(back_populates="artifacts")
