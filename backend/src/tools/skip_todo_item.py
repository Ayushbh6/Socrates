from __future__ import annotations

from typing import Any

from ..agent.tools import build_tool_error_result
from ..services.task_package import TaskPackageValidationError, update_worker_todo_item
from .worker_todo_utils import (
    load_worker_todo,
    save_worker_todo,
    todo_update_payload,
    validation_error,
)


def handle(runtime: Any, todo_id: str, reason: str, evidence: Any | None = None):
    if not reason.strip():
        return build_tool_error_result(
            tool_name="skip_todo_item",
            error_type="todo_skip_reason_required",
            message="Skipping a todo item requires a specific audit reason.",
            retryable=True,
        )
    todo_path, state = load_worker_todo(runtime)
    target = next((item for item in state.items if item.item_id == todo_id), None)
    if target is None:
        return build_tool_error_result(
            tool_name="skip_todo_item",
            error_type="invalid_task_file_format",
            message=f"Todo item {todo_id} was not found.",
            retryable=True,
        )
    if target.status == "completed":
        return build_tool_error_result(
            tool_name="skip_todo_item",
            error_type="todo_item_not_current",
            message=f"Todo item {todo_id} is already completed and cannot be skipped.",
            retryable=False,
        )
    try:
        updated = update_worker_todo_item(
            state,
            item_id=todo_id,
            status="skipped",
            evidence=evidence,
            reason=reason,
        )
    except TaskPackageValidationError as exc:
        return validation_error("skip_todo_item", exc)
    save_worker_todo(runtime, todo_path, updated)
    item = next(item for item in updated.items if item.item_id == todo_id)
    position = next(
        index for index, candidate in enumerate(updated.items, start=1) if candidate.item_id == item.item_id
    )
    return todo_update_payload(updated, item, position=position)
