from __future__ import annotations

from typing import Any

from ..agent.tools import build_tool_error_result
from ..core.settings import get_settings


def handle(runtime: Any):
    from ..services.workers import WorkerStartError, run_worker_blocking

    if runtime.context.run.execution_mode == "worker":
        return build_tool_error_result(
            tool_name="start_worker",
            error_type="permission_denied",
            message="Workers cannot start other workers.",
            retryable=False,
        )
    task = runtime._require_task()
    settings = get_settings()
    try:
        return run_worker_blocking(
            runtime.context.session,
            parent_run=runtime.context.run,
            task=task,
            uploads_dir=settings.uploads_dir,
            parent_event_sink=runtime.context.parent_event_sink,
        )
    except WorkerStartError as exc:
        return build_tool_error_result(
            tool_name="start_worker",
            error_type=exc.error_type,
            message=exc.message,
            retryable=True,
            suggestion="Repair the task lifecycle state, then call start_worker again.",
        )
