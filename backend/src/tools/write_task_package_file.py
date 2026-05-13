from __future__ import annotations

from pathlib import Path
from typing import Any

from ..agent.tools import build_tool_error_result
from ..services.tasks import log_workspace_action


def _normalize_file_choice(value: str) -> str | None:
    cleaned = value.strip().lower()
    if cleaned in {"plan", "plan.md"}:
        return "plan"
    if cleaned in {"todo", "todo.md"}:
        return "todo"
    return None


def handle(runtime: Any, file: str, content: str):
    task = runtime.context.current_task or runtime.context.refresh_task()
    if task is None:
        return runtime._task_required_error(
            "write_task_package_file",
            "Create a task before writing plan.md or todo.md.",
        )

    file_key = _normalize_file_choice(file)
    if file_key is None:
        return build_tool_error_result(
            tool_name="write_task_package_file",
            error_type="invalid_task_package_file",
            message="write_task_package_file can only write file='plan' or file='todo'. task.md is backend-owned.",
            retryable=True,
            suggestion="Call write_task_package_file with file='plan' or file='todo'.",
        )

    relative_path = "plan.md" if file_key == "plan" else "todo.md"
    task_root = Path(task.workspace_root).resolve()
    target = task_root / relative_path
    existed = target.exists()

    validation_error = runtime._validate_task_package_write(
        target,
        content,
        tool_name="write_task_package_file",
    )
    if validation_error is not None:
        return validation_error

    lifecycle = runtime._check_lifecycle_before_task_write(
        task_root=task_root,
        relative_path=relative_path,
        final_text=content,
        is_delete=False,
        tool_name="write_task_package_file",
    )
    if lifecycle is not None:
        return lifecycle

    runtime._atomic_write_text(target, content)

    result: dict[str, Any] = {
        "file": file_key,
        "path": relative_path,
        "operation": "overwrite" if existed else "create",
    }
    if relative_path == "plan.md":
        result = runtime._attach_plan_approval_extras(result, content)

    log_workspace_action(
        runtime.context.session,
        action_type="write_task_package_file",
        workspace_scope="task",
        task_id=task.id,
        agent_run_id=runtime.context.run.id,
        tool_execution_id=runtime.context.current_tool_execution_id,
        target_path=str(target),
        arguments_json={
            "file": file_key,
            "operation": result["operation"],
        },
    )
    return result
