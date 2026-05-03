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
    status: str,
    evidence: Any | None = None,
    reason: str | None = None,
    recommended_action: str | None = None,
):
    if status not in {"in_progress", "completed", "blocked"}:
        return build_tool_error_result(
            tool_name="update_current_todo_item",
            error_type="validation_error",
            message="status must be one of: in_progress, completed, blocked.",
            retryable=True,
        )
    todo_path, state = load_worker_todo(runtime)
    if status == "in_progress":
        current = state.current_item
    else:
        current = state.in_progress_items[0] if state.in_progress_items else None
    if current is None:
        return build_tool_error_result(
            tool_name="update_current_todo_item",
            error_type="todo_current_item_required",
            message="There is no current pending or in-progress todo item to update.",
            retryable=True,
            suggestion="Call update_current_todo_item(status='in_progress') to claim the next pending item, or finish only when done=true has been returned.",
        )
    if status == "blocked" and not (recommended_action or "").strip():
        return build_tool_error_result(
            tool_name="update_current_todo_item",
            error_type="todo_block_recommended_action_required",
            message="Blocking a todo item requires a recommended Socrates action.",
            retryable=True,
            suggestion="Call update_current_todo_item with status='blocked', a concrete reason, and recommended_action.",
        )
    try:
        updated = update_worker_todo_item(
            state,
            item_id=current.item_id,
            status=status,  # type: ignore[arg-type]
            evidence=evidence,
            reason=reason,
            recommended_action=recommended_action,
        )
    except TaskPackageValidationError as exc:
        return validation_error("update_current_todo_item", exc)
    save_worker_todo(runtime, todo_path, updated)
    item = next(item for item in updated.items if item.item_id == current.item_id)
    position = next(
        index for index, candidate in enumerate(updated.items, start=1) if candidate.item_id == item.item_id
    )
    return todo_update_payload(updated, item, position=position)
