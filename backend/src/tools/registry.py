from pathlib import Path
from typing import Any, Callable

from sqlalchemy.orm import Session

from ..db.models import AgentRun
from .runtime import ProjectToolRuntime, ToolContext


def get_tools_registry(
    db: Session,
    *,
    project_id: str,
    conversation_id: str,
    run: AgentRun,
    uploads_dir: Path,
    parent_event_sink: Callable[[dict[str, Any]], None] | None = None,
) -> ProjectToolRuntime:
    context = ToolContext(
        session=db,
        project_id=project_id,
        conversation_id=conversation_id,
        run=run,
        uploads_dir=uploads_dir,
        parent_event_sink=parent_event_sink,
    )
    context.refresh_task()
    return ProjectToolRuntime(context)
