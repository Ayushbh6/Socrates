from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from ..agent import AgentRequest, AgentRunner
from ..agent.events import AgentEvent, AgentEventType
from ..agents import build_socrates_system_prompt
from ..core.settings import get_settings
from ..core.model_catalog import DEFAULT_MODEL, DEFAULT_THINKING_LEVEL, normalize_thinking_level, provider_for_model, require_supported_model
from ..core.schema import Attachment, GenConfig, InputMode, Message, MessageRole, ThinkingLevel
from ..db.models import AgentEventRecord, AgentRun, AgentRunTurn, Asset, Conversation, MessageAsset, MessageRecord, Project, Task, TaskApproval, ToolExecution
from ..db.session import get_session_factory
from ..tools.executor import ProjectToolBatchExecutor
from ..tools.registry import get_tools_registry
from .assets import get_project_assets_by_ids, resolve_asset_bytes
from .bootstrap import get_current_user
from .projects import (
    NEW_CONVERSATION_PLACEHOLDER_TITLE,
    derive_initial_conversation_title,
    get_conversation,
    get_project,
    next_message_sequence,
)
from .tasks import (
    ensure_task_input_assets,
    find_matching_approval,
    get_active_task_for_conversation,
    get_task,
    list_task_artifacts,
    serialize_task,
    serialize_task_approval,
    serialize_task_artifact,
    sync_task_output_artifacts,
)
from .utils import to_json_compatible


class ConversationRunInProgressError(ValueError):
    def __init__(self, run_id: str):
        super().__init__("Conversation already has an active run.")
        self.run_id = run_id


ACTIVE_RUN_STATUSES = {"queued", "running"}
TERMINAL_RUN_STATUSES = {"completed", "failed", "blocked", "cancelled", "stalled"}
TERMINAL_RUN_EVENT_TYPES = {
    "run.completed",
    "run.failed",
    "run.blocked",
    "run.cancelled",
    "run.stalled",
}
TERMINAL_RUN_APPEND_EVENT_TYPES = {
    "run.message.completed",
    "task.approval.resolved",
    "task.status.updated",
}


class RunStalledError(RuntimeError):
    def __init__(self, timeout_seconds: int):
        super().__init__(f"Run stalled with no progress for {timeout_seconds} seconds.")
        self.timeout_seconds = timeout_seconds


def is_active_run_status(status: str | None) -> bool:
    return status in ACTIVE_RUN_STATUSES


def is_terminal_run_status(status: str | None) -> bool:
    return status in TERMINAL_RUN_STATUSES


def terminal_run_event_type(status: str) -> str:
    if status not in TERMINAL_RUN_STATUSES:
        raise ValueError(f"Unsupported terminal run status: {status}")
    return f"run.{status}"


def serialize_asset(asset: Asset) -> dict[str, Any]:
    return {
        "id": asset.id,
        "project_id": asset.project_id,
        "created_by_task_id": asset.created_by_task_id,
        "kind": asset.kind,
        "source_type": asset.source_type,
        "original_name": asset.original_name,
        "mime_type": asset.mime_type,
        "storage_path": asset.storage_path,
        "size_bytes": asset.size_bytes,
        "sha256": asset.sha256,
        "created_at": asset.created_at.isoformat(),
        "deleted_at": asset.deleted_at.isoformat() if asset.deleted_at else None,
        "metadata": asset.metadata_json,
    }


def serialize_message(message: MessageRecord) -> dict[str, Any]:
    assets = [serialize_asset(link.asset) for link in message.asset_links]
    return {
        "id": message.id,
        "project_id": message.project_id,
        "conversation_id": message.conversation_id,
        "agent_run_id": message.agent_run_id,
        "task_id": message.task_id,
        "execution_mode": message.execution_mode,
        "role": message.role,
        "input_mode": message.input_mode,
        "content_text": message.content_text,
        "thinking_text": message.thinking_text,
        "status": message.status,
        "sequence_no": message.sequence_no,
        "provider": message.provider,
        "model": message.model,
        "created_at": message.created_at.isoformat(),
        "updated_at": message.updated_at.isoformat(),
        "failed_at": message.failed_at.isoformat() if message.failed_at else None,
        "metadata": message.metadata_json,
        "assets": assets,
    }


def serialize_agent_event(record: AgentEventRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "agent_run_id": record.agent_run_id,
        "agent_run_turn_id": record.agent_run_turn_id,
        "sequence_no": record.sequence_no,
        "event_type": record.event_type,
        "status": record.status,
        "content_text": record.content_text,
        "thinking_text": record.thinking_text,
        "tool_call_ref": record.tool_call_ref,
        "payload": record.payload_json,
        "created_at": record.created_at.isoformat(),
    }


def serialize_agent_run_turn(turn: AgentRunTurn) -> dict[str, Any]:
    return {
        "id": turn.id,
        "agent_run_id": turn.agent_run_id,
        "round_index": turn.round_index,
        "phase": turn.phase,
        "provider": turn.provider,
        "model": turn.model,
        "request_json": turn.request_json,
        "response_json": turn.response_json,
        "raw_dump_json": turn.raw_dump_json,
        "parsed_output_json": turn.parsed_output_json,
        "metadata_json": turn.metadata_json,
        "had_thinking": turn.had_thinking,
        "tool_call_count": turn.tool_call_count,
        "parsed_output_present": turn.parsed_output_present,
        "usage_input_tokens": turn.usage_input_tokens,
        "usage_output_tokens": turn.usage_output_tokens,
        "usage_completion_tokens": turn.usage_completion_tokens,
        "usage_total_tokens": turn.usage_total_tokens,
        "elapsed_ms": turn.elapsed_ms,
        "created_at": turn.created_at.isoformat(),
    }


def serialize_agent_run(run: AgentRun, *, event_count: int, turn_count: int) -> dict[str, Any]:
    return {
        "id": run.id,
        "project_id": run.project_id,
        "conversation_id": run.conversation_id,
        "task_id": run.task_id,
        "trigger_message_id": run.trigger_message_id,
        "response_message_id": run.response_message_id,
        "status": run.status,
        "execution_mode": run.execution_mode,
        "provider": run.provider,
        "model": run.model,
        "input_mode": run.input_mode,
        "system_prompt_text": run.system_prompt_text,
        "query_text": run.query_text,
        "request_json": run.request_json,
        "final_response_json": run.final_response_json,
        "final_parsed_json": run.final_parsed_json,
        "aggregated_metadata_json": run.aggregated_metadata_json,
        "usage_input_tokens": run.usage_input_tokens,
        "usage_output_tokens": run.usage_output_tokens,
        "usage_completion_tokens": run.usage_completion_tokens,
        "usage_total_tokens": run.usage_total_tokens,
        "elapsed_ms": run.elapsed_ms,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "error_message": run.error_message,
        "created_at": run.created_at.isoformat(),
        "event_count": event_count,
        "turn_count": turn_count,
    }


def _registered_output_paths_from_execution(execution: ToolExecution | None) -> set[str]:
    if execution is None:
        return set()
    paths = execution.result_json.get("registered_outputs")
    if not isinstance(paths, list):
        return set()
    return {
        path
        for path in paths
        if isinstance(path, str)
        and (path == "outputs" or path.startswith("outputs/"))
    }


def get_agent_run(session: Session, run_id: str) -> AgentRun:
    run = session.get(AgentRun, run_id)
    if run is None:
        raise LookupError("Agent run not found.")
    return run


def list_agent_run_events(session: Session, run_id: str) -> list[AgentEventRecord]:
    get_agent_run(session, run_id)
    return list(
        session.execute(
            select(AgentEventRecord)
            .where(AgentEventRecord.agent_run_id == run_id)
            .order_by(AgentEventRecord.sequence_no.asc())
        ).scalars()
    )


def list_agent_run_turns(session: Session, run_id: str) -> list[AgentRunTurn]:
    get_agent_run(session, run_id)
    return list(
        session.execute(
            select(AgentRunTurn)
            .where(AgentRunTurn.agent_run_id == run_id)
            .order_by(AgentRunTurn.round_index.asc())
        ).scalars()
    )


def get_active_run_for_conversation(session: Session, conversation_id: str) -> AgentRun | None:
    get_conversation(session, conversation_id)
    runs = list(
        session.execute(
            select(AgentRun)
            .where(
                AgentRun.conversation_id == conversation_id,
                AgentRun.status.in_(tuple(ACTIVE_RUN_STATUSES)),
            )
            .order_by(AgentRun.created_at.desc())
        )
        .scalars()
    )
    for run in runs:
        if run.execution_mode != "worker":
            return run
    return runs[0] if runs else None


def _message_to_runtime(message: MessageRecord) -> Message | None:
    attachments = []
    for link in message.asset_links:
        asset = link.asset
        if asset.deleted_at is not None or not asset.mime_type.startswith("image/"):
            continue
        attachments.append(
            Attachment(
                mime_type=asset.mime_type,
                content=resolve_asset_bytes(asset),
                name=asset.original_name,
            )
        )

    runtime_message = Message(
        role=MessageRole(message.role),
        content=message.content_text or None,
        thinking=message.thinking_text or None,
        attachments=attachments or None,
    )
    if (
        runtime_message.role == MessageRole.ASSISTANT
        and runtime_message.content is None
        and runtime_message.thinking is None
        and not runtime_message.attachments
    ):
        return None
    return runtime_message


def create_message_and_run(
    session: Session,
    *,
    conversation_id: str,
    model: str | None,
    thinking_level: ThinkingLevel | None,
    input_mode: InputMode,
    content_text: str,
    asset_ids: list[str],
) -> tuple[MessageRecord, AgentRun]:
    if input_mode != InputMode.TEXT:
        raise ValueError("Only text input mode is supported in this slice.")

    conversation = get_conversation(session, conversation_id)
    active_run = get_active_run_for_conversation(session, conversation.id)
    if active_run is not None:
        raise ConversationRunInProgressError(active_run.id)
    project = get_project(session, conversation.project_id)

    if conversation.title == NEW_CONVERSATION_PLACEHOLDER_TITLE:
        conversation.title = derive_initial_conversation_title(content_text)

    resolved_model = model or conversation.model or DEFAULT_MODEL
    require_supported_model(resolved_model)
    resolved_thinking = normalize_thinking_level(
        resolved_model,
        thinking_level or ThinkingLevel(conversation.thinking_level or DEFAULT_THINKING_LEVEL.value),
    )
    resolved_provider = provider_for_model(resolved_model)

    current_user = get_current_user(session)
    active_task = get_active_task_for_conversation(session, conversation.id)

    assets = get_project_assets_by_ids(session, conversation.project_id, asset_ids)
    sequence_no = next_message_sequence(session, conversation_id)
    user_message = MessageRecord(
        project_id=conversation.project_id,
        conversation_id=conversation.id,
        role=MessageRole.USER.value,
        task_id=active_task.id if active_task else None,
        execution_mode="task" if active_task else "chat",
        input_mode=input_mode.value,
        content_text=content_text,
        status="queued",
        sequence_no=sequence_no,
        provider=resolved_provider,
        model=resolved_model,
        metadata_json={"thinking_level": resolved_thinking.value},
    )
    session.add(user_message)
    session.flush()

    for asset in assets:
        session.add(MessageAsset(message_id=user_message.id, asset_id=asset.id, relation_type="attachment"))

    run = AgentRun(
        project_id=conversation.project_id,
        conversation_id=conversation.id,
        task_id=active_task.id if active_task else None,
        trigger_message_id=user_message.id,
        status="queued",
        execution_mode="task" if active_task else "chat",
        provider=resolved_provider,
        model=resolved_model,
        input_mode=input_mode.value,
        system_prompt_text=build_socrates_system_prompt(
            project.default_system_prompt,
            user_name=current_user.display_name if current_user else None,
            project_name=project.name,
            project_description=project.description,
        ),
        query_text=content_text,
        request_json={
            "model": resolved_model,
            "thinking_level": resolved_thinking.value,
            "input_mode": input_mode.value,
            "asset_ids": asset_ids,
            "active_task_id": active_task.id if active_task else None,
        },
    )
    session.add(run)
    session.flush()
    user_message.agent_run_id = run.id
    if active_task is not None:
        active_task.last_agent_run_id = run.id
        active_task.updated_at = datetime.now(timezone.utc)
        if assets:
            ensure_task_input_assets(session, task=active_task, assets=assets)
    conversation.model = resolved_model
    conversation.thinking_level = resolved_thinking.value
    conversation.updated_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(user_message)
    session.refresh(run)
    return user_message, run


def create_plan_approval_resume_run(
    session: Session,
    *,
    approval: TaskApproval,
) -> tuple[MessageRecord, AgentRun]:
    if approval.status != "approved" or approval.approval_type != "plan_approval":
        raise ValueError("Only approved plan approvals can resume Socrates automatically.")

    task = get_task(session, approval.task_id)
    conversation = get_conversation(session, task.conversation_id)
    active_run = get_active_run_for_conversation(session, conversation.id)
    if active_run is not None:
        raise ConversationRunInProgressError(active_run.id)
    project = get_project(session, conversation.project_id)

    current_user = get_current_user(session)
    resolved_model = conversation.model or DEFAULT_MODEL
    require_supported_model(resolved_model)
    resolved_thinking = normalize_thinking_level(
        resolved_model,
        ThinkingLevel(conversation.thinking_level or DEFAULT_THINKING_LEVEL.value),
    )
    resolved_provider = provider_for_model(resolved_model)
    content_text = (
        "The user approved the current plan through the plan approval controls. "
        "Continue the approved task workflow: create todo.md if needed, start the worker when ready, "
        "review the worker result, and answer the user."
    )

    message = MessageRecord(
        project_id=conversation.project_id,
        conversation_id=conversation.id,
        role=MessageRole.USER.value,
        task_id=task.id,
        execution_mode="task",
        input_mode=InputMode.TEXT.value,
        content_text=content_text,
        status="queued",
        sequence_no=next_message_sequence(session, conversation.id),
        provider=resolved_provider,
        model=resolved_model,
        metadata_json={
            "thinking_level": resolved_thinking.value,
            "system_generated": True,
            "kind": "plan_approval_resume",
            "approval_id": approval.id,
        },
    )
    session.add(message)
    session.flush()

    run = AgentRun(
        project_id=conversation.project_id,
        conversation_id=conversation.id,
        task_id=task.id,
        trigger_message_id=message.id,
        status="queued",
        execution_mode="task",
        provider=resolved_provider,
        model=resolved_model,
        input_mode=InputMode.TEXT.value,
        system_prompt_text=build_socrates_system_prompt(
            project.default_system_prompt,
            user_name=current_user.display_name if current_user else None,
            project_name=project.name,
            project_description=project.description,
        ),
        query_text=content_text,
        request_json={
            "model": resolved_model,
            "thinking_level": resolved_thinking.value,
            "input_mode": InputMode.TEXT.value,
            "asset_ids": [],
            "active_task_id": task.id,
            "auto_resume_after_approval_id": approval.id,
        },
    )
    session.add(run)
    session.flush()

    message.agent_run_id = run.id
    task.last_agent_run_id = run.id
    task.updated_at = datetime.now(timezone.utc)
    conversation.updated_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(message)
    session.refresh(run)
    return message, run


def create_task_completion_denial_resume_run(
    session: Session,
    *,
    approval: TaskApproval,
) -> tuple[MessageRecord, AgentRun]:
    if approval.status != "denied" or approval.approval_type != "task_completion":
        raise ValueError("Only denied task completion approvals can resume Socrates automatically.")

    task = get_task(session, approval.task_id)
    conversation = get_conversation(session, task.conversation_id)
    active_run = get_active_run_for_conversation(session, conversation.id)
    if active_run is not None:
        raise ConversationRunInProgressError(active_run.id)
    project = get_project(session, conversation.project_id)
    current_user = get_current_user(session)
    resolved_model = conversation.model or DEFAULT_MODEL
    require_supported_model(resolved_model)
    resolved_thinking = normalize_thinking_level(
        resolved_model,
        ThinkingLevel(conversation.thinking_level or DEFAULT_THINKING_LEVEL.value),
    )
    resolved_provider = provider_for_model(resolved_model)
    content_text = (
        "The user rejected Socrates' request to mark the current task completed. "
        "Ask the user what is still left to do, then revise the todo or continue the task as needed."
    )

    message = MessageRecord(
        project_id=conversation.project_id,
        conversation_id=conversation.id,
        role=MessageRole.USER.value,
        task_id=task.id,
        execution_mode="task",
        input_mode=InputMode.TEXT.value,
        content_text=content_text,
        status="queued",
        sequence_no=next_message_sequence(session, conversation.id),
        provider=resolved_provider,
        model=resolved_model,
        metadata_json={
            "thinking_level": resolved_thinking.value,
            "system_generated": True,
            "kind": "task_completion_denied_resume",
            "approval_id": approval.id,
        },
    )
    session.add(message)
    session.flush()

    run = AgentRun(
        project_id=conversation.project_id,
        conversation_id=conversation.id,
        task_id=task.id,
        trigger_message_id=message.id,
        status="queued",
        execution_mode="task",
        provider=resolved_provider,
        model=resolved_model,
        input_mode=InputMode.TEXT.value,
        system_prompt_text=build_socrates_system_prompt(
            project.default_system_prompt,
            user_name=current_user.display_name if current_user else None,
            project_name=project.name,
            project_description=project.description,
        ),
        query_text=content_text,
        request_json={
            "model": resolved_model,
            "thinking_level": resolved_thinking.value,
            "input_mode": InputMode.TEXT.value,
            "asset_ids": [],
            "active_task_id": task.id,
            "auto_resume_after_approval_id": approval.id,
        },
    )
    session.add(run)
    session.flush()
    message.agent_run_id = run.id
    task.last_agent_run_id = run.id
    conversation.updated_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(message)
    session.refresh(run)
    return message, run


RECOVERY_ACTION_RUN_INTENTS = {
    "retry_remaining_work": "The user chose to retry the remaining work for this recoverable task.",
    "revise_plan": "The user chose to revise the plan before continuing this recoverable task.",
    "accept_partial_output": (
        "The user chose to consider the current partial output. Inspect the available outputs, "
        "verify whether they satisfy the task, and request normal task completion approval only if appropriate."
    ),
}


def create_task_recovery_run(
    session: Session,
    *,
    task: Task,
    action_id: str,
    recovery_state: dict[str, Any],
    note: str | None = None,
) -> tuple[MessageRecord, AgentRun]:
    if action_id not in RECOVERY_ACTION_RUN_INTENTS:
        raise ValueError(f"Recovery action '{action_id}' cannot create a Socrates run.")

    conversation = get_conversation(session, task.conversation_id)
    active_run = get_active_run_for_conversation(session, conversation.id)
    if active_run is not None:
        raise ConversationRunInProgressError(active_run.id)
    project = get_project(session, conversation.project_id)
    current_user = get_current_user(session)
    resolved_model = conversation.model or DEFAULT_MODEL
    require_supported_model(resolved_model)
    resolved_thinking = normalize_thinking_level(
        resolved_model,
        ThinkingLevel(conversation.thinking_level or DEFAULT_THINKING_LEVEL.value),
    )
    resolved_provider = provider_for_model(resolved_model)
    cleaned_note = note.strip() if note and note.strip() else None
    recovery_kind = str(recovery_state.get("kind") or "unknown")
    content_lines = [
        RECOVERY_ACTION_RUN_INTENTS[action_id],
        "",
        f"Task id: {task.id}",
        f"Recovery kind: {recovery_kind}",
        f"Recovery summary: {recovery_state.get('summary') or ''}",
        f"Requested action: {action_id}",
    ]
    if cleaned_note:
        content_lines.extend(["", f"User note: {cleaned_note}"])
    content_lines.extend(
        [
            "",
            "Use the existing task package, todo.md, artifacts, and recovery_state. "
            "Do not bypass planning, approval, worker, or completion rules.",
        ]
    )
    content_text = "\n".join(content_lines)
    recovery_context = to_json_compatible(recovery_state)

    message = MessageRecord(
        project_id=conversation.project_id,
        conversation_id=conversation.id,
        role=MessageRole.USER.value,
        task_id=task.id,
        execution_mode="task",
        input_mode=InputMode.TEXT.value,
        content_text=content_text,
        status="queued",
        sequence_no=next_message_sequence(session, conversation.id),
        provider=resolved_provider,
        model=resolved_model,
        metadata_json={
            "thinking_level": resolved_thinking.value,
            "system_generated": True,
            "kind": "task_recovery_action",
            "action_id": action_id,
            "recovery_kind": recovery_kind,
        },
    )
    session.add(message)
    session.flush()

    run = AgentRun(
        project_id=conversation.project_id,
        conversation_id=conversation.id,
        task_id=task.id,
        trigger_message_id=message.id,
        status="queued",
        execution_mode="task",
        provider=resolved_provider,
        model=resolved_model,
        input_mode=InputMode.TEXT.value,
        system_prompt_text=build_socrates_system_prompt(
            project.default_system_prompt,
            user_name=current_user.display_name if current_user else None,
            project_name=project.name,
            project_description=project.description,
        ),
        query_text=content_text,
        request_json={
            "model": resolved_model,
            "thinking_level": resolved_thinking.value,
            "input_mode": InputMode.TEXT.value,
            "asset_ids": [],
            "active_task_id": task.id,
            "recovery_action_id": action_id,
            "recovery_kind": recovery_kind,
            "recovery_state": recovery_context,
            "note": cleaned_note,
        },
    )
    session.add(run)
    session.flush()
    message.agent_run_id = run.id
    task.last_agent_run_id = run.id
    task.updated_at = datetime.now(timezone.utc)
    conversation.updated_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(message)
    session.refresh(run)
    return message, run


_DELTA_KIND_CONTENT = "content"
_DELTA_KIND_THINKING = "thinking"


class _DeltaCoalescer:
    """Batches consecutive `run.content.delta` and `run.thinking.delta` events so
    the runtime issues at most one DB commit + publish per flush window.

    Each flushed event goes through the normal `_record_event` path, which
    preserves the invariant that every event observed by a subscriber has already
    been persisted. The wire contract is unchanged -- each flushed event is still
    a valid delta with the same schema, just carrying a larger `delta` string.

    Flush triggers:
      * accumulated text length reaches `flush_chars`
      * time since first append reaches `flush_ms`
      * a different `round_index` or delta kind arrives (forced flush of prior)
      * caller explicitly flushes (before any non-delta event or at run end)
    """

    def __init__(
        self,
        *,
        record_event: Callable[..., Awaitable[None]],
        flush_ms: int,
        flush_chars: int,
    ) -> None:
        self._record_event = record_event
        self._flush_ms = max(int(flush_ms), 0)
        self._flush_chars = max(int(flush_chars), 1)
        self._kind: str | None = None
        self._round_index: int | None = None
        self._turn: AgentRunTurn | None = None
        self._text: str = ""
        self._first_append_monotonic: float | None = None

    async def feed(
        self,
        session: Session,
        run: AgentRun,
        *,
        kind: str,
        round_index: int,
        turn: AgentRunTurn,
        delta: str,
    ) -> None:
        if not delta:
            return
        if self._kind != kind or self._round_index != round_index:
            await self.flush(session, run)
            self._kind = kind
            self._round_index = round_index
            self._turn = turn
            self._text = ""
            self._first_append_monotonic = None
        if self._first_append_monotonic is None:
            self._first_append_monotonic = asyncio.get_running_loop().time()
        self._turn = turn
        self._text += delta
        elapsed_ms = (asyncio.get_running_loop().time() - self._first_append_monotonic) * 1000.0
        if len(self._text) >= self._flush_chars or elapsed_ms >= self._flush_ms:
            await self.flush(session, run)

    async def flush(self, session: Session, run: AgentRun) -> None:
        if not self._text or self._kind is None or self._round_index is None:
            self._reset()
            return
        kind = self._kind
        round_index = self._round_index
        turn = self._turn
        delta_text = self._text
        self._reset()
        if kind == _DELTA_KIND_CONTENT:
            await self._record_event(
                session,
                run,
                event_type="run.content.delta",
                payload={
                    "type": "run.content.delta",
                    "run_id": run.id,
                    "round_index": round_index,
                    "delta": delta_text,
                },
                turn=turn,
                content_text=delta_text,
            )
        else:
            await self._record_event(
                session,
                run,
                event_type="run.thinking.delta",
                payload={
                    "type": "run.thinking.delta",
                    "run_id": run.id,
                    "round_index": round_index,
                    "delta": delta_text,
                },
                turn=turn,
                thinking_text=delta_text,
            )

    def _reset(self) -> None:
        self._kind = None
        self._round_index = None
        self._turn = None
        self._text = ""
        self._first_append_monotonic = None


class RunManager:
    def __init__(self):
        self._session_factory = get_session_factory()
        self._runner_factory = AgentRunner
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
        self._lock = asyncio.Lock()

    async def start_run(self, run_id: str) -> None:
        async with self._lock:
            task = self._tasks.get(run_id)
            if task and not task.done():
                return
            self._cancel_events[run_id] = asyncio.Event()
            task = asyncio.create_task(self._execute_run(run_id))
            task.add_done_callback(lambda _: self._forget_run_task(run_id))
            self._tasks[run_id] = task

    def _forget_run_task(self, run_id: str) -> None:
        self._tasks.pop(run_id, None)
        self._cancel_events.pop(run_id, None)

    async def live_run_ids(self) -> set[str]:
        async with self._lock:
            return {run_id for run_id, task in self._tasks.items() if not task.done()}

    async def cancel_run(self, run_id: str) -> AgentRun:
        async with self._lock:
            cancel_event = self._cancel_events.get(run_id)
            task = self._tasks.get(run_id)
            if cancel_event is not None:
                cancel_event.set()

        session = self._session_factory()
        try:
            run = session.get(AgentRun, run_id)
            if run is None:
                raise LookupError("Agent run not found.")
            await self._mark_run_terminal(
                session,
                run,
                status="cancelled",
                message="Stopped by user.",
                terminal_event_payload={
                    "type": "run.cancelled",
                    "run_id": run.id,
                    "reason": "user_cancelled",
                },
            )
            if task and not task.done():
                task.cancel()
            session.refresh(run)
            return run
        finally:
            session.close()

    async def reconcile_stale_active_runs(self, *, conversation_id: str | None = None) -> None:
        live_ids = await self.live_run_ids()
        session = self._session_factory()
        try:
            query = select(AgentRun).where(AgentRun.status.in_(tuple(ACTIVE_RUN_STATUSES)))
            if conversation_id is not None:
                query = query.where(AgentRun.conversation_id == conversation_id)
            runs = list(session.execute(query.order_by(AgentRun.created_at.asc())).scalars())
            for run in runs:
                parent_run_id = run.request_json.get("parent_run_id")
                if run.id in live_ids or parent_run_id in live_ids:
                    continue
                await self._mark_run_terminal(
                    session,
                    run,
                    status="stalled",
                    message="Run stalled after backend restart or lost live task.",
                    terminal_event_payload={
                        "type": "run.stalled",
                        "run_id": run.id,
                        "reason": "stale_running_run",
                    },
                )
        finally:
            session.close()

    async def subscribe(self, run_id: str) -> asyncio.Queue[dict[str, Any]]:
        async with self._lock:
            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
            self._subscribers.setdefault(run_id, set()).add(queue)
            return queue

    async def unsubscribe(self, run_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        async with self._lock:
            subscribers = self._subscribers.get(run_id)
            if not subscribers:
                return
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(run_id, None)

    async def publish(self, run_id: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            queues = list(self._subscribers.get(run_id, set()))
        for queue in queues:
            await queue.put(payload)

    def replay_events(self, run_id: str, *, after_seq: int = 0) -> list[dict[str, Any]]:
        session = self._session_factory()
        try:
            records = list(
                session.execute(
                    select(AgentEventRecord)
                    .where(AgentEventRecord.agent_run_id == run_id)
                    .where(AgentEventRecord.sequence_no > after_seq)
                    .order_by(AgentEventRecord.sequence_no.asc())
                ).scalars()
            )
            payloads: list[dict[str, Any]] = []
            for record in records:
                payload = dict(record.payload_json)
                payload["seq"] = record.sequence_no
                payloads.append(payload)
            return payloads
        finally:
            session.close()

    def get_run_status(self, run_id: str) -> str | None:
        session = self._session_factory()
        try:
            run = session.get(AgentRun, run_id)
            return run.status if run else None
        finally:
            session.close()

    def get_run_snapshot(self, run_id: str) -> dict[str, Any] | None:
        session = self._session_factory()
        try:
            run = session.get(AgentRun, run_id)
            if run is None:
                return None
            last_seq = session.execute(
                select(func.max(AgentEventRecord.sequence_no)).where(AgentEventRecord.agent_run_id == run_id)
            ).scalar_one()
            return {
                "type": "run.snapshot",
                "run_id": run.id,
                "conversation_id": run.conversation_id,
                "status": run.status,
                "last_seq": int(last_seq or 0),
                "response_message_id": run.response_message_id,
                "error": run.error_message,
            }
        finally:
            session.close()

    async def record_external_event(
        self,
        run_id: str,
        *,
        event_type: str,
        payload: dict[str, Any],
        status: str = "ok",
    ) -> None:
        session = self._session_factory()
        try:
            run = session.get(AgentRun, run_id)
            if run is None:
                return
            if (
                is_terminal_run_status(run.status)
                and event_type != terminal_run_event_type(run.status)
                and event_type not in TERMINAL_RUN_APPEND_EVENT_TYPES
            ):
                return
            await self._record_event(
                session,
                run,
                event_type=event_type,
                payload=payload,
                status=status,
            )
        finally:
            session.close()

    async def _mark_run_terminal(
        self,
        session: Session,
        run: AgentRun,
        *,
        status: str,
        message: str,
        terminal_event_payload: dict[str, Any],
        event_status: str = "ok",
    ) -> None:
        if is_terminal_run_status(run.status):
            return

        await self._mark_related_worker_runs_terminal(
            session,
            parent_run=run,
            status=status,
            message=message,
        )

        run.status = status
        run.completed_at = datetime.now(timezone.utc)
        run.error_message = None if status == "cancelled" else message
        trigger_message = session.get(MessageRecord, run.trigger_message_id) if run.trigger_message_id else None
        if trigger_message is not None and trigger_message.status in {"queued", "failed"}:
            trigger_message.status = "completed"
            trigger_message.failed_at = None
        session.commit()
        await self._record_event(
            session,
            run,
            event_type=terminal_run_event_type(status),
            payload=terminal_event_payload,
            status=event_status,
        )

    async def _mark_related_worker_runs_terminal(
        self,
        session: Session,
        *,
        parent_run: AgentRun,
        status: str,
        message: str,
    ) -> None:
        if parent_run.execution_mode == "worker":
            return

        active_workers = list(
            session.execute(
                select(AgentRun)
                .where(
                    AgentRun.conversation_id == parent_run.conversation_id,
                    AgentRun.execution_mode == "worker",
                    AgentRun.status.in_(tuple(ACTIVE_RUN_STATUSES)),
                )
                .order_by(AgentRun.created_at.asc())
            ).scalars()
        )
        for worker_run in active_workers:
            if worker_run.request_json.get("parent_run_id") != parent_run.id:
                continue
            worker_run.status = status
            worker_run.completed_at = datetime.now(timezone.utc)
            worker_run.error_message = None if status == "cancelled" else message
            session.commit()
            await self._record_event(
                session,
                parent_run,
                event_type=f"task.worker.{status}",
                payload={
                    "type": f"task.worker.{status}",
                    "run_id": parent_run.id,
                    "task_id": worker_run.task_id,
                    "worker_run_id": worker_run.id,
                    "result": {
                        "status": status,
                        "summary": "Worker stopped by user." if status == "cancelled" else "Worker stalled with no progress.",
                        "blockers": [
                            {
                                "type": status,
                                "message": message,
                                "recommended_socrates_action": "Ask the user whether to retry, revise the plan, or abandon the task.",
                            }
                        ],
                    },
                },
            )

    def _next_event_sequence(self, session: Session, run_id: str) -> int:
        max_seq = session.execute(
            select(func.max(AgentEventRecord.sequence_no)).where(AgentEventRecord.agent_run_id == run_id)
        ).scalar_one()
        return int(max_seq or 0) + 1

    def _ensure_turn(
        self,
        session: Session,
        run: AgentRun,
        round_index: int,
        *,
        provider: str | None = None,
        model: str | None = None,
    ) -> AgentRunTurn:
        turn = session.execute(
            select(AgentRunTurn).where(AgentRunTurn.agent_run_id == run.id, AgentRunTurn.round_index == round_index)
        ).scalars().first()
        if turn is None:
            turn = AgentRunTurn(
                agent_run_id=run.id,
                round_index=round_index,
                provider=provider,
                model=model,
                request_json=run.request_json,
            )
            session.add(turn)
            session.flush()
        return turn

    async def _record_event(
        self,
        session: Session,
        run: AgentRun,
        *,
        event_type: str,
        payload: dict[str, Any],
        turn: AgentRunTurn | None = None,
        status: str = "ok",
        content_text: str | None = None,
        thinking_text: str | None = None,
        tool_call_ref: str | None = None,
    ) -> None:
        if (
            is_terminal_run_status(run.status)
            and event_type != terminal_run_event_type(run.status)
            and event_type not in TERMINAL_RUN_APPEND_EVENT_TYPES
        ):
            return
        safe_payload = to_json_compatible(payload)
        if not isinstance(safe_payload, dict):
            safe_payload = {"type": event_type, "run_id": run.id, "value": safe_payload}
        record = AgentEventRecord(
            agent_run_id=run.id,
            agent_run_turn_id=turn.id if turn else None,
            sequence_no=self._next_event_sequence(session, run.id),
            event_type=event_type,
            status=status,
            content_text=content_text,
            thinking_text=thinking_text,
            tool_call_ref=tool_call_ref,
            payload_json=safe_payload,
        )
        session.add(record)
        session.commit()
        outgoing = dict(safe_payload)
        outgoing["seq"] = record.sequence_no
        await self.publish(run.id, outgoing)

    async def _emit_turn_started(
        self,
        session: Session,
        run: AgentRun,
        turn: AgentRunTurn,
    ) -> None:
        payload = {
            "type": "run.turn.started",
            "run_id": run.id,
            "turn_id": turn.id,
            "round_index": turn.round_index,
        }
        await self._record_event(session, run, event_type="run.turn.started", payload=payload, turn=turn)

    async def _record_tool_side_effects(
        self, session: Session, run: AgentRun, tool_name: str, *, tool_call_id: str | None = None
    ) -> None:
        session.refresh(run)
        if tool_name == "create_task" and run.task_id:
            task = get_task(session, run.task_id)
            await self._record_event(
                session,
                run,
                event_type="task.created",
                payload={"type": "task.created", "run_id": run.id, "task": serialize_task(task, session=session)},
            )
        q = session.query(ToolExecution).filter(ToolExecution.agent_run_id == run.id)
        if tool_call_id:
            execution = (
                q.filter(ToolExecution.tool_call_id == tool_call_id)
                .order_by(ToolExecution.created_at.desc())
                .first()
            )
        else:
            execution = q.order_by(ToolExecution.created_at.desc()).first()
        task_id = run.task_id or (execution.task_id if execution is not None else None)
        if task_id:
            if (
                tool_name == "update_task_status"
                and execution is not None
                and execution.result_json.get("status") in {"completed", "failed"}
            ):
                task = get_task(session, task_id)
                session.refresh(task)
                await self._record_event(
                    session,
                    run,
                    event_type="task.status.updated",
                    payload={
                        "type": "task.status.updated",
                        "run_id": run.id,
                        "task_id": task.id,
                        "task": serialize_task(task, session=session),
                    },
                )
            approval_id = execution.result_json.get("approval_id") if execution is not None else None
            approval = session.get(TaskApproval, approval_id) if approval_id else None
            if approval is not None:
                await self._record_event(
                    session,
                    run,
                    event_type="task.approval.requested",
                    payload={
                        "type": "task.approval.requested",
                        "run_id": run.id,
                        "task_id": task_id,
                        "approval": serialize_task_approval(approval),
                    },
                )
            registered_output_paths = _registered_output_paths_from_execution(execution)
            if registered_output_paths:
                artifacts = [
                    artifact
                    for artifact in list_task_artifacts(session, task_id)
                    if artifact.relative_path in registered_output_paths
                ]
            elif tool_name == "start_worker":
                task = get_task(session, task_id)
                artifacts = sync_task_output_artifacts(session, task=task)
            else:
                artifacts = []
            for artifact in artifacts:
                await self._record_event(
                    session,
                    run,
                    event_type="task.artifact.registered",
                    payload={
                        "type": "task.artifact.registered",
                        "run_id": run.id,
                        "task_id": task_id,
                        "artifact": serialize_task_artifact(artifact),
                    },
                )

    async def _stream_with_watchdog(self, run_id: str, stream: Any, timeout_seconds: int):
        timeout = max(int(timeout_seconds), 1)
        iterator = stream.__aiter__()
        while True:
            try:
                event = await asyncio.wait_for(iterator.__anext__(), timeout=timeout)
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError as exc:
                raise RunStalledError(timeout) from exc
            yield event

    async def _execute_run(self, run_id: str) -> None:
        session = self._session_factory()
        seen_turns: set[int] = set()
        try:
            run = session.execute(
                select(AgentRun)
                .where(AgentRun.id == run_id)
                .options(
                    joinedload(AgentRun.messages).joinedload(MessageRecord.asset_links).joinedload(MessageAsset.asset),
                )
            ).unique().scalars().first()
            if run is None:
                return

            conversation = session.execute(
                select(Conversation)
                .where(Conversation.id == run.conversation_id)
                .options(
                    joinedload(Conversation.messages)
                    .joinedload(MessageRecord.asset_links)
                    .joinedload(MessageAsset.asset)
                )
            ).unique().scalars().first()
            project = get_project(session, run.project_id)
            trigger_message = session.get(MessageRecord, run.trigger_message_id) if run.trigger_message_id else None
            if conversation is None or project is None or trigger_message is None:
                raise LookupError("Run context is incomplete.")

            run.status = "running"
            run.started_at = datetime.now(timezone.utc)
            run.provider = provider_for_model(run.model)
            session.commit()
            await self._record_event(
                session,
                run,
                event_type="run.started",
                payload={"type": "run.started", "run_id": run.id, "conversation_id": conversation.id},
            )

            history_records = sorted(
                [message for message in conversation.messages if message.sequence_no < trigger_message.sequence_no],
                key=lambda item: item.sequence_no,
            )
            history = []
            for message in history_records:
                runtime_message = _message_to_runtime(message)
                if runtime_message is not None:
                    history.append(runtime_message)
            current_assets = [link.asset for link in trigger_message.asset_links if link.asset.deleted_at is None]
            attachments = [
                Attachment(
                    mime_type=asset.mime_type,
                    content=resolve_asset_bytes(asset),
                    name=asset.original_name,
                )
                for asset in current_assets
                if asset.mime_type.startswith("image/")
            ]

            settings = get_settings()
            loop = asyncio.get_running_loop()
            parent_run_id = run.id

            def parent_event_sink(payload: dict[str, Any]) -> None:
                event_type = payload.get("type")
                if not isinstance(event_type, str):
                    return
                future = asyncio.run_coroutine_threadsafe(
                    self.record_external_event(
                        parent_run_id,
                        event_type=event_type,
                        payload=payload,
                    ),
                    loop,
                )
                try:
                    future.result(timeout=10)
                except Exception:
                    future.cancel()

            tool_runtime = get_tools_registry(
                session,
                project_id=conversation.project_id,
                conversation_id=conversation.id,
                run=run,
                uploads_dir=settings.uploads_dir,
                parent_event_sink=parent_event_sink,
            )

            request = AgentRequest(
                model=run.model,
                system_prompt=run.system_prompt_text,
                query=trigger_message.content_text or "",
                history=history,
                attachments=attachments or None,
                tools=tool_runtime.definitions,
                input_mode=InputMode(run.input_mode),
                config=GenConfig(
                    thinking=ThinkingLevel(run.request_json.get("thinking_level", ThinkingLevel.OFF.value))
                ),
            )
            tool_batch_executor = ProjectToolBatchExecutor(
                session_factory=self._session_factory,
                project_id=conversation.project_id,
                conversation_id=conversation.id,
                run_id=run.id,
                uploads_dir=settings.uploads_dir,
                parent_event_sink=parent_event_sink,
            )
            try:
                runner = self._runner_factory(
                    tool_executor=tool_runtime.execute,
                    tool_batch_executor=tool_batch_executor,
                )
            except TypeError:
                runner = self._runner_factory()
                if hasattr(runner, "tool_executor"):
                    runner.tool_executor = tool_runtime.execute
                if hasattr(runner, "tool_batch_executor"):
                    runner.tool_batch_executor = tool_batch_executor
                if hasattr(runner, "tool_handlers"):
                    runner.tool_handlers = {}
            final_event: AgentEvent | None = None

            coalescer = _DeltaCoalescer(
                record_event=self._record_event,
                flush_ms=settings.stream_delta_flush_ms,
                flush_chars=settings.stream_delta_flush_chars,
            )

            async for event in self._stream_with_watchdog(
                run.id,
                runner.stream(request),
                settings.run_no_progress_timeout_seconds,
            ):
                if event.type == AgentEventType.FINAL_RESPONSE:
                    await coalescer.flush(session, run)
                    final_event = event
                    continue

                turn = None
                if event.type != AgentEventType.ERROR:
                    turn = self._ensure_turn(
                        session,
                        run,
                        event.round_index,
                        provider=event.provider,
                        model=event.model,
                    )
                    if event.round_index not in seen_turns:
                        await coalescer.flush(session, run)
                        seen_turns.add(event.round_index)
                        await self._emit_turn_started(session, run, turn)

                if event.type == AgentEventType.THINKING and event.response and event.response.thinking and turn is not None:
                    await coalescer.feed(
                        session,
                        run,
                        kind=_DELTA_KIND_THINKING,
                        round_index=event.round_index,
                        turn=turn,
                        delta=event.response.thinking,
                    )
                elif event.type == AgentEventType.CONTENT and event.response and event.response.content and turn is not None:
                    await coalescer.feed(
                        session,
                        run,
                        kind=_DELTA_KIND_CONTENT,
                        round_index=event.round_index,
                        turn=turn,
                        delta=event.response.content,
                    )
                elif (
                    event.type == AgentEventType.ASSISTANT_MESSAGE
                    and event.message is not None
                    and event.message.tool_calls
                    and event.message.content
                ):
                    await coalescer.flush(session, run)
                    await self._record_event(
                        session,
                        run,
                        event_type="run.assistant.message",
                        payload={
                            "type": "run.assistant.message",
                            "run_id": run.id,
                            "round_index": event.round_index,
                            "content_text": event.message.content,
                        },
                        turn=turn,
                        content_text=event.message.content,
                    )
                elif event.type == AgentEventType.ERROR:
                    await coalescer.flush(session, run)
                    await self._record_event(
                        session,
                        run,
                        event_type="run.warning",
                        payload={
                            "type": "run.warning",
                            "run_id": run.id,
                            "round_index": event.round_index,
                            "message": event.error,
                        },
                        status="error",
                    )
                elif event.type == AgentEventType.TOOL_CALL and event.tool_call is not None:
                    await coalescer.flush(session, run)
                    await self._record_event(
                        session,
                        run,
                        event_type="run.tool.called",
                        payload={
                            "type": "run.tool.called",
                            "run_id": run.id,
                            "round_index": event.round_index,
                            "tool_call": {
                                "id": event.tool_call.id,
                                "name": event.tool_call.name,
                                "arguments": event.tool_call.arguments,
                            },
                        },
                        turn=turn,
                        tool_call_ref=event.tool_call.id,
                    )
                elif event.type == AgentEventType.TOOL_RESULT and event.tool_call is not None and event.tool_result is not None:
                    await coalescer.flush(session, run)
                    await self._record_event(
                        session,
                        run,
                        event_type="run.tool.result",
                        payload={
                            "type": "run.tool.result",
                            "run_id": run.id,
                            "round_index": event.round_index,
                            "tool_call_id": event.tool_call.id,
                            "tool_name": event.tool_call.name,
                            "tool_result": to_json_compatible(event.tool_result),
                        },
                        turn=turn,
                        tool_call_ref=event.tool_call.id,
                    )
                    await self._record_tool_side_effects(
                        session, run, event.tool_call.name, tool_call_id=event.tool_call.id
                    )

            await coalescer.flush(session, run)

            if final_event is None or final_event.response is None:
                raise RuntimeError("Agent run completed without a final response.")

            final_response = final_event.response
            if not final_response.content.strip() and final_response.metadata.get("agent_tools_called"):
                final_response = final_response.model_copy(
                    update={
                        "content": (
                            "I could not complete the last requested action. "
                            "Please review the run trace for the tool error, then tell me how you want to proceed."
                        )
                    }
                )
            session.refresh(run)
            if is_terminal_run_status(run.status):
                return
            telemetry_items = final_response.metadata.get("agent_turn_telemetry", [])
            for telemetry in telemetry_items:
                telemetry_data = to_json_compatible(telemetry)
                round_index = telemetry_data.get("round_index", 0)
                turn = self._ensure_turn(session, run, round_index, provider=final_event.provider, model=final_event.model)
                turn.phase = telemetry_data.get("phase", turn.phase)
                usage = telemetry_data.get("usage", {})
                turn.had_thinking = telemetry_data.get("had_thinking", False)
                turn.tool_call_count = telemetry_data.get("tool_call_count", 0)
                turn.parsed_output_present = telemetry_data.get("parsed_output", False)
                turn.elapsed_ms = telemetry_data.get("elapsed_ms", 0.0)
                turn.metadata_json = telemetry_data
                turn.usage_input_tokens = usage.get("input_tokens", 0)
                turn.usage_output_tokens = usage.get("output_tokens", 0)
                turn.usage_completion_tokens = usage.get("completion_tokens", 0)
                turn.usage_total_tokens = usage.get("total_tokens", 0)
                turn.response_json = to_json_compatible(final_response)
                turn.raw_dump_json = to_json_compatible(final_response.raw_dump)
                turn.parsed_output_json = to_json_compatible(final_response.parsed) if final_response.parsed else {}
                session.commit()
                await self._record_event(
                    session,
                    run,
                    event_type="run.turn.completed",
                    payload={
                        "type": "run.turn.completed",
                        "run_id": run.id,
                        "turn_id": turn.id,
                        "round_index": round_index,
                        "phase": turn.phase,
                    },
                    turn=turn,
                )

            assistant_message = MessageRecord(
                project_id=conversation.project_id,
                conversation_id=conversation.id,
                agent_run_id=run.id,
                task_id=run.task_id,
                execution_mode=run.execution_mode,
                role=MessageRole.ASSISTANT.value,
                input_mode=InputMode.TEXT.value,
                content_text=final_response.content,
                thinking_text=final_response.thinking,
                status="completed",
                sequence_no=next_message_sequence(session, conversation.id),
                provider=final_event.provider,
                model=final_event.model,
                metadata_json=to_json_compatible(final_response.metadata),
            )
            session.add(assistant_message)
            session.flush()

            run.response_message_id = assistant_message.id
            run.status = "completed"
            run.completed_at = datetime.now(timezone.utc)
            run.final_response_json = to_json_compatible(final_response)
            run.final_parsed_json = to_json_compatible(final_response.parsed) if final_response.parsed else {}
            run.aggregated_metadata_json = to_json_compatible(final_response.metadata)
            usage = final_response.metadata.get("agent_usage", final_response.usage)
            usage_data = to_json_compatible(usage)
            run.usage_input_tokens = usage_data.get("input_tokens", 0)
            run.usage_output_tokens = usage_data.get("output_tokens", 0)
            run.usage_completion_tokens = usage_data.get("completion_tokens", 0)
            run.usage_total_tokens = usage_data.get("total_tokens", 0)
            run.elapsed_ms = final_response.metadata.get("agent_elapsed_ms", 0.0)
            trigger_message.status = "completed"
            conversation.updated_at = datetime.now(timezone.utc)
            session.commit()

            await self._record_event(
                session,
                run,
                event_type="run.message.completed",
                payload={
                    "type": "run.message.completed",
                    "run_id": run.id,
                    "message": serialize_message(assistant_message),
                },
                content_text=assistant_message.content_text,
                thinking_text=assistant_message.thinking_text,
            )
            await self._record_event(
                session,
                run,
                event_type="run.completed",
                payload={
                    "type": "run.completed",
                    "run_id": run.id,
                    "response_message_id": assistant_message.id,
                },
            )
        except asyncio.CancelledError:
            session.rollback()
            run = session.get(AgentRun, run_id)
            if run is not None and not is_terminal_run_status(run.status):
                await self._mark_run_terminal(
                    session,
                    run,
                    status="cancelled",
                    message="Stopped by user.",
                    terminal_event_payload={
                        "type": "run.cancelled",
                        "run_id": run.id,
                        "reason": "user_cancelled",
                    },
                )
            raise
        except RunStalledError as exc:
            session.rollback()
            run = session.get(AgentRun, run_id)
            if run is not None:
                await self._mark_run_terminal(
                    session,
                    run,
                    status="stalled",
                    message=str(exc),
                    terminal_event_payload={
                        "type": "run.stalled",
                        "run_id": run.id,
                        "reason": "no_progress_timeout",
                        "timeout_seconds": exc.timeout_seconds,
                    },
                    event_status="error",
                )
        except Exception as exc:
            session.rollback()
            run = session.get(AgentRun, run_id)
            if run is not None:
                if is_terminal_run_status(run.status):
                    return
                run.status = "failed"
                run.completed_at = datetime.now(timezone.utc)
                run.error_message = str(exc)
                trigger_message = session.get(MessageRecord, run.trigger_message_id) if run.trigger_message_id else None
                if trigger_message is not None:
                    trigger_message.status = "failed"
                    trigger_message.failed_at = datetime.now(timezone.utc)
                session.commit()
                await self._record_event(
                    session,
                    run,
                    event_type="run.failed",
                    payload={"type": "run.failed", "run_id": run.id, "error": str(exc)},
                    status="error",
                )
        finally:
            session.close()
