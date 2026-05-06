from __future__ import annotations

from pathlib import Path
from typing import Any

from ..agent.tools import build_tool_error_result
from ..services.tasks import log_workspace_action


def handle(
    runtime: Any,
    scope: str,
    path: str,
    content: str,
    overwrite: bool = False,
    expected_sha256: str | None = None,
):
    if scope == "task" and runtime.context.current_task is None:
        return runtime._task_required_error(
            "write_file", "Create a task before writing files."
        )
    if scope == "project":
        return build_tool_error_result(
            tool_name="write_file",
            error_type="permission_denied",
            message="Project assets are read-only. Create a task or use the linked workspace for writes.",
            retryable=False,
        )
    if scope == "linked_workspace":
        lifecycle = runtime._assert_full_task_lifecycle_for_linked_mutation(
            tool_name="write_file"
        )
        if lifecycle is not None:
            return lifecycle
        approval_error = runtime._require_approval_if_needed(
            scope="linked_workspace",
            argv=["__write_file__", path],
            cwd=".",
            approval_type="linked_workspace_write",
            request_json={
                "scope": scope,
                "path": path,
                "operation": "write",
                "overwrite": overwrite,
            },
        )
        if approval_error is not None:
            return approval_error

    if scope == "task":
        reserved_error = runtime._reserved_task_folder_error(
            tool_name="write_file", path=path
        )
        if reserved_error is not None:
            return reserved_error

    target, workspace_id = runtime._resolve_edit_target(scope, path, allow_missing=True)
    existed = target.exists()
    if existed and not overwrite:
        raise FileExistsError(
            f"'{path}' already exists. Set overwrite=true to replace it."
        )
    if existed:
        runtime._check_expected_sha256(target, expected_sha256)

    validation_error = runtime._validate_task_package_write(
        target, content, tool_name="write_file"
    )
    if validation_error is not None:
        return validation_error
    if scope == "task" and runtime.context.current_task is not None:
        task_root = Path(runtime.context.current_task.workspace_root).resolve()
        rel = str(target.relative_to(task_root))
        lifecycle = runtime._check_lifecycle_before_task_write(
            task_root=task_root,
            relative_path=rel,
            final_text=content,
            is_delete=False,
            tool_name="write_file",
        )
        if lifecycle is not None:
            return lifecycle
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")

    result: dict[str, Any] = {
        "path": str(target.relative_to(runtime._resolve_scope_root(scope)[0])),
        "operation": "overwrite" if existed else "create",
    }
    if scope == "task" and runtime.context.current_task is not None:
        task_root = Path(runtime.context.current_task.workspace_root).resolve()
        rel = str(target.relative_to(task_root))
        if rel == "plan.md":
            result = runtime._attach_plan_approval_extras(
                result, target.read_text(encoding="utf-8", errors="replace")
            )
        registered_outputs = runtime._sync_task_outputs_if_needed()
        if registered_outputs:
            result["registered_outputs"] = registered_outputs

    log_workspace_action(
        runtime.context.session,
        action_type="write_file",
        workspace_scope=scope,
        task_id=runtime.context.current_task.id
        if runtime.context.current_task
        else None,
        agent_run_id=runtime.context.run.id,
        tool_execution_id=runtime.context.current_tool_execution_id,
        project_workspace_id=workspace_id,
        target_path=str(target),
        arguments_json={
            "path": path,
            "operation": result["operation"],
            "overwrite": overwrite,
        },
    )
    return result
