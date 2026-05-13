from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from sqlalchemy.orm import Session

from ..agent.tools import build_tool_error_result
from ..core.schema import ToolCall
from ..db.models import AgentRun
from .definitions import build_worker_tool_definitions
from .patching import parse_apply_patch_text
from . import skip_todo_item as skip_todo_item_tool
from . import update_current_todo_item as update_current_todo_item_tool


SUPERVISOR_ONLY_TOOLS = {"create_task", "update_task_status", "write_project_note", "start_worker"}
WORKER_ONLY_TOOLS = {"update_current_todo_item", "skip_todo_item"}


class WorkerToolRuntime:
    def __init__(self, base_runtime: Any):
        self.base_runtime = base_runtime
        self.context = base_runtime.context
        self.definitions = build_worker_tool_definitions(
            command_execution_enabled=base_runtime._command_execution_enabled
        )
        allowed = {tool.name for tool in self.definitions}
        base_handlers = getattr(base_runtime, "_all_handlers", base_runtime.handlers)
        self.handlers: dict[str, Callable[..., Any]] = {
            name: handler
            for name, handler in base_handlers.items()
            if name in allowed
        }
        self.handlers["update_current_todo_item"] = (
            lambda **kwargs: update_current_todo_item_tool.handle(base_runtime, **kwargs)
        )
        self.handlers["skip_todo_item"] = (
            lambda **kwargs: skip_todo_item_tool.handle(base_runtime, **kwargs)
        )
        for tool_name in SUPERVISOR_ONLY_TOOLS:
            self.handlers[tool_name] = self._supervisor_only_handler(tool_name)
        self.base_runtime.handlers = self.handlers
        self.base_runtime.definitions = self.definitions

    def execute(self, tool_call: ToolCall) -> Any:
        if mutation_error := self._blocked_worker_mutation(tool_call):
            return mutation_error
        return self.base_runtime.execute(tool_call)

    @staticmethod
    def _supervisor_only_handler(tool_name: str) -> Callable[..., Any]:
        def _handler(**_kwargs):
            return build_tool_error_result(
                tool_name=tool_name,
                error_type="permission_denied",
                message=f"'{tool_name}' is a supervisor-only tool and is not available to the worker.",
                retryable=False,
            )

        return _handler

    def _blocked_worker_mutation(self, tool_call: ToolCall) -> str | None:
        if tool_call.name in WORKER_ONLY_TOOLS:
            return None
        scope = tool_call.arguments.get("scope")
        if scope != "task":
            return None
        if tool_call.name in {"edit_file", "write_file"}:
            path = tool_call.arguments.get("path")
            paths = [path] if isinstance(path, str) else []
        elif tool_call.name == "apply_patch":
            patch_text = tool_call.arguments.get("patch_text")
            if not isinstance(patch_text, str):
                paths = []
            else:
                try:
                    paths = [operation.path for operation in parse_apply_patch_text(patch_text)]
                except Exception:
                    paths = []
        else:
            paths = []
        for path in paths:
            if self._is_read_only_task_package_path(path):
                return build_tool_error_result(
                    tool_name=tool_call.name,
                    error_type="permission_denied",
                    message="Workers may read task.md, plan.md, and todo.md but may not mutate them through generic file tools.",
                    retryable=False,
                )
        return None

    def _is_read_only_task_package_path(self, path: str) -> bool:
        task = self.context.current_task or self.context.refresh_task()
        if task is None:
            return False
        task_root = Path(task.workspace_root).resolve()
        try:
            target = self.base_runtime._resolve_relative_path(
                task_root, path, allow_missing=True
            )
            relative = str(target.resolve().relative_to(task_root))
        except Exception:
            return False
        return relative in {"task.md", "plan.md", "todo.md"}


def get_worker_tools_registry(
    db: Session,
    *,
    project_id: str,
    conversation_id: str,
    run: AgentRun,
    uploads_dir: Path,
    parent_event_sink: Callable[[dict[str, Any]], None] | None = None,
) -> WorkerToolRuntime:
    from .registry import get_tools_registry

    base_runtime = get_tools_registry(
        db,
        project_id=project_id,
        conversation_id=conversation_id,
        run=run,
        uploads_dir=uploads_dir,
        parent_event_sink=parent_event_sink,
    )
    return WorkerToolRuntime(base_runtime)
