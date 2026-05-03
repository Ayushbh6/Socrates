from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..core.schema import ToolCall
from .patching import parse_apply_patch_text

TASK_PACKAGE_FILE_NAMES = {"task.md", "plan.md", "todo.md"}


@dataclass(frozen=True)
class FileResource:
    key: str
    path: Path
    argument_path: str


@dataclass(frozen=True)
class PriorReadRequirement:
    resource: FileResource
    expected_argument: str | None = None
    expected_map_key: str | None = None


@dataclass
class ToolResourcePlan:
    tool_call: ToolCall
    read_files: list[FileResource] = field(default_factory=list)
    write_files: list[FileResource] = field(default_factory=list)
    lock_keys: set[str] = field(default_factory=set)
    prior_read_requirements: list[PriorReadRequirement] = field(default_factory=list)

    @property
    def read_keys(self) -> set[str]:
        return {item.key for item in self.read_files}

    @property
    def write_keys(self) -> set[str]:
        return {item.key for item in self.write_files}


def file_resource(path: Path, argument_path: str) -> FileResource:
    resolved = path.resolve()
    return FileResource(
        key=f"file:{resolved}",
        path=resolved,
        argument_path=argument_path,
    )


def _task_relative_path(runtime: Any, scope: str, target: Path) -> str | None:
    if scope != "task" or runtime.context.current_task is None:
        return None
    task_root = Path(runtime.context.current_task.workspace_root).resolve()
    try:
        return str(target.resolve().relative_to(task_root))
    except ValueError:
        return None


class ToolResourcePlanner:
    def __init__(self, runtime: Any):
        self.runtime = runtime

    def plan(self, tool_call: ToolCall) -> ToolResourcePlan:
        name = tool_call.name
        args = tool_call.arguments
        if name == "read_file":
            return self._plan_read_file(tool_call, args)
        if name == "edit_file":
            return self._plan_edit_file(tool_call, args)
        if name == "write_file":
            return self._plan_write_file(tool_call, args)
        if name == "apply_patch":
            return self._plan_apply_patch(tool_call, args)
        if name == "execute_command":
            return self._plan_execute_command(tool_call, args)
        if name in {"update_current_todo_item", "skip_todo_item"}:
            return self._plan_worker_todo_write(tool_call)
        if name in {"create_task", "update_task_status", "start_worker"}:
            return ToolResourcePlan(
                tool_call=tool_call,
                lock_keys={f"state:conversation:{self.runtime.context.conversation_id}:task"},
            )
        if name == "write_project_note":
            return ToolResourcePlan(
                tool_call=tool_call,
                lock_keys={f"state:run:{self.runtime.context.run.id}:project_note"},
            )
        return ToolResourcePlan(tool_call=tool_call)

    def _plan_read_file(self, tool_call: ToolCall, args: dict[str, Any]) -> ToolResourcePlan:
        scope = args.get("scope")
        path = args.get("path")
        plan = ToolResourcePlan(tool_call=tool_call)
        if scope not in {"task", "linked_workspace"} or not isinstance(path, str):
            return plan
        try:
            base_root, _ = self.runtime._resolve_scope_root(scope)
            target = self.runtime._resolve_relative_path(base_root, path, allow_missing=False)
        except Exception:
            return plan
        if target.is_file():
            plan.read_files.append(file_resource(target, path))
        return plan

    def _plan_edit_file(self, tool_call: ToolCall, args: dict[str, Any]) -> ToolResourcePlan:
        scope = args.get("scope")
        path = args.get("path")
        plan = ToolResourcePlan(tool_call=tool_call)
        if not isinstance(scope, str) or not isinstance(path, str):
            return plan
        try:
            target, _ = self.runtime._resolve_edit_target(scope, path, allow_missing=True)
        except Exception:
            return plan
        relative_path = _task_relative_path(self.runtime, scope, target)
        resource = file_resource(target, relative_path or path)
        plan.write_files.append(resource)
        plan.lock_keys.add(resource.key)
        if (relative_path or path) not in TASK_PACKAGE_FILE_NAMES and not args.get(
            "expected_sha256"
        ):
            plan.prior_read_requirements.append(
                PriorReadRequirement(resource=resource, expected_argument="expected_sha256")
            )
        return plan

    def _plan_write_file(self, tool_call: ToolCall, args: dict[str, Any]) -> ToolResourcePlan:
        scope = args.get("scope")
        path = args.get("path")
        plan = ToolResourcePlan(tool_call=tool_call)
        if not isinstance(scope, str) or not isinstance(path, str):
            return plan
        try:
            target, _ = self.runtime._resolve_edit_target(scope, path, allow_missing=True)
        except Exception:
            return plan
        relative_path = _task_relative_path(self.runtime, scope, target)
        resource = file_resource(target, relative_path or path)
        plan.write_files.append(resource)
        plan.lock_keys.add(resource.key)
        if (
            (relative_path or path) not in TASK_PACKAGE_FILE_NAMES
            and target.exists()
            and not args.get("expected_sha256")
        ):
            plan.prior_read_requirements.append(
                PriorReadRequirement(resource=resource, expected_argument="expected_sha256")
            )
        return plan

    def _plan_apply_patch(self, tool_call: ToolCall, args: dict[str, Any]) -> ToolResourcePlan:
        scope = args.get("scope")
        patch_text = args.get("patch_text")
        plan = ToolResourcePlan(tool_call=tool_call)
        if not isinstance(scope, str) or not isinstance(patch_text, str):
            return plan
        try:
            operations = parse_apply_patch_text(patch_text)
        except Exception:
            return plan
        expected_map = args.get("expected_sha256_map")
        expected_map = expected_map if isinstance(expected_map, dict) else {}
        for operation in operations:
            try:
                target, _ = self.runtime._resolve_edit_target(
                    scope, operation.path, allow_missing=operation.kind == "add"
                )
            except Exception:
                continue
            relative_path = _task_relative_path(self.runtime, scope, target)
            resource = file_resource(target, relative_path or operation.path)
            plan.write_files.append(resource)
            plan.lock_keys.add(resource.key)
            if (
                (relative_path or operation.path) not in TASK_PACKAGE_FILE_NAMES
                and operation.kind != "add"
                and not expected_map.get(operation.path)
            ):
                plan.prior_read_requirements.append(
                    PriorReadRequirement(resource=resource, expected_map_key=operation.path)
                )
        return plan

    def _plan_execute_command(self, tool_call: ToolCall, args: dict[str, Any]) -> ToolResourcePlan:
        scope = args.get("scope")
        plan = ToolResourcePlan(tool_call=tool_call)
        if not isinstance(scope, str):
            return plan
        try:
            base_root, _ = self.runtime._resolve_scope_root(scope)
        except Exception:
            return plan
        plan.lock_keys.add(f"command:{scope}:{base_root.resolve()}")
        return plan

    def _plan_worker_todo_read(self, tool_call: ToolCall) -> ToolResourcePlan:
        plan = ToolResourcePlan(tool_call=tool_call)
        if self.runtime.context.current_task is None:
            return plan
        target = Path(self.runtime.context.current_task.workspace_root).resolve() / "todo.md"
        if target.is_file():
            plan.read_files.append(file_resource(target, "todo.md"))
        return plan

    def _plan_worker_todo_write(self, tool_call: ToolCall) -> ToolResourcePlan:
        plan = ToolResourcePlan(tool_call=tool_call)
        if self.runtime.context.current_task is None:
            return plan
        target = Path(self.runtime.context.current_task.workspace_root).resolve() / "todo.md"
        resource = file_resource(target, "todo.md")
        plan.write_files.append(resource)
        plan.lock_keys.add(resource.key)
        return plan
