from __future__ import annotations

from pathlib import Path
from typing import Any

from ..db.models import ToolExecution
from ..services.tasks import (
    create_note_asset,
    get_project_notes_dir,
    log_workspace_action,
)


def handle(runtime: Any, path_or_title: str, content: str):
    lines = [line for line in content.splitlines() if line.strip() or line == ""]
    if len(lines) > 10:
        return runtime._task_required_error(
            "write_project_note",
            "This note is larger than the chat-mode note limit. Create a task first.",
        )
    prior_writes = (
        runtime.context.session.query(ToolExecution)
        .filter(
            ToolExecution.agent_run_id == runtime.context.run.id,
            ToolExecution.tool_name == "write_project_note",
            ToolExecution.id != runtime.context.current_tool_execution_id,
        )
        .count()
    )
    if prior_writes >= 1:
        return runtime._task_required_error(
            "write_project_note",
            "Only one small note write is allowed in chat mode per run. Create a task first.",
        )
    asset = create_note_asset(
        runtime.context.session,
        project_id=runtime.context.project_id,
        title=Path(path_or_title).stem or "project-note",
        content=content,
        created_by_task_id=runtime.context.current_task.id
        if runtime.context.current_task
        else None,
    )
    log_workspace_action(
        runtime.context.session,
        action_type="write_project_note",
        workspace_scope="managed_task"
        if runtime.context.current_task
        else "managed_project",
        task_id=runtime.context.current_task.id
        if runtime.context.current_task
        else None,
        agent_run_id=runtime.context.run.id,
        tool_execution_id=runtime.context.current_tool_execution_id,
        target_path=str(
            get_project_notes_dir(runtime.context.project_id) / asset.original_name
        ),
    )
    return {"asset_id": asset.id, "filename": asset.original_name}
