from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.settings import get_settings
from ..db.models import (
    AgentEventRecord,
    AgentRun,
    Asset,
    Conversation,
    Project,
    ProjectWorkspace,
    Task,
    TaskApproval,
    TaskArtifact,
    WorkspaceAction,
)
from .assets import create_project_asset, resolve_asset_bytes
from .bootstrap import get_current_user
from .python_runtime import ensure_managed_python_runtime
from .projects import get_conversation, get_project
from .task_package import (
    TaskPackageValidationError,
    get_task_package_disk_state,
    parse_todo_checklist,
    parse_worker_todo_state,
    render_task_markdown,
)


ACTIVE_TASK_STATUSES = {"active", "awaiting_approval"}
TERMINAL_TASK_STATUSES = {"completed", "failed"}
PLAN_APPROVAL_TYPE = "plan_approval"
TASK_COMPLETION_APPROVAL_TYPE = "task_completion"
TASK_SUBDIRS = ("inputs", "work", "outputs", "logs")
VISIBLE_TASK_WORKSPACE_DIRS = ("inputs", "work", "outputs")
RECOVERABLE_RUN_STATUSES = {"cancelled", "stalled"}
WORKER_BLOCKED_EVENT_TYPE = "task.worker.blocked"
TEXT_PREVIEW_EXTENSIONS = {
    ".css",
    ".csv",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".md",
    ".py",
    ".rs",
    ".sh",
    ".sql",
    ".svg",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".xml",
    ".yaml",
    ".yml",
}
MAX_TEXT_PREVIEW_BYTES = 200_000
MAX_BINARY_DATA_URL_BYTES = 4_000_000


RECOVERY_ACTIONS: dict[str, dict[str, str]] = {
    "retry_remaining_work": {
        "label": "Retry remaining work",
        "description": "Ask Socrates to review the current task state and retry the remaining todo work.",
    },
    "revise_plan": {
        "label": "Revise plan",
        "description": "Ask Socrates to revise the plan or todo before continuing.",
    },
    "accept_partial_output": {
        "label": "Accept partial output",
        "description": "Ask Socrates to verify the partial output and request completion approval if it is acceptable.",
    },
    "close_task_failed": {
        "label": "Close task as failed",
        "description": "Ask Socrates to close the task with a clear reason if the work should stop here.",
    },
    "start_separate_task": {
        "label": "Start separate task",
        "description": "Keep this task visible while starting a separate task for the new request.",
    },
}


class TaskClosureValidationError(ValueError):
    def __init__(self, *, error_type: str, message: str, suggestion: str, retryable: bool = True):
        super().__init__(message)
        self.error_type = error_type
        self.message = message
        self.suggestion = suggestion
        self.retryable = retryable


class TaskWorkspaceFileError(ValueError):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


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


def _normalize_task_workspace_path(path: str) -> Path:
    cleaned = path.strip().lstrip("/")
    if not cleaned:
        raise TaskWorkspaceFileError("Task workspace path is required.")
    relative = Path(cleaned)
    if relative.is_absolute() or ".." in relative.parts:
        raise TaskWorkspaceFileError("Task workspace path escapes the allowed workspace.")
    if relative.parts[0] not in VISIBLE_TASK_WORKSPACE_DIRS:
        raise TaskWorkspaceFileError("Only inputs/, work/, and outputs/ are visible in the task workspace panel.")
    return relative


def _task_workspace_file(task: Task, path: str) -> tuple[Path, str]:
    relative = _normalize_task_workspace_path(path)
    task_root = Path(task.workspace_root).resolve()
    target = (task_root / relative).resolve()
    if not _path_within(task_root, target):
        raise TaskWorkspaceFileError("Task workspace path escapes the allowed workspace.")
    if not target.exists() or not target.is_file():
        raise FileNotFoundError("Task workspace file not found.")
    return target, str(relative)


def _is_text_preview(mime_type: str, path: Path) -> bool:
    return (
        mime_type.startswith("text/")
        or mime_type in {"application/json", "application/xml", "application/javascript"}
        or path.suffix.lower() in TEXT_PREVIEW_EXTENSIONS
    )


def _task_brief_markdown(*, title: str, goal: str, success_criteria: str | None) -> str:
    return render_task_markdown(title=title, goal=goal, success_criteria=success_criteria).strip()


def get_project_root(project_id: str) -> Path:
    return get_settings().projects_dir / project_id


def get_project_notes_dir(project_id: str) -> Path:
    return get_project_root(project_id) / "notes"


def get_project_venv_path(project_id: str) -> Path:
    return get_settings().socrates_python_venv


def get_task_root(project_id: str, task_id: str) -> Path:
    return get_project_root(project_id) / "tasks" / task_id


def ensure_project_directories(project_id: str) -> Path:
    project_root = get_project_root(project_id)
    (project_root / "tasks").mkdir(parents=True, exist_ok=True)
    get_project_notes_dir(project_id).mkdir(parents=True, exist_ok=True)
    return project_root


def ensure_project_venv(project_id: str) -> Path:
    ensure_project_directories(project_id)
    return ensure_managed_python_runtime().venv_path


def list_project_workspaces(session: Session, project_id: str) -> list[ProjectWorkspace]:
    get_project(session, project_id)
    return list(
        session.execute(
            select(ProjectWorkspace)
            .where(ProjectWorkspace.project_id == project_id)
            .order_by(ProjectWorkspace.is_primary.desc(), ProjectWorkspace.created_at.asc())
        ).scalars()
    )


def _resolve_linked_workspace_path(raw_path: str) -> Path:
    cleaned = raw_path.strip()
    if not cleaned:
        raise ValueError("Workspace path is required.")

    candidate = Path(cleaned).expanduser()
    if not candidate.is_absolute():
        raise ValueError("Workspace path must be an absolute path.")

    resolved = candidate.resolve()
    _validate_linked_workspace_path(resolved)
    return resolved


def _validate_linked_workspace_path(path: Path) -> None:
    settings = get_settings()
    socrates_home = settings.socrates_home.resolve()
    home = Path.home().resolve()
    filesystem_root = Path(path.anchor or path.root).resolve()

    if path == filesystem_root:
        raise ValueError("Workspace path cannot be a filesystem root.")
    if path == home:
        raise ValueError("Workspace path cannot be the user's home folder.")
    if path == socrates_home or _path_within(socrates_home, path):
        raise ValueError("Workspace path cannot be inside the Socrates runtime home.")
    if path.exists() and not path.is_dir():
        raise ValueError("Workspace path must point to a directory.")
    if not path.exists():
        raise ValueError("Workspace path must already exist.")


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
    if relative_path is None or not relative_path.strip():
        raise ValueError("Workspace path is required.")
    root_path = _resolve_linked_workspace_path(relative_path)

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


def close_task(
    session: Session,
    task_id: str,
    *,
    status: str,
    result_summary: str | None = None,
) -> Task:
    task = get_task(session, task_id)
    _validate_task_closure(session, task=task, status=status, result_summary=result_summary)
    return update_task_status(
        session,
        task_id,
        status=status,
        result_summary=result_summary.strip() if result_summary and result_summary.strip() else None,
    )


def task_completion_approval_request_payload(*, status: str, result_summary: str | None) -> dict[str, Any]:
    return {
        "status": status,
        "result_summary": result_summary.strip() if result_summary and result_summary.strip() else "",
    }


def ensure_task_completion_approval(
    session: Session,
    *,
    task_id: str,
    agent_run_id: str | None,
    tool_execution_id: str | None,
    status: str,
    result_summary: str | None,
) -> TaskApproval:
    return create_task_approval(
        session,
        task_id=task_id,
        agent_run_id=agent_run_id,
        tool_execution_id=tool_execution_id,
        approval_type=TASK_COMPLETION_APPROVAL_TYPE,
        request_json=task_completion_approval_request_payload(
            status=status,
            result_summary=result_summary,
        ),
    )


def close_task_from_completion_approval(session: Session, *, approval_id: str) -> Task:
    approval = session.get(TaskApproval, approval_id)
    if approval is None:
        raise LookupError("Task approval not found.")
    if approval.approval_type != TASK_COMPLETION_APPROVAL_TYPE:
        raise ValueError("Only task completion approvals can close tasks.")
    if approval.status != "approved":
        raise ValueError("Task completion approval must be approved before closing.")
    status = str(approval.request_json.get("status") or "completed")
    result_summary = str(approval.request_json.get("result_summary") or "")
    return close_task(
        session,
        approval.task_id,
        status=status,
        result_summary=result_summary,
    )


def _validate_task_closure(
    session: Session,
    *,
    task: Task,
    status: str,
    result_summary: str | None,
) -> None:
    if status not in TERMINAL_TASK_STATUSES:
        raise TaskClosureValidationError(
            error_type="validation_error",
            message="Task closure status must be either 'completed' or 'failed'.",
            suggestion="Call update_task_status with status='completed' or status='failed'.",
        )
    if task.status in TERMINAL_TASK_STATUSES:
        raise TaskClosureValidationError(
            error_type="task_already_terminal",
            message="This task is already closed and cannot be closed again.",
            suggestion="Start or resume an active task before attempting lifecycle closure.",
            retryable=False,
        )
    if task.status not in ACTIVE_TASK_STATUSES:
        raise TaskClosureValidationError(
            error_type="task_not_active",
            message="Only an active task can be closed by the agent runtime.",
            suggestion="Start or resume an active task before attempting lifecycle closure.",
            retryable=False,
        )
    if status == "failed" and not (result_summary and result_summary.strip()):
        raise TaskClosureValidationError(
            error_type="validation_error",
            message="Failed task closure requires a non-empty result_summary.",
            suggestion="Explain the abandonment or unrecoverable failure in result_summary.",
        )

    state = get_task_package_disk_state(Path(task.workspace_root).resolve())
    if not state.task.valid:
        raise TaskClosureValidationError(
            error_type="planning_required",
            message="task.md must be valid before task closure.",
            suggestion="Repair task.md so it matches the canonical task structure before closing the task.",
        )
    if not state.plan.valid or state.plan_fingerprint is None:
        raise TaskClosureValidationError(
            error_type="planning_required",
            message="plan.md must exist and be valid before task closure.",
            suggestion="Write a valid plan.md and obtain user approval before closing the task.",
        )
    if not is_plan_sha256_approved(session, task.id, state.plan_fingerprint):
        raise TaskClosureValidationError(
            error_type="plan_approval_required",
            message="The current plan.md revision must be approved before task closure.",
            suggestion="Wait for the user to approve the current plan revision before closing the task.",
        )
    if not state.todo.valid or state.todo.content is None:
        raise TaskClosureValidationError(
            error_type="todo_required",
            message="todo.md must exist and be valid before task closure.",
            suggestion="Create a valid todo.md checklist before closing the task.",
        )
    if status == "completed":
        checklist = parse_todo_checklist(state.todo.content)
        if not checklist.all_checked:
            unchecked = ", ".join(item.item_id for item in checklist.unchecked_items) or "unknown"
            raise TaskClosureValidationError(
                error_type="todo_incomplete",
                message=f"Task completion requires all todo.md checklist items to be checked. Unchecked items: {unchecked}.",
                suggestion="Complete and check every todo.md item before marking the task completed.",
            )


def list_task_artifacts(session: Session, task_id: str) -> list[TaskArtifact]:
    get_task(session, task_id)
    return list(
        session.execute(
            select(TaskArtifact)
            .where(TaskArtifact.task_id == task_id)
            .order_by(TaskArtifact.created_at.asc())
        ).scalars()
    )


def list_task_workspace_tree(session: Session, task_id: str) -> dict[str, Any]:
    task = get_task(session, task_id)
    task_root = Path(task.workspace_root).resolve()
    roots: list[dict[str, Any]] = []
    for dirname in VISIBLE_TASK_WORKSPACE_DIRS:
        root = (task_root / dirname).resolve()
        entries: list[dict[str, Any]] = []
        if root.exists():
            for path in sorted(root.rglob("*"), key=lambda item: str(item.relative_to(task_root))):
                relative_path = str(path.relative_to(task_root))
                is_file = path.is_file()
                mime_type = mimetypes.guess_type(path.name)[0] if is_file else None
                entries.append(
                    {
                        "path": relative_path,
                        "name": path.name,
                        "parent_path": str(path.parent.relative_to(task_root)) if path.parent != task_root else None,
                        "is_dir": path.is_dir(),
                        "size_bytes": path.stat().st_size if is_file else None,
                        "mime_type": mime_type,
                        "updated_at": datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat(),
                    }
                )
        roots.append({"path": dirname, "name": dirname, "entries": entries})
    return {"task_id": task.id, "roots": roots}


def read_task_workspace_file_preview(session: Session, task_id: str, path: str) -> dict[str, Any]:
    task = get_task(session, task_id)
    target, relative_path = _task_workspace_file(task, path)
    mime_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    size_bytes = target.stat().st_size
    base_payload: dict[str, Any] = {
        "task_id": task.id,
        "path": relative_path,
        "name": target.name,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "sha256": _sha256_bytes(target.read_bytes()),
    }
    if _is_text_preview(mime_type, target):
        raw = target.read_bytes()
        truncated = len(raw) > MAX_TEXT_PREVIEW_BYTES
        text = raw[:MAX_TEXT_PREVIEW_BYTES].decode("utf-8", errors="replace")
        return {
            **base_payload,
            "preview_type": "text",
            "content_text": text,
            "encoding": "utf-8",
            "truncated": truncated,
        }
    if mime_type.startswith("image/") and size_bytes <= MAX_BINARY_DATA_URL_BYTES:
        encoded = base64.b64encode(target.read_bytes()).decode("ascii")
        return {
            **base_payload,
            "preview_type": "image",
            "data_url": f"data:{mime_type};base64,{encoded}",
            "truncated": False,
        }
    return {
        **base_payload,
        "preview_type": "binary",
        "truncated": False,
    }


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


def plan_approval_request_payload(*, path: str = "plan.md", sha256: str) -> dict[str, Any]:
    return {"path": path, "sha256": sha256}


def is_plan_sha256_approved(session: Session, task_id: str, plan_sha256: str) -> bool:
    for approval in list(
        session.execute(
            select(TaskApproval)
            .where(
                TaskApproval.task_id == task_id,
                TaskApproval.approval_type == PLAN_APPROVAL_TYPE,
                TaskApproval.status == "approved",
            )
            .order_by(TaskApproval.created_at.desc())
        ).scalars()
    ):
        if approval.request_json.get("sha256") == plan_sha256:
            return True
    return False


def ensure_plan_approval_for_revision(
    session: Session,
    *,
    task_id: str,
    agent_run_id: str | None,
    tool_execution_id: str | None,
    plan_sha256: str,
) -> TaskApproval | None:
    """If the user has already approved this exact plan content, return None.

    Otherwise create or reuse a pending `plan_approval` for this plan fingerprint
    and set the task to ``awaiting_approval`` as needed.
    """
    if is_plan_sha256_approved(session, task_id, plan_sha256):
        return None
    return create_task_approval(
        session,
        task_id=task_id,
        agent_run_id=agent_run_id,
        tool_execution_id=tool_execution_id,
        approval_type=PLAN_APPROVAL_TYPE,
        request_json=plan_approval_request_payload(sha256=plan_sha256),
    )


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

    existing_by_path = {
        artifact.relative_path: artifact
        for artifact in session.execute(
            select(TaskArtifact).where(
                TaskArtifact.task_id == task.id,
                TaskArtifact.artifact_role == "output",
            )
        ).scalars()
    }
    artifacts: list[TaskArtifact] = []
    for path in sorted(output_root.rglob("*")):
        if not path.is_file():
            continue
        relative_path = str(path.relative_to(task_root))
        existing = existing_by_path.get(relative_path)
        previous_sha = existing.sha256 if existing is not None else None
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        artifact = add_task_artifact(
            session,
            task=task,
            relative_path=relative_path,
            artifact_role="output",
            display_name=path.name,
            mime_type=mime_type,
            path=path,
            metadata_json={"managed_output": True},
        )
        if existing is None or artifact.sha256 != previous_sha:
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


def _host_visible_task_workspace_root(task: Task) -> str | None:
    settings = get_settings()
    if settings.socrates_home_host is None:
        return None

    workspace_root = Path(task.workspace_root).resolve()
    try:
        relative_root = workspace_root.relative_to(settings.socrates_home.resolve())
    except ValueError:
        return None
    return str((settings.socrates_home_host / relative_root).resolve())


def _recovery_action(action_id: str) -> dict[str, str]:
    action = RECOVERY_ACTIONS[action_id]
    return {
        "id": action_id,
        "label": action["label"],
        "description": action["description"],
        "owner": "socrates",
    }


def _todo_recovery_summary(task: Task) -> dict[str, Any] | None:
    todo_path = Path(task.workspace_root).resolve() / "todo.md"
    if not todo_path.is_file():
        return None
    try:
        state = parse_worker_todo_state(todo_path.read_text(encoding="utf-8", errors="replace"))
    except (TaskPackageValidationError, ValueError):
        return None

    remaining_items = [item for item in state.items if item.status not in {"completed", "skipped"}]
    blocked_items = list(state.blocked_items)
    return {
        "counts": state.progress_counts(),
        "checked_ids": [item.item_id for item in state.items if item.status == "completed"],
        "remaining_ids": [item.item_id for item in remaining_items],
        "blocked_ids": [item.item_id for item in blocked_items],
        "current_item_id": state.current_item.item_id if state.current_item else None,
        "blocked_items": [
            {
                "id": item.item_id,
                "text": item.text,
                "reason": item.reason,
                "recommended_action": item.recommended_action,
            }
            for item in blocked_items
        ],
    }


def _output_artifact_summaries(session: Session, task: Task, *, limit: int = 5) -> list[dict[str, Any]]:
    artifacts = list(
        session.execute(
            select(TaskArtifact)
            .where(TaskArtifact.task_id == task.id, TaskArtifact.artifact_role == "output")
            .order_by(TaskArtifact.created_at.desc())
            .limit(limit)
        ).scalars()
    )
    return [
        {
            "id": artifact.id,
            "path": artifact.relative_path,
            "display_name": artifact.display_name,
            "mime_type": artifact.mime_type,
            "size_bytes": artifact.size_bytes,
            "sha256": artifact.sha256,
            "created_at": artifact.created_at.isoformat(),
        }
        for artifact in artifacts
    ]


def _pending_completion_approval(session: Session, task: Task) -> TaskApproval | None:
    return (
        session.execute(
            select(TaskApproval)
            .where(
                TaskApproval.task_id == task.id,
                TaskApproval.approval_type == TASK_COMPLETION_APPROVAL_TYPE,
                TaskApproval.status == "pending",
            )
            .order_by(TaskApproval.created_at.desc())
        )
        .scalars()
        .first()
    )


def _latest_recoverable_run(session: Session, task: Task) -> AgentRun | None:
    return (
        session.execute(
            select(AgentRun)
            .where(AgentRun.task_id == task.id, AgentRun.status.in_(tuple(RECOVERABLE_RUN_STATUSES)))
            .order_by(AgentRun.created_at.desc())
        )
        .scalars()
        .first()
    )


def _latest_worker_blocked_event(session: Session, task: Task) -> AgentEventRecord | None:
    return (
        session.execute(
            select(AgentEventRecord)
            .join(AgentRun, AgentEventRecord.agent_run_id == AgentRun.id)
            .where(
                AgentRun.task_id == task.id,
                AgentEventRecord.event_type == WORKER_BLOCKED_EVENT_TYPE,
            )
            .order_by(AgentEventRecord.created_at.desc())
        )
        .scalars()
        .first()
    )


def _latest_blocked_worker_run(session: Session, task: Task) -> AgentRun | None:
    return (
        session.execute(
            select(AgentRun)
            .where(
                AgentRun.task_id == task.id,
                AgentRun.execution_mode == "worker",
                AgentRun.status == "blocked",
            )
            .order_by(AgentRun.created_at.desc())
        )
        .scalars()
        .first()
    )


def _worker_blocked_payload(
    *, event: AgentEventRecord | None, worker_run: AgentRun | None
) -> tuple[dict[str, Any], datetime] | None:
    if event is not None:
        payload = event.payload_json
        result = payload.get("result") if isinstance(payload.get("result"), dict) else {}
        return (
            {
                "source_run_id": payload.get("run_id") or event.agent_run_id,
                "source_worker_run_id": payload.get("worker_run_id"),
                "summary": result.get("summary") or "Worker blocked and needs Socrates to decide the next step.",
                "blockers": result.get("blockers") if isinstance(result.get("blockers"), list) else [],
            },
            event.created_at,
        )
    if worker_run is not None:
        result = worker_run.final_parsed_json if isinstance(worker_run.final_parsed_json, dict) else {}
        return (
            {
                "source_run_id": worker_run.request_json.get("parent_run_id"),
                "source_worker_run_id": worker_run.id,
                "summary": result.get("summary") or worker_run.error_message or "Worker blocked and needs Socrates to decide the next step.",
                "blockers": result.get("blockers") if isinstance(result.get("blockers"), list) else [],
            },
            worker_run.completed_at or worker_run.created_at,
        )
    return None


def build_task_recovery_state(session: Session, task: Task) -> dict[str, Any] | None:
    if task.status in TERMINAL_TASK_STATUSES:
        return None

    todo_summary = _todo_recovery_summary(task)
    output_artifacts = _output_artifact_summaries(session, task)
    completion_approval = _pending_completion_approval(session, task)
    if completion_approval is not None:
        summary = str(completion_approval.request_json.get("result_summary") or "").strip()
        return {
            "kind": "completion_approval_pending",
            "title": "Waiting for acceptance",
            "summary": summary or "Socrates has requested approval to close this task.",
            "source_approval_id": completion_approval.id,
            "todo": todo_summary,
            "outputs": output_artifacts,
            "suggested_actions": [
                _recovery_action("accept_partial_output"),
                _recovery_action("revise_plan"),
            ],
        }

    blocked_payload = _worker_blocked_payload(
        event=_latest_worker_blocked_event(session, task),
        worker_run=_latest_blocked_worker_run(session, task),
    )
    recoverable_run = _latest_recoverable_run(session, task)

    blocked_created_at = blocked_payload[1] if blocked_payload is not None else None
    run_created_at = (recoverable_run.completed_at or recoverable_run.created_at) if recoverable_run is not None else None
    if blocked_payload is not None and (run_created_at is None or blocked_created_at >= run_created_at):
        payload = blocked_payload[0]
        return {
            "kind": "worker_blocked",
            "title": "Worker needs direction",
            "summary": payload["summary"],
            "source_run_id": payload.get("source_run_id"),
            "source_worker_run_id": payload.get("source_worker_run_id"),
            "blockers": payload["blockers"],
            "todo": todo_summary,
            "outputs": output_artifacts,
            "suggested_actions": [
                _recovery_action("retry_remaining_work"),
                _recovery_action("revise_plan"),
                _recovery_action("accept_partial_output"),
                _recovery_action("close_task_failed"),
            ],
        }

    if recoverable_run is not None:
        if recoverable_run.status == "cancelled":
            return {
                "kind": "cancelled",
                "title": "Stopped by user",
                "summary": "The last task run was stopped. The task is still available for Socrates to retry, revise, or close.",
                "source_run_id": recoverable_run.id,
                "todo": todo_summary,
                "outputs": output_artifacts,
                "suggested_actions": [
                    _recovery_action("retry_remaining_work"),
                    _recovery_action("revise_plan"),
                    _recovery_action("close_task_failed"),
                    _recovery_action("start_separate_task"),
                ],
            }
        return {
            "kind": "stalled",
            "title": "Run stalled",
            "summary": recoverable_run.error_message or "The backend stopped waiting because the run had no meaningful progress.",
            "source_run_id": recoverable_run.id,
            "todo": todo_summary,
            "outputs": output_artifacts,
            "suggested_actions": [
                _recovery_action("retry_remaining_work"),
                _recovery_action("revise_plan"),
                _recovery_action("close_task_failed"),
                _recovery_action("start_separate_task"),
            ],
        }

    if output_artifacts:
        return {
            "kind": "outputs_waiting_for_acceptance",
            "title": "Output waiting for review",
            "summary": "The task has output artifacts, but it has not been accepted and closed yet.",
            "todo": todo_summary,
            "outputs": output_artifacts,
            "suggested_actions": [
                _recovery_action("accept_partial_output"),
                _recovery_action("revise_plan"),
                _recovery_action("close_task_failed"),
            ],
        }

    return None


def serialize_task(task: Task, *, session: Session | None = None) -> dict[str, Any]:
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
        "workspace_host_root": _host_visible_task_workspace_root(task),
        "venv_path": task.venv_path,
        "result_summary": task.result_summary,
        "created_at": task.created_at.isoformat(),
        "updated_at": task.updated_at.isoformat(),
        "completed_at": task.completed_at.isoformat() if task.completed_at else None,
        "failed_at": task.failed_at.isoformat() if task.failed_at else None,
        "recovery_state": build_task_recovery_state(session, task) if session is not None else None,
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
