from __future__ import annotations

from pathlib import Path
from typing import Any

from ..agent.tools import build_tool_error_result
from ..services.task_package import (
    TaskPackageValidationError,
    WorkerTodoItem,
    parse_worker_todo_state,
    render_worker_todo_state,
)


def load_worker_todo(runtime: Any):
    task = runtime._require_task()
    todo_path = Path(task.workspace_root).resolve() / "todo.md"
    if not todo_path.is_file():
        raise FileNotFoundError("todo.md does not exist.")
    return todo_path, parse_worker_todo_state(
        todo_path.read_text(encoding="utf-8", errors="replace")
    )


def save_worker_todo(runtime: Any, todo_path: Path, state: Any) -> None:
    todo_path.write_text(render_worker_todo_state(state), encoding="utf-8")
    runtime._sync_task_outputs_if_needed()


def todo_item_payload(item: WorkerTodoItem, *, position: int) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": item.item_id,
        "status": item.status,
        "text": item.text,
        "position": position,
    }
    if item.evidence:
        payload["evidence"] = item.evidence
    if item.reason:
        payload["reason"] = item.reason
    if item.recommended_action:
        payload["recommended_action"] = item.recommended_action
    return payload


def next_todo_payload(state: Any, *, exclude_id: str | None = None) -> dict[str, Any] | None:
    for index, item in enumerate(state.items, start=1):
        if item.item_id == exclude_id:
            continue
        if item.status == "pending":
            return todo_item_payload(item, position=index)
    return None


def todo_update_payload(state: Any, item: WorkerTodoItem, *, position: int) -> dict[str, Any]:
    next_item = next_todo_payload(state, exclude_id=item.item_id)
    return {
        "item": todo_item_payload(item, position=position),
        "next_item": next_item,
        "done": state.done,
        "progress": state.progress_counts(),
    }


def validation_error(tool_name: str, exc: TaskPackageValidationError) -> str:
    return build_tool_error_result(
        tool_name=tool_name,
        error_type=exc.error_type,
        message=exc.message,
        retryable=True,
        suggestion="Use the worker todo tools to repair the current todo state, or return blocked if the plan needs Socrates revision.",
    )
