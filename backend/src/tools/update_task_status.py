from __future__ import annotations

from typing import Any

from ..agent.tools import build_tool_error_result
from ..services.tasks import (
    TASK_COMPLETION_APPROVAL_TYPE,
    TaskClosureValidationError,
    close_task,
    ensure_task_completion_approval,
    find_matching_approval,
    serialize_task,
    task_completion_approval_request_payload,
    _validate_task_closure,
)


def handle(runtime: Any, status: str, result_summary: str):
    task = runtime.context.current_task or runtime.context.refresh_task()
    if task is None:
        return runtime._task_required_error(
            "update_task_status", "There is no active task to close."
        )
    if status == "completed":
        try:
            _validate_task_closure(
                runtime.context.session,
                task=task,
                status=status,
                result_summary=result_summary,
            )
        except TaskClosureValidationError as exc:
            return build_tool_error_result(
                tool_name="update_task_status",
                error_type=exc.error_type,
                message=exc.message,
                retryable=exc.retryable,
                suggestion=exc.suggestion,
            )
        payload = task_completion_approval_request_payload(
            status=status,
            result_summary=result_summary,
        )
        existing = find_matching_approval(
            runtime.context.session,
            task_id=task.id,
            approval_type=TASK_COMPLETION_APPROVAL_TYPE,
            request_json=payload,
        )
        if existing is not None and existing.status == "approved":
            pass
        elif existing is not None and existing.status == "denied":
            return build_tool_error_result(
                tool_name="update_task_status",
                error_type="completion_denied",
                message="The user declined to mark this task completed.",
                retryable=True,
                suggestion="Ask the user what remains before retrying task completion.",
            )
        else:
            approval = ensure_task_completion_approval(
                runtime.context.session,
                task_id=task.id,
                agent_run_id=runtime.context.run.id,
                tool_execution_id=runtime.context.current_tool_execution_id,
                status=status,
                result_summary=result_summary,
            )
            return {
                "ok": False,
                "tool_name": "update_task_status",
                "error_type": "approval_required",
                "message": "The task is not completed yet. Socrates needs user approval before marking this task completed.",
                "retryable": True,
                "suggestion": f"Tell the user that completion approval has been requested, wait for approval id {approval.id} to be approved, then retry the exact same tool call.",
                "approval_id": approval.id,
            }
    try:
        closed = close_task(
            runtime.context.session,
            task.id,
            status=status,
            result_summary=result_summary,
        )
    except TaskClosureValidationError as exc:
        return build_tool_error_result(
            tool_name="update_task_status",
            error_type=exc.error_type,
            message=exc.message,
            retryable=exc.retryable,
            suggestion=exc.suggestion,
        )
    runtime.context.current_task = None
    runtime.context.session.refresh(runtime.context.run)
    return {
        "task": serialize_task(closed),
        "status": closed.status,
        "result_summary": closed.result_summary,
    }
