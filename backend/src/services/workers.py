from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Literal

from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..agent import AgentRequest, AgentRunner
from ..agent.events import AgentEventType
from ..agent.schema import AgentConfig
from ..agents import build_worker_system_prompt
from ..core.model_catalog import provider_for_model
from ..core.schema import GenConfig, InputMode, ThinkingLevel
from ..db.models import AgentEventRecord, AgentRun, Task, TaskApproval
from ..db.session import get_session_factory
from ..tools.executor import ProjectToolBatchExecutor
from ..tools.task_workspace_policy import RESERVED_TASK_FOLDER_NAMES
from ..tools.worker_runtime import get_worker_tools_registry
from .task_package import (
    get_task_package_disk_state,
    parse_worker_todo_state,
)
from .tasks import (
    ACTIVE_TASK_STATUSES,
    is_plan_sha256_approved,
)
from .utils import to_json_compatible

ACTIVE_RUN_STATUSES = {"queued", "running"}
TERMINAL_RUN_STATUSES = {"completed", "failed", "blocked", "cancelled", "stalled"}


def _is_terminal_run_status(status: str | None) -> bool:
    return status in TERMINAL_RUN_STATUSES


class WorkerBlocker(BaseModel):
    type: str
    message: str
    recommended_socrates_action: str | None = None


class WorkerTodoResult(BaseModel):
    checked_ids: list[str] = Field(default_factory=list)
    remaining_ids: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class WorkerChangedFile(BaseModel):
    scope: str
    path: str
    operation: str


class WorkerOutput(BaseModel):
    path: str
    description: str | None = None
    sha256: str | None = None


class WorkerVerification(BaseModel):
    command: str | None = None
    exit_code: int | None = None
    summary: str


class WorkerResult(BaseModel):
    status: Literal["completed", "blocked", "failed"]
    summary: str
    todo: WorkerTodoResult = Field(default_factory=WorkerTodoResult)
    changed_files: list[WorkerChangedFile] = Field(default_factory=list)
    outputs: list[WorkerOutput] = Field(default_factory=list)
    verification: list[WorkerVerification] = Field(default_factory=list)
    blockers: list[WorkerBlocker] = Field(default_factory=list)
    handoff_to_socrates: str = ""


class WorkerStartError(ValueError):
    def __init__(self, error_type: str, message: str):
        super().__init__(message)
        self.error_type = error_type
        self.message = message


def run_worker_blocking(
    session: Session,
    *,
    parent_run: AgentRun,
    task: Task,
    uploads_dir: Path,
    parent_event_sink: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    _validate_worker_start(session, task=task)
    handoff = _build_handoff(task)
    worker_run = _create_worker_run(session, parent_run=parent_run, task=task, handoff=handoff)
    started_event = {
        "type": "task.worker.started",
        "run_id": parent_run.id,
        "task_id": task.id,
        "worker_run_id": worker_run.id,
    }
    _emit_parent_worker_event(parent_event_sink, started_event)
    try:
        result = _execute_worker_run(
            session,
            worker_run=worker_run,
            parent_run=parent_run,
            handoff=handoff,
            uploads_dir=uploads_dir,
            parent_event_sink=parent_event_sink,
        )
    except Exception as exc:
        session.rollback()
        worker_run = session.get(AgentRun, worker_run.id)
        if worker_run is not None:
            if _is_terminal_run_status(worker_run.status):
                session.commit()
            else:
                worker_run.status = "failed"
                worker_run.completed_at = datetime.now(timezone.utc)
                worker_run.error_message = str(exc)
                session.commit()
        failed_result = WorkerResult(
            status="failed",
            summary=str(exc),
            blockers=[
                WorkerBlocker(
                    type="worker_runtime_error",
                    message=str(exc),
                    recommended_socrates_action="Review the worker failure and decide whether to revise the plan or report failure.",
                )
            ],
            handoff_to_socrates="The worker failed before returning a structured result.",
        )
        result_payload = failed_result.model_dump()
        terminal_event = {
            "type": "task.worker.failed",
            "run_id": parent_run.id,
            "task_id": task.id,
            "worker_run_id": worker_run.id if worker_run is not None else None,
            "result": result_payload,
        }
        progress_event = _progress_event(
            parent_run=parent_run,
            task=task,
            worker_run_id=worker_run.id if worker_run is not None else None,
            result=result_payload,
        )
        _emit_parent_worker_event(parent_event_sink, progress_event)
        _emit_parent_worker_event(parent_event_sink, terminal_event)
        return {
            "worker_run_id": worker_run.id if worker_run is not None else None,
            "worker_result": result_payload,
        }

    event_type = {
        "completed": "task.worker.completed",
        "blocked": "task.worker.blocked",
        "failed": "task.worker.failed",
    }[result.status]
    result_payload = result.model_dump()
    progress_event = _progress_event(
        parent_run=parent_run,
        task=task,
        worker_run_id=worker_run.id,
        result=result_payload,
    )
    terminal_event = {
        "type": event_type,
        "run_id": parent_run.id,
        "task_id": task.id,
        "worker_run_id": worker_run.id,
        "result": result_payload,
    }
    _emit_parent_worker_event(parent_event_sink, progress_event)
    _emit_parent_worker_event(parent_event_sink, terminal_event)
    return {
        "worker_run_id": worker_run.id,
        "worker_result": result_payload,
    }


def _emit_parent_worker_event(
    parent_event_sink: Callable[[dict[str, Any]], None] | None, payload: dict[str, Any]
) -> None:
    if parent_event_sink is not None:
        parent_event_sink(payload)


def _progress_event(
    *, parent_run: AgentRun, task: Task, worker_run_id: str | None, result: dict[str, Any]
) -> dict[str, Any]:
    return {
        "type": "task.worker.progress",
        "run_id": parent_run.id,
        "task_id": task.id,
        "worker_run_id": worker_run_id,
        "summary": result.get("summary"),
        "status": result.get("status"),
        "todo": result.get("todo"),
    }


def _validate_worker_start(session: Session, *, task: Task) -> None:
    if task.status not in ACTIVE_TASK_STATUSES:
        raise WorkerStartError(
            "task_already_terminal",
            "Worker can only start for an active task.",
        )
    state = get_task_package_disk_state(Path(task.workspace_root).resolve())
    if not state.task.valid:
        raise WorkerStartError("planning_required", "task.md must be valid before worker start.")
    if not state.plan.valid or state.plan_fingerprint is None:
        raise WorkerStartError("planning_required", "plan.md must be valid before worker start.")
    if not is_plan_sha256_approved(session, task.id, state.plan_fingerprint):
        raise WorkerStartError(
            "plan_approval_required",
            "The current plan.md revision must be approved before worker start.",
        )
    if not state.todo.valid or state.todo.content is None:
        raise WorkerStartError("todo_required", "todo.md must be valid before worker start.")
    active_worker = (
        session.execute(
            select(AgentRun)
            .where(
                AgentRun.task_id == task.id,
                AgentRun.execution_mode == "worker",
                AgentRun.status.in_(tuple(ACTIVE_RUN_STATUSES)),
            )
            .order_by(AgentRun.created_at.desc())
        )
        .scalars()
        .first()
    )
    if active_worker is not None:
        raise WorkerStartError(
            "worker_already_running",
            "A worker is already running for this task.",
        )
    pending_approval = (
        session.execute(
            select(func.count())
            .select_from(TaskApproval)
            .where(
                TaskApproval.task_id == task.id,
                TaskApproval.status == "pending",
            )
        ).scalar_one()
    )
    if pending_approval:
        raise WorkerStartError(
            "approval_required",
            "All pending user approvals for this task must be resolved before worker start.",
        )
    parse_worker_todo_state(state.todo.content)


def _build_handoff(task: Task) -> dict[str, Any]:
    root = Path(task.workspace_root).resolve()
    task_text = (root / "task.md").read_text(encoding="utf-8", errors="replace")
    plan_text = (root / "plan.md").read_text(encoding="utf-8", errors="replace")
    todo_text = (root / "todo.md").read_text(encoding="utf-8", errors="replace")
    state = get_task_package_disk_state(root)
    return {
        "task_id": task.id,
        "conversation_id": task.conversation_id,
        "project_id": task.project_id,
        "task_package": {
            "task_md": task_text,
            "plan_md": plan_text,
            "todo_md": todo_text,
            "plan_sha256": state.plan.content_sha256,
            "todo_sha256": state.todo.content_sha256,
        },
        "workspace": {
            "allowed_task_paths": ["task.md", "plan.md", "todo.md", "work/**", "outputs/**"],
            "read_only_task_paths": ["inputs/**", "logs/**", "task.md", "plan.md"],
            "writable_task_paths": ["todo.md", "work/**", "outputs/**"],
            "reserved_task_folder_names": sorted(RESERVED_TASK_FOLDER_NAMES),
            "path_env_vars": {
                "task_root": "SOCRATES_TASK_ROOT",
                "inputs": "SOCRATES_INPUTS_DIR",
                "work": "SOCRATES_WORK_DIR",
                "outputs": "SOCRATES_OUTPUTS_DIR",
                "logs": "SOCRATES_LOGS_DIR",
            },
            "path_warning": "Final deliverables must go to top-level outputs/. A script running from work/ must use SOCRATES_OUTPUTS_DIR instead of relative outputs/ paths.",
        },
        "execution_policy": {
            "max_tool_rounds": 100,
            "max_parallel_tool_calls": 6,
            "must_update_todo": True,
            "must_verify": True,
            "must_report_blockers": True,
        },
    }


def _create_worker_run(
    session: Session, *, parent_run: AgentRun, task: Task, handoff: dict[str, Any]
) -> AgentRun:
    now = datetime.now(timezone.utc)
    worker_run = AgentRun(
        project_id=task.project_id,
        conversation_id=task.conversation_id,
        task_id=task.id,
        trigger_message_id=parent_run.trigger_message_id,
        status="queued",
        execution_mode="worker",
        provider=parent_run.provider or provider_for_model(parent_run.model),
        model=parent_run.model,
        input_mode=InputMode.TEXT.value,
        system_prompt_text=build_worker_system_prompt(),
        query_text=_worker_query(handoff),
        request_json={
            "parent_run_id": parent_run.id,
            "worker_handoff": handoff,
            "thinking_level": parent_run.request_json.get("thinking_level", ThinkingLevel.OFF.value),
        },
        created_at=now,
    )
    session.add(worker_run)
    session.commit()
    session.refresh(worker_run)
    return worker_run


def _execute_worker_run(
    session: Session,
    *,
    worker_run: AgentRun,
    parent_run: AgentRun,
    handoff: dict[str, Any],
    uploads_dir: Path,
    parent_event_sink: Callable[[dict[str, Any]], None] | None,
) -> WorkerResult:
    worker_run.status = "running"
    worker_run.started_at = datetime.now(timezone.utc)
    session.commit()
    _record_worker_event(
        session,
        worker_run,
        event_type="run.started",
        payload={"type": "run.started", "run_id": worker_run.id, "conversation_id": worker_run.conversation_id},
    )
    tool_runtime = get_worker_tools_registry(
        session,
        project_id=worker_run.project_id,
        conversation_id=worker_run.conversation_id,
        run=worker_run,
        uploads_dir=uploads_dir,
    )
    batch_executor = ProjectToolBatchExecutor(
        session_factory=get_session_factory(),
        project_id=worker_run.project_id,
        conversation_id=worker_run.conversation_id,
        run_id=worker_run.id,
        uploads_dir=uploads_dir,
        registry_factory=get_worker_tools_registry,
    )
    request = AgentRequest(
        model=worker_run.model,
        system_prompt=worker_run.system_prompt_text,
        query=_worker_query(handoff),
        tools=tool_runtime.definitions,
        response_model=WorkerResult,
        input_mode=InputMode.TEXT,
        config=GenConfig(
            thinking=ThinkingLevel(
                worker_run.request_json.get("thinking_level", ThinkingLevel.OFF.value)
            )
        ),
        agent=AgentConfig(max_parallel_tool_calls=6),
    )
    runner = AgentRunner(
        tool_executor=tool_runtime.execute,
        tool_batch_executor=batch_executor,
    )
    result_response = asyncio.run(
        _run_worker_stream(
            session,
            worker_run,
            parent_run=parent_run,
            runner=runner,
            request=request,
            parent_event_sink=parent_event_sink,
        )
    )
    result = _with_current_todo_summary(
        session=session,
        task_id=worker_run.task_id,
        result=_coerce_worker_result(result_response),
    )
    session.refresh(worker_run)
    if _is_terminal_run_status(worker_run.status):
        return WorkerResult(
            status="failed",
            summary=f"Worker run was already marked {worker_run.status}.",
            blockers=[
                WorkerBlocker(
                    type=worker_run.status,
                    message=worker_run.error_message or f"Worker run was marked {worker_run.status}.",
                    recommended_socrates_action="Ask the user whether to retry, revise the plan, or abandon the task.",
                )
            ],
            handoff_to_socrates=f"The worker run was already marked {worker_run.status}.",
        )
    worker_run.status = result.status
    worker_run.completed_at = datetime.now(timezone.utc)
    worker_run.error_message = result.summary if result.status in {"blocked", "failed"} else None
    worker_run.final_response_json = to_json_compatible(result_response)
    worker_run.final_parsed_json = result.model_dump()
    worker_run.aggregated_metadata_json = {
        **to_json_compatible(result_response.metadata),
        "worker_result": result.model_dump(),
    }
    usage = to_json_compatible(result_response.metadata.get("agent_usage", result_response.usage))
    worker_run.usage_input_tokens = usage.get("input_tokens", 0)
    worker_run.usage_output_tokens = usage.get("output_tokens", 0)
    worker_run.usage_completion_tokens = usage.get("completion_tokens", 0)
    worker_run.usage_total_tokens = usage.get("total_tokens", 0)
    worker_run.elapsed_ms = result_response.metadata.get("agent_elapsed_ms", 0.0)
    session.commit()
    _record_worker_event(
        session,
        worker_run,
        event_type=f"run.{result.status}",
        payload={"type": f"run.{result.status}", "run_id": worker_run.id},
        status="error" if result.status in {"blocked", "failed"} else "ok",
    )
    return result


def _with_current_todo_summary(
    *, session: Session, task_id: str | None, result: WorkerResult
) -> WorkerResult:
    if task_id is None:
        return result
    task = session.get(Task, task_id)
    if task is None:
        return result
    todo_path = Path(task.workspace_root).resolve() / "todo.md"
    if not todo_path.is_file():
        return result
    state = parse_worker_todo_state(todo_path.read_text(encoding="utf-8", errors="replace"))
    checked = [item.item_id for item in state.items if item.status == "completed"]
    remaining = [
        item.item_id
        for item in state.items
        if item.status not in {"completed", "skipped"}
    ]
    todo = WorkerTodoResult(
        checked_ids=checked,
        remaining_ids=remaining,
        notes=result.todo.notes,
    )
    if result.status == "completed" and remaining:
        return result.model_copy(
            update={
                "status": "blocked",
                "summary": "Worker reported completion, but todo.md still has unfinished items.",
                "todo": todo,
                "blockers": [
                    *result.blockers,
                    WorkerBlocker(
                        type="todo_incomplete",
                        message=f"Unfinished todo items remain: {', '.join(remaining)}.",
                        recommended_socrates_action="Review the worker trace and either continue execution or revise the plan/todo.",
                    ),
                ],
                "handoff_to_socrates": "The worker cannot be accepted as complete because todo.md is not fully resolved.",
            }
        )
    return result.model_copy(update={"todo": todo})


async def _run_worker_stream(
    session: Session,
    worker_run: AgentRun,
    *,
    parent_run: AgentRun,
    runner: AgentRunner,
    request: AgentRequest,
    parent_event_sink: Callable[[dict[str, Any]], None] | None,
):
    final_response = None
    async for event in runner.stream(request):
        if event.type == AgentEventType.TOOL_CALL and event.tool_call is not None:
            _record_worker_event(
                session,
                worker_run,
                event_type="run.tool.called",
                payload={
                    "type": "run.tool.called",
                    "run_id": worker_run.id,
                    "round_index": event.round_index,
                    "tool_call": {
                        "id": event.tool_call.id,
                        "name": event.tool_call.name,
                        "arguments": event.tool_call.arguments,
                    },
                },
                tool_call_ref=event.tool_call.id,
            )
            _emit_parent_worker_event(
                parent_event_sink,
                {
                    "type": "task.worker.tool.called",
                    "run_id": parent_run.id,
                    "task_id": worker_run.task_id,
                    "worker_run_id": worker_run.id,
                    "round_index": event.round_index,
                    "tool_call": {
                        "id": event.tool_call.id,
                        "name": event.tool_call.name,
                        "arguments": _summarize_worker_tool_arguments(event.tool_call.name, event.tool_call.arguments),
                    },
                },
            )
        elif event.type == AgentEventType.TOOL_RESULT and event.tool_call is not None:
            _record_worker_event(
                session,
                worker_run,
                event_type="run.tool.result",
                payload={
                    "type": "run.tool.result",
                    "run_id": worker_run.id,
                    "round_index": event.round_index,
                    "tool_call_id": event.tool_call.id,
                    "tool_name": event.tool_call.name,
                    "tool_result": to_json_compatible(event.tool_result),
                },
                tool_call_ref=event.tool_call.id,
            )
            result_summary = _summarize_worker_tool_result(
                event.tool_call.name,
                to_json_compatible(event.tool_result),
            )
            _emit_parent_worker_event(
                parent_event_sink,
                {
                    "type": "task.worker.tool.result",
                    "run_id": parent_run.id,
                    "task_id": worker_run.task_id,
                    "worker_run_id": worker_run.id,
                    "round_index": event.round_index,
                    "tool_call_id": event.tool_call.id,
                    "tool_name": event.tool_call.name,
                    "tool_result": result_summary,
                },
            )
            if event.tool_call.name in {"update_current_todo_item", "skip_todo_item"}:
                _emit_parent_worker_event(
                    parent_event_sink,
                    {
                        "type": "task.worker.todo.updated",
                        "run_id": parent_run.id,
                        "task_id": worker_run.task_id,
                        "worker_run_id": worker_run.id,
                        "round_index": event.round_index,
                        "tool_call_id": event.tool_call.id,
                        "todo": result_summary,
                    },
                )
        elif event.type == AgentEventType.ERROR:
            _record_worker_event(
                session,
                worker_run,
                event_type="run.warning",
                payload={
                    "type": "run.warning",
                    "run_id": worker_run.id,
                    "round_index": event.round_index,
                    "message": event.error,
                },
                status="error",
            )
            _emit_parent_worker_event(
                parent_event_sink,
                {
                    "type": "task.worker.warning",
                    "run_id": parent_run.id,
                    "task_id": worker_run.task_id,
                    "worker_run_id": worker_run.id,
                    "round_index": event.round_index,
                    "message": event.error,
                },
            )
        elif event.type == AgentEventType.FINAL_RESPONSE and event.response is not None:
            final_response = event.response
    if final_response is None:
        raise RuntimeError("Worker completed without a final response.")
    return final_response


def _summarize_worker_tool_arguments(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    if tool_name in {"write_file", "edit_file", "apply_patch"}:
        summary = {key: arguments.get(key) for key in ("scope", "path", "overwrite") if key in arguments}
        if tool_name == "apply_patch":
            summary["scope"] = arguments.get("scope")
            patch_text = arguments.get("patch_text")
            summary["patch_chars"] = len(patch_text) if isinstance(patch_text, str) else 0
        return summary
    if tool_name == "execute_command":
        return {
            "scope": arguments.get("scope"),
            "argv": arguments.get("argv"),
            "cwd": arguments.get("cwd"),
        }
    compatible = to_json_compatible(arguments)
    return compatible if isinstance(compatible, dict) else {}


def _summarize_worker_tool_result(tool_name: str, result: Any) -> dict[str, Any]:
    payload = result
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return {"ok": True, "summary": payload[:500]}
    if not isinstance(payload, dict):
        return {"ok": True, "summary": str(payload)[:500]}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    if tool_name in {"update_current_todo_item", "skip_todo_item"}:
        todo_payload = data if data else payload
        summary = {
            key: todo_payload.get(key)
            for key in ("ok", "item", "next_item", "done", "progress", "error_type", "message")
            if key in todo_payload
        }
        if "ok" not in summary and "ok" in payload:
            summary["ok"] = payload.get("ok")
        if "error_type" not in summary and "error_type" in payload:
            summary["error_type"] = payload.get("error_type")
        if "message" not in summary and "message" in payload:
            summary["message"] = payload.get("message")
        return summary
    if tool_name in {"write_file", "edit_file", "apply_patch"}:
        return {
            "ok": payload.get("ok"),
            "path": payload.get("path") or data.get("path"),
            "scope": payload.get("scope") or data.get("scope"),
            "registered_outputs": payload.get("registered_outputs") or data.get("registered_outputs"),
            "error_type": payload.get("error_type"),
            "message": payload.get("message"),
        }
    return {
        key: payload.get(key)
        for key in ("ok", "tool_name", "error_type", "message", "summary")
        if key in payload
    }


def _coerce_worker_result(response: Any) -> WorkerResult:
    if isinstance(response.parsed, WorkerResult):
        return response.parsed
    if response.parsed is not None:
        return WorkerResult.model_validate(to_json_compatible(response.parsed))
    try:
        payload = json.loads(response.content)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Worker did not return valid structured JSON.") from exc
    return WorkerResult.model_validate(payload)


def _record_worker_event(
    session: Session,
    run: AgentRun,
    *,
    event_type: str,
    payload: dict[str, Any],
    status: str = "ok",
    tool_call_ref: str | None = None,
) -> None:
    session.refresh(run)
    if _is_terminal_run_status(run.status) and event_type != f"run.{run.status}":
        return
    max_seq = session.execute(
        select(func.max(AgentEventRecord.sequence_no)).where(AgentEventRecord.agent_run_id == run.id)
    ).scalar_one()
    record = AgentEventRecord(
        agent_run_id=run.id,
        sequence_no=int(max_seq or 0) + 1,
        event_type=event_type,
        status=status,
        tool_call_ref=tool_call_ref,
        payload_json=to_json_compatible(payload),
    )
    session.add(record)
    session.commit()


def _worker_query(handoff: dict[str, Any]) -> str:
    return (
        "Execute this approved task package. Follow the worker todo tools one item at a time. "
        "Return only the structured worker result when complete, blocked, or failed.\n\n"
        f"HANDOFF_JSON:\n{json.dumps(handoff, ensure_ascii=True, sort_keys=True)}"
    )
