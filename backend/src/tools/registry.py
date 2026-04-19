from pathlib import Path

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
    host_workspaces_dir: Path,
) -> ProjectToolRuntime:
    context = ToolContext(
        session=db,
        project_id=project_id,
        conversation_id=conversation_id,
        run=run,
        uploads_dir=uploads_dir,
        host_workspaces_dir=host_workspaces_dir,
    )
    context.refresh_task()
    return ProjectToolRuntime(context)
