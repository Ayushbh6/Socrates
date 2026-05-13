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


def handle(
    runtime: Any,
    reason: str,
    evidence: Any | None = None,
    todo_id: str | None = None,
):
    if not reason.strip():
        return build_tool_error_result(
            tool_name="skip_todo_item",
            error_type="todo_skip_reason_required",
            message="Skipping a todo item requires a specific audit reason.",
            retryable=True,
        )
    todo_path, state = load_worker_todo(runtime)
    target = state.current_item
    if target is None:
        return build_tool_error_result(
            tool_name="skip_todo_item",
            error_type="todo_current_item_required",
            message="There is no current or pending todo item to skip.",
            retryable=True,
        )
    if todo_id is not None and todo_id != target.item_id:
        return build_tool_error_result(
            tool_name="skip_todo_item",
            error_type="todo_item_not_current",
            message=f"Todo item {todo_id} cannot be skipped yet. The current item is {target.item_id}.",
            retryable=True,
            suggestion="Skip only the current in-progress item, or the first pending item if none is in progress.",
        )
    try:
        updated = update_worker_todo_item(
            state,
            item_id=target.item_id,
            status="skipped",
            evidence=evidence,
            reason=reason,
        )
    except TaskPackageValidationError as exc:
        return validation_error("skip_todo_item", exc)
    save_worker_todo(runtime, todo_path, updated)
    item = next(item for item in updated.items if item.item_id == target.item_id)
    position = next(
        index for index, candidate in enumerate(updated.items, start=1) if candidate.item_id == item.item_id
    )
    return todo_update_payload(updated, item, position=position)
