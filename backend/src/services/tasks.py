from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.settings import get_settings
from ..db.models import Asset, Conversation, Project, ProjectWorkspace, Task, TaskApproval, TaskArtifact, WorkspaceAction
from .assets import create_project_asset, resolve_asset_bytes
from .bootstrap import get_current_user
from .projects import get_conversation, get_project


ACTIVE_TASK_STATUSES = {"active", "awaiting_approval"}
TASK_SUBDIRS = ("inputs", "work", "outputs", "logs")


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _path_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _task_brief_markdown(*, title: str, goal: str, success_criteria: str | None) -> str:
    criteria = success_criteria.strip() if success_criteria else "Complete the task safely and summarize the result."
    return "\n".join(
        [
            f"# {title.strip()}",
            "",
            "## Goal",
            goal.strip(),
            "",
            "## Success Criteria",
            criteria,
        ]
    ).strip()


def get_project_root(project_id: str) -> Path:
    return get_settings().projects_dir / project_id


def get_project_notes_dir(project_id: str) -> Path:
    return get_project_root(project_id) / "notes"


def get_project_venv_path(project_id: str) -> Path:
    return get_project_root(project_id) / ".venv"


def get_task_root(project_id: str, task_id: str) -> Path:
    return get_project_root(project_id) / "tasks" / task_id


def ensure_project_directories(project_id: str) -> Path:
    project_root = get_project_root(project_id)
    (project_root / "tasks").mkdir(parents=True, exist_ok=True)
    get_project_notes_dir(project_id).mkdir(parents=True, exist_ok=True)
    return project_root


def ensure_project_venv(project_id: str) -> Path:
    ensure_project_directories(project_id)
    
    sandbox_path = Path("/opt/agent-venv")
    if (sandbox_path / "pyvenv.cfg").exists():
        return sandbox_path
        
    venv_path = get_project_venv_path(project_id)
    if not (venv_path / "pyvenv.cfg").exists():
        subprocess.run([sys.executable, "-m", "venv", str(venv_path)], check=True, capture_output=True, text=True)
    return venv_path


def list_project_workspaces(session: Session, project_id: str) -> list[ProjectWorkspace]:
    get_project(session, project_id)
    return list(
        session.execute(
            select(ProjectWorkspace)
            .where(ProjectWorkspace.project_id == project_id)
            .order_by(ProjectWorkspace.is_primary.desc(), ProjectWorkspace.created_at.asc())
        ).scalars()
    )


def _workspace_slug(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", label.strip().lower()).strip("-")
    return slug or "workspace"


def _resolve_host_workspace_path(relative_path: str) -> Path:
    host_root = get_settings().host_workspaces_dir.resolve()
    normalized = Path(relative_path.strip())
    if normalized.is_absolute():
        return normalized.resolve()
    resolved = (host_root / normalized).resolve()
    if not _path_within(host_root, resolved):
        raise ValueError("Workspace path escapes the configured host workspaces root.")
    return resolved


def select_default_project_workspace(session: Session, project_id: str) -> ProjectWorkspace | None:
    workspaces = [
        workspace
        for workspace in list_project_workspaces(session, project_id)
        if workspace.access_granted and workspace.access_revoked_at is None
    ]
    if not workspaces:
        return None
    primary = next((workspace for workspace in workspaces if workspace.is_primary), None)
    return primary or workspaces[0]


def get_project_workspace(session: Session, workspace_id: str) -> ProjectWorkspace:
    workspace = session.get(ProjectWorkspace, workspace_id)
    if workspace is None:
        raise LookupError("Project workspace not found.")
    return workspace


def create_project_workspace(
    session: Session,
    *,
    project_id: str,
    label: str,
    relative_path: str | None = None,
    editor_type: str = "vscode",
    is_primary: bool = False,
    access_granted: bool = True,
) -> ProjectWorkspace:
    get_project(session, project_id)
    cleaned_label = label.strip()
    if not cleaned_label:
        raise ValueError("Workspace label is required.")
    resolved_relative_path = (relative_path or _workspace_slug(cleaned_label)).strip().strip("/")
    if not resolved_relative_path:
        raise ValueError("Workspace folder name is required.")
    root_path = _resolve_host_workspace_path(resolved_relative_path)
    root_path.mkdir(parents=True, exist_ok=True)

    existing = (
        session.execute(
            select(ProjectWorkspace).where(
                ProjectWorkspace.project_id == project_id,
                ProjectWorkspace.root_path == str(root_path),
            )
        )
        .scalars()
        .first()
    )
    if existing is not None:
        raise ValueError("A linked workspace already exists for that folder.")

    if is_primary:
        for workspace in list_project_workspaces(session, project_id):
            workspace.is_primary = False

    granted_at = _utc_now() if access_granted else None
    revoked_at = None if access_granted else _utc_now()
    workspace = ProjectWorkspace(
        project_id=project_id,
        label=cleaned_label,
        root_path=str(root_path),
        editor_type=editor_type.strip() or "vscode",
        is_primary=is_primary,
        access_granted=access_granted,
        access_granted_at=granted_at,
        access_revoked_at=revoked_at,
    )
    session.add(workspace)
    session.commit()
    session.refresh(workspace)
    return workspace


def update_project_workspace(
    session: Session,
    *,
    project_id: str,
    workspace_id: str,
    label: str | None = None,
    editor_type: str | None = None,
    is_primary: bool | None = None,
    access_granted: bool | None = None,
) -> ProjectWorkspace:
    get_project(session, project_id)
    workspace = get_project_workspace(session, workspace_id)
    if workspace.project_id != project_id:
        raise LookupError("Project workspace not found.")

    if label is not None:
        cleaned_label = label.strip()
        if not cleaned_label:
            raise ValueError("Workspace label is required.")
        workspace.label = cleaned_label
    if editor_type is not None:
        workspace.editor_type = editor_type.strip() or "vscode"
    if is_primary is not None:
        if is_primary:
            for sibling in list_project_workspaces(session, project_id):
                sibling.is_primary = sibling.id == workspace.id
        else:
            workspace.is_primary = False
    if access_granted is not None:
        workspace.access_granted = access_granted
        if access_granted:
            workspace.access_granted_at = workspace.access_granted_at or _utc_now()
            workspace.access_revoked_at = None
        else:
            workspace.access_revoked_at = _utc_now()
    workspace.updated_at = _utc_now()
    session.commit()
    session.refresh(workspace)
    return workspace


def get_task(session: Session, task_id: str) -> Task:
    task = session.get(Task, task_id)
    if task is None:
        raise LookupError("Task not found.")
    return task


def list_conversation_tasks(session: Session, conversation_id: str) -> list[Task]:
    conversation = get_conversation(session, conversation_id)
    return list(
        session.execute(
            select(Task)
            .where(Task.conversation_id == conversation.id)
            .order_by(Task.created_at.desc())
        ).scalars()
    )


def get_active_task_for_conversation(session: Session, conversation_id: str) -> Task | None:
    conversation = get_conversation(session, conversation_id)
    return (
        session.execute(
            select(Task)
            .where(Task.conversation_id == conversation.id, Task.status.in_(ACTIVE_TASK_STATUSES))
            .order_by(Task.created_at.desc())
        )
        .scalars()
        .first()
    )


def create_task(
    session: Session,
    *,
    project_id: str,
    conversation_id: str,
    title: str,
    goal_text: str,
    success_criteria_text: str | None,
    created_from_agent_run_id: str | None,
    project_workspace_id: str | None = None,
) -> Task:
    get_project(session, project_id)
    get_conversation(session, conversation_id)

    existing = get_active_task_for_conversation(session, conversation_id)
    if existing is not None:
        return existing

    ensure_project_directories(project_id)
    venv_path = ensure_project_venv(project_id)

    workspace = None
    if project_workspace_id:
        workspace = get_project_workspace(session, project_workspace_id)
        if workspace.project_id != project_id:
            raise ValueError("Workspace does not belong to this project.")

    task = Task(
        project_id=project_id,
        conversation_id=conversation_id,
        project_workspace_id=workspace.id if workspace else None,
        created_from_agent_run_id=created_from_agent_run_id,
        last_agent_run_id=created_from_agent_run_id,
        status="active",
        title=title.strip(),
        goal_text=goal_text.strip(),
        success_criteria_text=success_criteria_text.strip() if success_criteria_text else None,
        brief_markdown=_task_brief_markdown(title=title, goal=goal_text, success_criteria=success_criteria_text),
        workspace_root="",
        venv_path=str(venv_path),
        result_summary=None,
    )
    session.add(task)
    session.flush()

    task_root = get_task_root(project_id, task.id)
    for subdir in TASK_SUBDIRS:
        (task_root / subdir).mkdir(parents=True, exist_ok=True)
    (task_root / "task.md").write_text(task.brief_markdown + "\n", encoding="utf-8")

    task.workspace_root = str(task_root)
    session.commit()
    session.refresh(task)
    return task


def update_task_status(session: Session, task_id: str, *, status: str, result_summary: str | None = None) -> Task:
    task = get_task(session, task_id)
    task.status = status
    task.updated_at = _utc_now()
    if result_summary is not None:
        task.result_summary = result_summary
    if status == "completed":
        task.completed_at = _utc_now()
    if status == "failed":
        task.failed_at = _utc_now()
    session.commit()
    session.refresh(task)
    return task


def list_task_artifacts(session: Session, task_id: str) -> list[TaskArtifact]:
    get_task(session, task_id)
    return list(
        session.execute(
            select(TaskArtifact)
            .where(TaskArtifact.task_id == task_id)
            .order_by(TaskArtifact.created_at.asc())
        ).scalars()
    )


def list_task_approvals(session: Session, task_id: str) -> list[TaskApproval]:
    get_task(session, task_id)
    return list(
        session.execute(
            select(TaskApproval)
            .where(TaskApproval.task_id == task_id)
            .order_by(TaskApproval.created_at.desc())
        ).scalars()
    )


def add_task_artifact(
    session: Session,
    *,
    task: Task,
    relative_path: str,
    artifact_role: str,
    display_name: str,
    mime_type: str | None,
    path: Path,
    asset_id: str | None = None,
    promoted_to_asset: bool = False,
    metadata_json: dict[str, Any] | None = None,
) -> TaskArtifact:
    existing = (
        session.execute(
            select(TaskArtifact).where(
                TaskArtifact.task_id == task.id,
                TaskArtifact.relative_path == relative_path,
            )
        )
        .scalars()
        .first()
    )
    size_bytes = path.stat().st_size if path.exists() and path.is_file() else None
    sha256 = _sha256_bytes(path.read_bytes()) if size_bytes is not None else None
    artifact = existing or TaskArtifact(task_id=task.id, relative_path=relative_path)
    artifact.asset_id = asset_id
    artifact.artifact_role = artifact_role
    artifact.display_name = display_name
    artifact.mime_type = mime_type
    artifact.size_bytes = size_bytes
    artifact.sha256 = sha256
    artifact.promoted_to_asset = promoted_to_asset
    artifact.metadata_json = metadata_json or {}
    if existing is None:
        session.add(artifact)
    session.commit()
    session.refresh(artifact)
    return artifact


def promote_task_file_to_asset(
    session: Session,
    *,
    task: Task,
    relative_path: str,
    display_name: str,
    mime_type: str,
    source_type: str = "generated",
) -> Asset:
    task_root = Path(task.workspace_root)
    target = (task_root / relative_path).resolve()
    if not str(target).startswith(str(task_root.resolve())) or not target.is_file():
        raise FileNotFoundError("Task output file not found.")
    return create_project_asset(
        session,
        project_id=task.project_id,
        original_name=display_name,
        mime_type=mime_type,
        content=target.read_bytes(),
        source_type=source_type,
        created_by_task_id=task.id,
    )


def create_task_approval(
    session: Session,
    *,
    task_id: str,
    agent_run_id: str | None,
    tool_execution_id: str | None,
    approval_type: str,
    request_json: dict[str, Any],
) -> TaskApproval:
    task = get_task(session, task_id)
    request_signature = json.dumps(request_json, sort_keys=True)
    existing = (
        session.execute(
            select(TaskApproval)
            .where(
                TaskApproval.task_id == task_id,
                TaskApproval.approval_type == approval_type,
                TaskApproval.status.in_(("pending", "approved")),
            )
            .order_by(TaskApproval.created_at.desc())
        )
        .scalars()
        .first()
    )
    if existing is not None and json.dumps(existing.request_json, sort_keys=True) == request_signature:
        return existing

    approval = TaskApproval(
        task_id=task.id,
        agent_run_id=agent_run_id,
        tool_execution_id=tool_execution_id,
        approval_type=approval_type,
        status="pending",
        request_json=request_json,
        decision_json={},
        requested_at=_utc_now(),
    )
    session.add(approval)
    task.status = "awaiting_approval"
    task.updated_at = _utc_now()
    session.commit()
    session.refresh(approval)
    return approval


def resolve_task_approval(
    session: Session,
    *,
    approval_id: str,
    approved: bool,
    actor: str = "user",
    note: str | None = None,
) -> TaskApproval:
    approval = session.get(TaskApproval, approval_id)
    if approval is None:
        raise LookupError("Task approval not found.")
    approval.status = "approved" if approved else "denied"
    approval.resolved_at = _utc_now()
    approval.decision_json = {"actor": actor, "approved": approved, "note": note}
    task = get_task(session, approval.task_id)
    task.status = "active"
    task.updated_at = _utc_now()
    session.commit()
    session.refresh(approval)
    return approval


def find_matching_approval(
    session: Session,
    *,
    task_id: str,
    approval_type: str,
    request_json: dict[str, Any],
) -> TaskApproval | None:
    approvals = list(
        session.execute(
            select(TaskApproval)
            .where(TaskApproval.task_id == task_id, TaskApproval.approval_type == approval_type)
            .order_by(TaskApproval.created_at.desc())
        ).scalars()
    )
    signature = json.dumps(request_json, sort_keys=True)
    for approval in approvals:
        if json.dumps(approval.request_json, sort_keys=True) == signature:
            return approval
    return None


def stage_asset_into_task(
    session: Session,
    *,
    task: Task,
    asset: Asset,
    target_relative_path: str,
) -> Path:
    task_root = Path(task.workspace_root)
    target = (task_root / target_relative_path).resolve()
    if not _path_within(task_root.resolve(), target):
        raise ValueError("Target path escapes the task workspace.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(resolve_asset_bytes(asset))
    add_task_artifact(
        session,
        task=task,
        relative_path=str(target.relative_to(task_root)),
        artifact_role="input",
        display_name=asset.original_name,
        mime_type=asset.mime_type,
        path=target,
        metadata_json={"source_asset_id": asset.id},
    )
    return target


def ensure_task_input_assets(
    session: Session,
    *,
    task: Task,
    assets: list[Asset],
) -> list[Path]:
    task_root = Path(task.workspace_root)
    input_root = (task_root / "inputs").resolve()
    staged_paths: list[Path] = []

    for asset in assets:
        existing = (
            session.execute(
                select(TaskArtifact).where(
                    TaskArtifact.task_id == task.id,
                    TaskArtifact.artifact_role == "input",
                )
            )
            .scalars()
            .all()
        )
        duplicate = next(
            (
                artifact
                for artifact in existing
                if artifact.metadata_json.get("source_asset_id") == asset.id
            ),
            None,
        )
        if duplicate is not None:
            staged_paths.append(task_root / duplicate.relative_path)
            continue

        candidate_name = asset.original_name
        target = input_root / candidate_name
        if target.exists():
            stem = Path(asset.original_name).stem
            suffix = Path(asset.original_name).suffix
            candidate_name = f"{stem}-{asset.id[:8]}{suffix}"
            target = input_root / candidate_name
        target.write_bytes(resolve_asset_bytes(asset))
        add_task_artifact(
            session,
            task=task,
            relative_path=str(target.relative_to(task_root)),
            artifact_role="input",
            display_name=asset.original_name,
            mime_type=asset.mime_type,
            path=target,
            metadata_json={"source_asset_id": asset.id},
        )
        staged_paths.append(target)

    return staged_paths


def sync_task_output_artifacts(session: Session, *, task: Task) -> list[TaskArtifact]:
    task_root = Path(task.workspace_root)
    output_root = (task_root / "outputs").resolve()
    if not output_root.exists():
        return []

    artifacts: list[TaskArtifact] = []
    for path in sorted(output_root.rglob("*")):
        if not path.is_file():
            continue
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        artifact = add_task_artifact(
            session,
            task=task,
            relative_path=str(path.relative_to(task_root)),
            artifact_role="output",
            display_name=path.name,
            mime_type=mime_type,
            path=path,
            metadata_json={"managed_output": True},
        )
        artifacts.append(artifact)
    return artifacts


def export_task_artifact_to_asset(session: Session, *, artifact_id: str) -> TaskArtifact:
    artifact = session.get(TaskArtifact, artifact_id)
    if artifact is None:
        raise LookupError("Task artifact not found.")
    task = get_task(session, artifact.task_id)
    if artifact.asset_id:
        return artifact
    mime_type = artifact.mime_type or "application/octet-stream"
    asset = promote_task_file_to_asset(
        session,
        task=task,
        relative_path=artifact.relative_path,
        display_name=artifact.display_name,
        mime_type=mime_type,
    )
    artifact.asset_id = asset.id
    artifact.promoted_to_asset = True
    session.commit()
    session.refresh(artifact)
    return artifact


def delete_task_workspace(task: Task) -> None:
    shutil.rmtree(task.workspace_root, ignore_errors=True)


def serialize_task(task: Task) -> dict[str, Any]:
    return {
        "id": task.id,
        "project_id": task.project_id,
        "conversation_id": task.conversation_id,
        "project_workspace_id": task.project_workspace_id,
        "created_from_agent_run_id": task.created_from_agent_run_id,
        "last_agent_run_id": task.last_agent_run_id,
        "status": task.status,
        "title": task.title,
        "goal_text": task.goal_text,
        "success_criteria_text": task.success_criteria_text,
        "brief_markdown": task.brief_markdown,
        "workspace_root": task.workspace_root,
        "venv_path": task.venv_path,
        "result_summary": task.result_summary,
        "created_at": task.created_at.isoformat(),
        "updated_at": task.updated_at.isoformat(),
        "completed_at": task.completed_at.isoformat() if task.completed_at else None,
        "failed_at": task.failed_at.isoformat() if task.failed_at else None,
    }


def serialize_task_approval(approval: TaskApproval) -> dict[str, Any]:
    return {
        "id": approval.id,
        "task_id": approval.task_id,
        "agent_run_id": approval.agent_run_id,
        "tool_execution_id": approval.tool_execution_id,
        "approval_type": approval.approval_type,
        "status": approval.status,
        "request_json": approval.request_json,
        "decision_json": approval.decision_json,
        "requested_at": approval.requested_at.isoformat() if approval.requested_at else None,
        "resolved_at": approval.resolved_at.isoformat() if approval.resolved_at else None,
        "created_at": approval.created_at.isoformat(),
    }


def serialize_task_artifact(artifact: TaskArtifact) -> dict[str, Any]:
    return {
        "id": artifact.id,
        "task_id": artifact.task_id,
        "asset_id": artifact.asset_id,
        "relative_path": artifact.relative_path,
        "artifact_role": artifact.artifact_role,
        "display_name": artifact.display_name,
        "mime_type": artifact.mime_type,
        "size_bytes": artifact.size_bytes,
        "sha256": artifact.sha256,
        "promoted_to_asset": artifact.promoted_to_asset,
        "metadata": artifact.metadata_json,
        "created_at": artifact.created_at.isoformat(),
    }


def create_note_asset(
    session: Session,
    *,
    project_id: str,
    title: str,
    content: str,
    created_by_task_id: str | None,
) -> Asset:
    notes_dir = get_project_notes_dir(project_id)
    notes_dir.mkdir(parents=True, exist_ok=True)
    note_path = notes_dir / f"{title.strip().replace(' ', '_')}.md"
    with note_path.open("a", encoding="utf-8") as handle:
        if note_path.stat().st_size:
            handle.write("\n")
        handle.write(content.rstrip() + "\n")
    return create_project_asset(
        session,
        project_id=project_id,
        original_name=note_path.name,
        mime_type="text/markdown",
        content=note_path.read_bytes(),
        source_type="generated",
        created_by_task_id=created_by_task_id,
    )


def log_workspace_action(
    session: Session,
    *,
    action_type: str,
    workspace_scope: str,
    task_id: str | None,
    agent_run_id: str | None,
    tool_execution_id: str | None,
    project_workspace_id: str | None = None,
    target_path: str | None = None,
    command_text: str | None = None,
    arguments_json: dict[str, Any] | None = None,
    stdout_text: str | None = None,
    stderr_text: str | None = None,
    exit_code: int | None = None,
    success: bool = True,
) -> WorkspaceAction:
    action = WorkspaceAction(
        project_workspace_id=project_workspace_id,
        agent_run_id=agent_run_id,
        tool_execution_id=tool_execution_id,
        task_id=task_id,
        workspace_scope=workspace_scope,
        action_type=action_type,
        target_path=target_path,
        command_text=command_text,
        arguments_json=arguments_json or {},
        stdout_text=stdout_text,
        stderr_text=stderr_text,
        exit_code=exit_code,
        success=success,
        started_at=_utc_now(),
        completed_at=_utc_now(),
    )
    session.add(action)
    session.commit()
    session.refresh(action)
    return action
