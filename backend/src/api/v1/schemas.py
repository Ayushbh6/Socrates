from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import AliasChoices, BaseModel, Field

from ...core.schema import InputMode, ThinkingLevel


class HealthResponse(BaseModel):
    status: str
    database: str


class BootstrapStatusResponse(BaseModel):
    has_user: bool
    onboarding_completed: bool


class BootstrapCreateRequest(BaseModel):
    display_name: str = Field(min_length=1, max_length=255)
    preferences: dict[str, Any] = Field(default_factory=dict)


class UserResponse(BaseModel):
    id: str
    display_name: str
    preferences: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    onboarding_completed_at: datetime | None


class UpdateUserRequest(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=255)
    preferences: dict[str, Any] | None = None


class ProjectCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    default_system_prompt: str | None = None
    status: str = "active"


class ProjectUpdateRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    default_system_prompt: str | None = None
    status: str | None = None


class ProjectResponse(BaseModel):
    id: str
    user_id: str
    name: str
    description: str | None
    status: str
    default_system_prompt: str | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None


class ConversationCreateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    summary: str | None = None
    model: str | None = None
    thinking_level: ThinkingLevel | None = None


class ConversationUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    summary: str | None = None
    model: str | None = None
    thinking_level: ThinkingLevel | None = None


class ConversationResponse(BaseModel):
    id: str
    project_id: str
    title: str
    summary: str | None
    model: str
    thinking_level: ThinkingLevel
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None


class AssetResponse(BaseModel):
    id: str
    project_id: str
    created_by_task_id: str | None = None
    kind: str
    source_type: str
    original_name: str
    mime_type: str
    storage_path: str
    size_bytes: int
    sha256: str
    created_at: datetime
    deleted_at: datetime | None
    metadata: dict[str, Any]


class MessageResponse(BaseModel):
    id: str
    project_id: str
    conversation_id: str
    agent_run_id: str | None
    task_id: str | None = None
    execution_mode: str
    role: str
    input_mode: str
    content_text: str | None
    thinking_text: str | None
    status: str
    sequence_no: int
    provider: str | None
    model: str | None
    created_at: datetime
    updated_at: datetime
    failed_at: datetime | None
    metadata: dict[str, Any]
    assets: list[AssetResponse]


class CreateMessageRequest(BaseModel):
    model: str | None = None
    thinking_level: ThinkingLevel | None = None
    input_mode: InputMode = InputMode.TEXT
    content_text: str = Field(min_length=1)
    asset_ids: list[str] = Field(default_factory=list)


class CreateMessageResponse(BaseModel):
    message_id: str
    agent_run_id: str
    status: str


class AgentRunResponse(BaseModel):
    id: str
    project_id: str
    conversation_id: str
    task_id: str | None
    trigger_message_id: str | None
    response_message_id: str | None
    status: str
    execution_mode: str
    provider: str | None
    model: str
    input_mode: str
    system_prompt_text: str
    query_text: str
    request_json: dict[str, Any]
    final_response_json: dict[str, Any]
    final_parsed_json: dict[str, Any]
    aggregated_metadata_json: dict[str, Any]
    usage_input_tokens: int
    usage_output_tokens: int
    usage_completion_tokens: int
    usage_total_tokens: int
    elapsed_ms: float
    started_at: datetime | None
    completed_at: datetime | None
    error_message: str | None
    created_at: datetime
    event_count: int
    turn_count: int


class AgentRunTurnResponse(BaseModel):
    id: str
    agent_run_id: str
    round_index: int
    phase: str
    provider: str | None
    model: str | None
    request_json: dict[str, Any]
    response_json: dict[str, Any]
    raw_dump_json: dict[str, Any]
    parsed_output_json: dict[str, Any]
    metadata_json: dict[str, Any]
    had_thinking: bool
    tool_call_count: int
    parsed_output_present: bool
    usage_input_tokens: int
    usage_output_tokens: int
    usage_completion_tokens: int
    usage_total_tokens: int
    elapsed_ms: float
    created_at: datetime


class AgentRunEventResponse(BaseModel):
    id: str
    agent_run_id: str
    agent_run_turn_id: str | None
    sequence_no: int
    event_type: str
    status: str
    content_text: str | None
    thinking_text: str | None
    tool_call_ref: str | None
    payload: dict[str, Any]
    created_at: datetime


class ProjectWorkspaceResponse(BaseModel):
    id: str
    project_id: str
    label: str
    root_path: str
    editor_type: str
    is_primary: bool
    access_granted: bool
    access_granted_at: datetime | None
    access_revoked_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ProjectWorkspaceCreateRequest(BaseModel):
    label: str = Field(min_length=1, max_length=255)
    relative_path: str | None = Field(
        default=None,
        min_length=1,
        max_length=2048,
        validation_alias=AliasChoices("relative_path", "root_path"),
    )
    editor_type: str = Field(default="vscode", min_length=1, max_length=64)
    is_primary: bool = False
    access_granted: bool = True


class ProjectWorkspaceUpdateRequest(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=255)
    editor_type: str | None = Field(default=None, min_length=1, max_length=64)
    is_primary: bool | None = None
    access_granted: bool | None = None


class TaskResponse(BaseModel):
    id: str
    project_id: str
    conversation_id: str
    project_workspace_id: str | None
    created_from_agent_run_id: str | None
    last_agent_run_id: str | None
    status: str
    title: str
    goal_text: str
    success_criteria_text: str | None
    brief_markdown: str
    workspace_root: str
    workspace_host_root: str | None = None
    venv_path: str
    result_summary: str | None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None
    failed_at: datetime | None


class TaskArtifactResponse(BaseModel):
    id: str
    task_id: str
    asset_id: str | None
    relative_path: str
    artifact_role: str
    display_name: str
    mime_type: str | None
    size_bytes: int | None
    sha256: str | None
    promoted_to_asset: bool
    metadata: dict[str, Any]
    created_at: datetime


class TaskWorkspaceEntryResponse(BaseModel):
    path: str
    name: str
    parent_path: str | None
    is_dir: bool
    size_bytes: int | None
    mime_type: str | None
    updated_at: datetime


class TaskWorkspaceRootResponse(BaseModel):
    path: str
    name: str
    entries: list[TaskWorkspaceEntryResponse]


class TaskWorkspaceTreeResponse(BaseModel):
    task_id: str
    roots: list[TaskWorkspaceRootResponse]


class TaskWorkspaceFilePreviewResponse(BaseModel):
    task_id: str
    path: str
    name: str
    mime_type: str
    size_bytes: int
    sha256: str
    preview_type: str
    content_text: str | None = None
    data_url: str | None = None
    encoding: str | None = None
    truncated: bool = False


class TaskApprovalResponse(BaseModel):
    id: str
    task_id: str
    agent_run_id: str | None
    tool_execution_id: str | None
    approval_type: str
    status: str
    request_json: dict[str, Any]
    decision_json: dict[str, Any]
    requested_at: datetime | None
    resolved_at: datetime | None
    created_at: datetime
    resume_agent_run_id: str | None = None
    resume_status: str | None = None
    resume_error: str | None = None


class ResolveTaskApprovalRequest(BaseModel):
    approved: bool
    note: str | None = None
    auto_resume: bool = False
