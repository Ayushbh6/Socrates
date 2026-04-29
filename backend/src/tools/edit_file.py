from __future__ import annotations

from pathlib import Path
from typing import Any

from ..agent.tools import build_tool_error_result
from ..services.tasks import log_workspace_action


def handle(
    runtime: Any,
    scope: str,
    path: str,
    old_text: str,
    new_text: str,
    replace_all: bool = False,
    expected_sha256: str | None = None,
):
    if scope == "task" and runtime.context.current_task is None:
        return runtime._task_required_error(
            "edit_file", "Create a task before editing files."
        )
    if scope == "project":
        return build_tool_error_result(
            tool_name="edit_file",
            error_type="permission_denied",
            message="Project assets are read-only. Create a task or use the linked workspace for edits.",
            retryable=False,
        )
    if scope == "linked_workspace":
        lifecycle = runtime._assert_full_task_lifecycle_for_linked_mutation(
            tool_name="edit_file"
        )
        if lifecycle is not None:
            return lifecycle
        approval_error = runtime._require_approval_if_needed(
            scope="linked_workspace",
            argv=["__edit_file__", path],
            cwd=".",
            approval_type="linked_workspace_write",
            request_json={"scope": scope, "path": path, "operation": "replace"},
        )
        if approval_error is not None:
            return approval_error

    target, workspace_id = runtime._resolve_edit_target(
        scope, path, allow_missing=False
    )
    runtime._check_expected_sha256(target, expected_sha256)
    source = target.read_text(encoding="utf-8", errors="replace")
    count = source.count(old_text)
    if count == 0:
        raise ValueError("old_text was not found.")
    if not replace_all and count != 1:
        raise ValueError(
            "old_text matched multiple times. Use replace_all=true or choose a more specific string."
        )
    updated = (
        source.replace(old_text, new_text)
        if replace_all
        else source.replace(old_text, new_text, 1)
    )

    validation_error = runtime._validate_task_package_write(
        target, updated, tool_name="edit_file"
    )
    if validation_error is not None:
        return validation_error
    if scope == "task" and runtime.context.current_task is not None:
        task_root = Path(runtime.context.current_task.workspace_root).resolve()
        rel = str(target.relative_to(task_root))
        lifecycle = runtime._check_lifecycle_before_task_write(
            task_root=task_root,
            relative_path=rel,
            final_text=updated,
            is_delete=False,
            tool_name="edit_file",
        )
        if lifecycle is not None:
            return lifecycle
    target.write_text(updated, encoding="utf-8")

    result: dict[str, Any] = {
        "path": str(target.relative_to(runtime._resolve_scope_root(scope)[0])),
        "operation": "replace",
    }
    if scope == "task" and runtime.context.current_task is not None:
        task_root = Path(runtime.context.current_task.workspace_root).resolve()
        rel = str(target.relative_to(task_root))
        if rel == "plan.md":
            result = runtime._attach_plan_approval_extras(
                result, target.read_text(encoding="utf-8", errors="replace")
            )
        runtime._sync_task_outputs_if_needed()

    log_workspace_action(
        runtime.context.session,
        action_type="edit_file",
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
            "operation": "replace",
            "replace_all": replace_all,
        },
    )
    return result
