from __future__ import annotations

from pathlib import Path
from typing import Any

from ..services.task_package import (
    TASK_PACKAGE_FILES,
    get_package_state_after_writes,
    get_task_package_disk_state,
)
from ..services.tasks import log_workspace_action
from .patching import apply_patch_hunks, join_patch_lines, parse_apply_patch_text


def handle(
    runtime: Any,
    scope: str,
    patch_text: str,
    expected_sha256_map: dict[str, str] | None = None,
):
    if scope == "task" and runtime.context.current_task is None:
        return runtime._task_required_error(
            "apply_patch", "Create a task before patching files."
        )
    if not patch_text.strip():
        raise ValueError("patch_text is required for apply_patch.")
    operations = parse_apply_patch_text(patch_text)
    if scope == "linked_workspace":
        lifecycle = runtime._assert_full_task_lifecycle_for_linked_mutation(
            tool_name="apply_patch"
        )
        if lifecycle is not None:
            return lifecycle
        approval_error = runtime._require_approval_if_needed(
            scope="linked_workspace",
            argv=["__apply_patch__"],
            cwd=".",
            approval_type="linked_workspace_write",
            request_json={
                "scope": scope,
                "operation": "apply_patch",
                "paths": [item.path for item in operations],
            },
        )
        if approval_error is not None:
            return approval_error
    if scope == "task":
        for item in operations:
            reserved_error = runtime._reserved_task_folder_error(
                tool_name="apply_patch", path=item.path
            )
            if reserved_error is not None:
                return reserved_error
    return apply_patch_operations(
        runtime,
        scope=scope,
        operations=operations,
        expected_sha256_map=expected_sha256_map,
        tool_name="apply_patch",
    )


def apply_patch_operations(
    runtime: Any,
    *,
    scope: str,
    operations: list[Any],
    expected_sha256_map: dict[str, str] | None = None,
    tool_name: str = "apply_patch",
):
    base_root, workspace_id = runtime._resolve_scope_root(scope)
    plans: list[dict[str, Any]] = []

    for item in operations:
        target, _ = runtime._resolve_edit_target(
            scope, item.path, allow_missing=item.kind == "add"
        )
        if item.kind == "add":
            if target.exists():
                raise FileExistsError(f"'{item.path}' already exists.")
            plans.append(
                {
                    "path": target,
                    "relative_path": str(target.relative_to(base_root)),
                    "kind": "add",
                    "existed": False,
                    "old_text": None,
                    "new_text": join_patch_lines(item.content_lines or []),
                }
            )
            continue

        if not target.exists():
            raise FileNotFoundError(f"'{item.path}' does not exist.")
        if target.is_dir():
            raise IsADirectoryError(f"'{item.path}' is a directory.")

        source = target.read_text(encoding="utf-8", errors="replace")
        runtime._check_expected_sha256(
            target, expected_sha256_map.get(item.path) if expected_sha256_map else None
        )
        if item.kind == "delete":
            plans.append(
                {
                    "path": target,
                    "relative_path": str(target.relative_to(base_root)),
                    "kind": "delete",
                    "existed": True,
                    "old_text": source,
                    "new_text": None,
                }
            )
            continue

        plans.append(
            {
                "path": target,
                "relative_path": str(target.relative_to(base_root)),
                "kind": "update",
                "existed": True,
                "old_text": source,
                "new_text": apply_patch_hunks(source, item.hunks or []),
            }
        )

    created_files: list[str] = []
    updated_files: list[str] = []
    deleted_files: list[str] = []
    applied: list[dict[str, Any]] = []

    for plan in plans:
        if plan["new_text"] is None:
            validation_error = runtime._validate_task_package_delete(
                Path(plan["relative_path"]), tool_name=tool_name
            )
        else:
            validation_error = runtime._validate_task_package_write(
                plan["path"], plan["new_text"], tool_name=tool_name
            )
        if validation_error is not None:
            return validation_error

    if scope == "task" and runtime.context.current_task is not None:
        task_root = base_root.resolve()
        package_updates: dict[str, str | None] = {}
        for plan in plans:
            rel_path = plan["relative_path"]
            if rel_path in TASK_PACKAGE_FILES:
                package_updates[rel_path] = plan["new_text"]
        virtual = (
            get_package_state_after_writes(task_root, updates=package_updates)
            if package_updates
            else get_task_package_disk_state(task_root)
        )
        touched = [plan["relative_path"] for plan in plans]
        requires_todo = "todo.md" in touched
        requires_work = any(
            path == "work"
            or path.startswith("work/")
            or path == "outputs"
            or path.startswith("outputs/")
            for path in touched
        )
        if requires_work or requires_todo:
            if requires_work:
                lifec_err = runtime._assert_lifecycle_for_work_or_outputs(
                    virtual, tool_name=tool_name
                )
            else:
                lifec_err = runtime._assert_lifecycle_for_todo_write(
                    virtual, tool_name=tool_name
                )
            if lifec_err is not None:
                return lifec_err

    try:
        for plan in plans:
            target = plan["path"]
            new_text = plan["new_text"]
            if new_text is None:
                target.unlink()
                deleted_files.append(plan["relative_path"])
            else:
                runtime._atomic_write_text(target, new_text)
                if plan["kind"] == "add":
                    created_files.append(plan["relative_path"])
                else:
                    updated_files.append(plan["relative_path"])
            applied.append(plan)
    except Exception:
        for plan in reversed(applied):
            target = plan["path"]
            if plan["existed"]:
                runtime._atomic_write_text(target, plan["old_text"])
            elif target.exists():
                target.unlink()
        raise

    registered_outputs: list[str] = []
    if scope == "task":
        registered_outputs = runtime._sync_task_outputs_if_needed()

    touched_paths = [plan["relative_path"] for plan in plans]
    log_workspace_action(
        runtime.context.session,
        action_type=tool_name,
        workspace_scope=scope,
        task_id=runtime.context.current_task.id
        if runtime.context.current_task
        else None,
        agent_run_id=runtime.context.run.id,
        tool_execution_id=runtime.context.current_tool_execution_id,
        project_workspace_id=workspace_id,
        target_path=str(base_root),
        arguments_json={
            "operation": "apply_patch",
            "touched_paths": touched_paths,
            "created_files": created_files,
            "updated_files": updated_files,
            "deleted_files": deleted_files,
        },
    )
    result: dict[str, Any] = {
        "operation": "apply_patch",
        "touched_paths": touched_paths,
        "created_files": created_files,
        "updated_files": updated_files,
        "deleted_files": deleted_files,
    }
    if registered_outputs:
        result["registered_outputs"] = registered_outputs
    if (
        scope == "task"
        and runtime.context.current_task is not None
        and ("plan.md" in set(created_files) | set(updated_files))
    ):
        plan_path = (base_root / "plan.md").resolve()
        if plan_path.is_file():
            result = runtime._attach_plan_approval_extras(
                result, plan_path.read_text(encoding="utf-8", errors="replace")
            )
    return result
