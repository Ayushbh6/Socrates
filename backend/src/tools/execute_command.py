from __future__ import annotations

import shlex
import subprocess
from pathlib import Path
from typing import Any

from ..agent.tools import build_tool_error_result
from ..services.task_package import get_task_package_disk_state
from ..services.tasks import log_workspace_action


def handle(
    runtime: Any, scope: str, argv: list[str], cwd: str = ".", timeout_sec: int = 60
):
    if not argv:
        raise ValueError("argv must contain at least one argument.")
    if scope == "task" and runtime.context.current_task is None:
        return runtime._task_required_error(
            "execute_command", "Create a task before running commands."
        )
    blocked_reason = runtime._blocked_command_reason(argv)
    if blocked_reason is not None:
        return build_tool_error_result(
            tool_name="execute_command",
            error_type="command_blocked",
            message=blocked_reason,
            retryable=False,
        )

    base_root, workspace_id = runtime._resolve_scope_root(scope)
    workdir = runtime._resolve_command_cwd(scope, base_root, cwd)
    path_error = runtime._validate_command_paths(
        scope=scope, base_root=base_root, workdir=workdir, argv=argv
    )
    if path_error is not None:
        return path_error
    if scope == "task" and runtime.context.current_task is not None:
        lifecycle = runtime._assert_lifecycle_for_work_or_outputs(
            get_task_package_disk_state(
                Path(runtime.context.current_task.workspace_root).resolve()
            ),
            tool_name="execute_command",
        )
        if lifecycle is not None:
            return lifecycle
    if scope == "linked_workspace":
        lifecycle = runtime._assert_full_task_lifecycle_for_linked_mutation(
            tool_name="execute_command"
        )
        if lifecycle is not None:
            return lifecycle
    normalized_argv = runtime._normalize_python_command_argv(argv)
    if isinstance(normalized_argv, str):
        return normalized_argv
    approval_error = runtime._require_approval_if_needed(
        scope=scope, argv=argv, cwd=str(workdir.relative_to(base_root))
    )
    if approval_error is not None:
        return approval_error

    env = runtime._task_command_env() if scope == "task" else None
    result = subprocess.run(
        normalized_argv,
        cwd=workdir,
        capture_output=True,
        text=True,
        timeout=timeout_sec,
        env=env,
    )
    stdout = result.stdout[:20000]
    stderr = result.stderr[:20000]
    registered_outputs: list[str] = []
    if scope == "task":
        registered_outputs = runtime._sync_task_outputs_if_needed()
    payload = {
        "argv": argv,
        "executed_argv": normalized_argv,
        "cwd": str(workdir.relative_to(base_root)),
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": result.returncode,
        "success": result.returncode == 0,
    }
    if registered_outputs:
        payload["registered_outputs"] = registered_outputs
    reserved_violations = (
        runtime._scan_task_workspace_for_reserved_folders()
        if scope == "task"
        else []
    )
    success = result.returncode == 0 and not reserved_violations
    log_workspace_action(
        runtime.context.session,
        action_type="execute_command",
        workspace_scope=scope,
        task_id=runtime.context.current_task.id
        if runtime.context.current_task
        else None,
        agent_run_id=runtime.context.run.id,
        tool_execution_id=runtime.context.current_tool_execution_id,
        project_workspace_id=workspace_id,
        target_path=str(workdir),
        command_text=shlex.join(argv),
        arguments_json={
            "cwd": cwd,
            "timeout_sec": timeout_sec,
            "executed_argv": normalized_argv,
        },
        stdout_text=stdout,
        stderr_text=stderr,
        exit_code=result.returncode,
        success=success,
    )
    if reserved_violations:
        return runtime._reserved_task_command_error(
            command_result=payload,
            violations=reserved_violations,
        )
    return payload
