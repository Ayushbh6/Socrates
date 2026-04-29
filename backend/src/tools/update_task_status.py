from __future__ import annotations

from typing import Any

from ..agent.tools import build_tool_error_result
from ..services.tasks import TaskClosureValidationError, close_task, serialize_task


def handle(runtime: Any, status: str, result_summary: str):
    task = runtime.context.current_task or runtime.context.refresh_task()
    if task is None:
        return runtime._task_required_error(
            "update_task_status", "There is no active task to close."
        )
    if status == "completed" and not runtime._current_user_message_accepts_completion():
        return build_tool_error_result(
            tool_name="update_task_status",
            error_type="acceptance_required",
            message="Task completion requires explicit user acceptance in the current user message.",
            retryable=True,
            suggestion="Wait for the user to explicitly accept the delivered work before marking the task completed.",
        )
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
