from __future__ import annotations

from typing import Any

from ..db.models import MessageRecord
from ..services.task_package import task_package_contract
from ..services.tasks import (
    create_task,
    ensure_task_input_assets,
    select_default_project_workspace,
    serialize_task,
)


def handle(runtime: Any, title: str, goal: str, success_criteria: str | None = None):
    workspace = select_default_project_workspace(
        runtime.context.session, runtime.context.project_id
    )
    task = create_task(
        runtime.context.session,
        project_id=runtime.context.project_id,
        conversation_id=runtime.context.conversation_id,
        title=title,
        goal_text=goal,
        success_criteria_text=success_criteria,
        created_from_agent_run_id=runtime.context.run.id,
        project_workspace_id=workspace.id if workspace else None,
    )
    runtime.context.current_task = task
    runtime.context.run.task_id = task.id
    runtime.context.run.execution_mode = "task"
    task.last_agent_run_id = runtime.context.run.id
    if runtime.context.run.trigger_message_id:
        trigger_message = runtime.context.session.get(
            MessageRecord, runtime.context.run.trigger_message_id
        )
        if trigger_message is not None:
            trigger_message.task_id = task.id
            trigger_message.execution_mode = "task"
            trigger_assets = [
                link.asset
                for link in trigger_message.asset_links
                if link.asset.deleted_at is None
            ]
            ensure_task_input_assets(
                runtime.context.session, task=task, assets=trigger_assets
            )
    runtime.context.session.commit()
    contract = task_package_contract()
    return {
        "task": serialize_task(task, session=runtime.context.session),
        "task_package_contract": contract,
        "next_step": contract["next_step"],
    }
