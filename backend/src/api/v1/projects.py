from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ...services.chat import RunManager
from ...services.projects import (
    archive_conversation,
    archive_project,
    create_conversation,
    create_project,
    get_project,
    list_conversations,
    list_projects,
    update_conversation,
    update_project,
)
from ...services.tasks import (
    create_project_workspace,
    export_task_artifact_to_asset,
    get_active_task_for_conversation,
    get_task,
    list_conversation_tasks,
    list_project_workspaces,
    list_task_approvals,
    list_task_artifacts,
    resolve_task_approval,
    serialize_task,
    serialize_task_approval,
    serialize_task_artifact,
    update_project_workspace,
)
from .dependencies import get_run_manager, get_session_dependency
from .schemas import (
    ConversationCreateRequest,
    ConversationResponse,
    ConversationUpdateRequest,
    ProjectWorkspaceCreateRequest,
    ProjectWorkspaceResponse,
    ProjectWorkspaceUpdateRequest,
    ProjectCreateRequest,
    ProjectResponse,
    ProjectUpdateRequest,
    ResolveTaskApprovalRequest,
    TaskApprovalResponse,
    TaskArtifactResponse,
    TaskResponse,
)

router = APIRouter(tags=["projects"])


def _to_project_response(project) -> ProjectResponse:
    return ProjectResponse(
        id=project.id,
        user_id=project.user_id,
        name=project.name,
        description=project.description,
        status=project.status,
        default_system_prompt=project.default_system_prompt,
        created_at=project.created_at,
        updated_at=project.updated_at,
        archived_at=project.archived_at,
    )


def _to_conversation_response(conversation) -> ConversationResponse:
    return ConversationResponse(
        id=conversation.id,
        project_id=conversation.project_id,
        title=conversation.title,
        summary=conversation.summary,
        model=conversation.model,
        thinking_level=conversation.thinking_level,
        created_at=conversation.created_at,
        updated_at=conversation.updated_at,
        archived_at=conversation.archived_at,
    )


@router.get("/projects", response_model=list[ProjectResponse])
def get_projects(session: Session = Depends(get_session_dependency)) -> list[ProjectResponse]:
    return [_to_project_response(project) for project in list_projects(session)]


@router.post("/projects", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def post_project(
    request: ProjectCreateRequest,
    session: Session = Depends(get_session_dependency),
) -> ProjectResponse:
    try:
        project = create_project(
            session,
            name=request.name,
            description=request.description,
            default_system_prompt=request.default_system_prompt,
            status=request.status,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return _to_project_response(project)


@router.get("/projects/{project_id}", response_model=ProjectResponse)
def get_project_by_id(project_id: str, session: Session = Depends(get_session_dependency)) -> ProjectResponse:
    try:
        project = get_project(session, project_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _to_project_response(project)


@router.patch("/projects/{project_id}", response_model=ProjectResponse)
def patch_project(
    project_id: str,
    request: ProjectUpdateRequest,
    session: Session = Depends(get_session_dependency),
) -> ProjectResponse:
    try:
        project = update_project(
            session,
            project_id,
            name=request.name,
            description=request.description,
            status=request.status,
            default_system_prompt=request.default_system_prompt,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _to_project_response(project)


@router.delete("/projects/{project_id}", response_model=ProjectResponse)
def delete_project(project_id: str, session: Session = Depends(get_session_dependency)) -> ProjectResponse:
    try:
        project = archive_project(session, project_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _to_project_response(project)


@router.get("/projects/{project_id}/conversations", response_model=list[ConversationResponse])
def get_project_conversations(project_id: str, session: Session = Depends(get_session_dependency)) -> list[ConversationResponse]:
    try:
        conversations = list_conversations(session, project_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return [_to_conversation_response(conversation) for conversation in conversations]


@router.post("/projects/{project_id}/conversations", response_model=ConversationResponse, status_code=status.HTTP_201_CREATED)
def post_conversation(
    project_id: str,
    request: ConversationCreateRequest,
    session: Session = Depends(get_session_dependency),
) -> ConversationResponse:
    try:
        conversation = create_conversation(
            session,
            project_id=project_id,
            title=request.title,
            summary=request.summary,
            model=request.model,
            thinking_level=request.thinking_level,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _to_conversation_response(conversation)


@router.patch("/conversations/{conversation_id}", response_model=ConversationResponse)
def patch_conversation(
    conversation_id: str,
    request: ConversationUpdateRequest,
    session: Session = Depends(get_session_dependency),
) -> ConversationResponse:
    try:
        conversation = update_conversation(
            session,
            conversation_id,
            title=request.title,
            summary=request.summary,
            model=request.model,
            thinking_level=request.thinking_level,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _to_conversation_response(conversation)


@router.delete("/conversations/{conversation_id}", response_model=ConversationResponse)
def delete_conversation_route(
    conversation_id: str, session: Session = Depends(get_session_dependency)
) -> ConversationResponse:
    try:
        conversation = archive_conversation(session, conversation_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _to_conversation_response(conversation)


@router.get("/projects/{project_id}/workspaces", response_model=list[ProjectWorkspaceResponse])
def get_project_workspaces(project_id: str, session: Session = Depends(get_session_dependency)) -> list[ProjectWorkspaceResponse]:
    try:
        workspaces = list_project_workspaces(session, project_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return [ProjectWorkspaceResponse.model_validate(workspace, from_attributes=True) for workspace in workspaces]


@router.post("/projects/{project_id}/workspaces", response_model=ProjectWorkspaceResponse, status_code=status.HTTP_201_CREATED)
def post_project_workspace(
    project_id: str,
    request: ProjectWorkspaceCreateRequest,
    session: Session = Depends(get_session_dependency),
) -> ProjectWorkspaceResponse:
    try:
        workspace = create_project_workspace(
            session,
            project_id=project_id,
            label=request.label,
            relative_path=request.relative_path,
            editor_type=request.editor_type,
            is_primary=request.is_primary,
            access_granted=request.access_granted,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return ProjectWorkspaceResponse.model_validate(workspace, from_attributes=True)


@router.patch("/projects/{project_id}/workspaces/{workspace_id}", response_model=ProjectWorkspaceResponse)
def patch_project_workspace(
    project_id: str,
    workspace_id: str,
    request: ProjectWorkspaceUpdateRequest,
    session: Session = Depends(get_session_dependency),
) -> ProjectWorkspaceResponse:
    try:
        workspace = update_project_workspace(
            session,
            project_id=project_id,
            workspace_id=workspace_id,
            label=request.label,
            editor_type=request.editor_type,
            is_primary=request.is_primary,
            access_granted=request.access_granted,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    return ProjectWorkspaceResponse.model_validate(workspace, from_attributes=True)


@router.get("/conversations/{conversation_id}/tasks", response_model=list[TaskResponse])
def get_conversation_tasks(conversation_id: str, session: Session = Depends(get_session_dependency)) -> list[TaskResponse]:
    try:
        tasks = list_conversation_tasks(session, conversation_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return [TaskResponse.model_validate(serialize_task(task)) for task in tasks]


@router.get("/conversations/{conversation_id}/active-task", response_model=TaskResponse | None)
def get_active_task_route(conversation_id: str, session: Session = Depends(get_session_dependency)) -> TaskResponse | None:
    try:
        task = get_active_task_for_conversation(session, conversation_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if task is None:
        return None
    return TaskResponse.model_validate(serialize_task(task))


@router.get("/tasks/{task_id}", response_model=TaskResponse)
def get_task_route(task_id: str, session: Session = Depends(get_session_dependency)) -> TaskResponse:
    try:
        task = get_task(session, task_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return TaskResponse.model_validate(serialize_task(task))


@router.get("/tasks/{task_id}/artifacts", response_model=list[TaskArtifactResponse])
def get_task_artifacts_route(task_id: str, session: Session = Depends(get_session_dependency)) -> list[TaskArtifactResponse]:
    try:
        artifacts = list_task_artifacts(session, task_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return [TaskArtifactResponse.model_validate(serialize_task_artifact(artifact)) for artifact in artifacts]


@router.post("/task-artifacts/{artifact_id}/export", response_model=TaskArtifactResponse)
def export_task_artifact_route(
    artifact_id: str,
    session: Session = Depends(get_session_dependency),
) -> TaskArtifactResponse:
    try:
        artifact = export_task_artifact_to_asset(session, artifact_id=artifact_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return TaskArtifactResponse.model_validate(serialize_task_artifact(artifact))


@router.get("/tasks/{task_id}/approvals", response_model=list[TaskApprovalResponse])
def get_task_approvals_route(task_id: str, session: Session = Depends(get_session_dependency)) -> list[TaskApprovalResponse]:
    try:
        approvals = list_task_approvals(session, task_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return [TaskApprovalResponse.model_validate(serialize_task_approval(approval)) for approval in approvals]


@router.post("/task-approvals/{approval_id}", response_model=TaskApprovalResponse)
async def resolve_task_approval_route(
    approval_id: str,
    request: ResolveTaskApprovalRequest,
    session: Session = Depends(get_session_dependency),
    run_manager: RunManager = Depends(get_run_manager),
) -> TaskApprovalResponse:
    try:
        approval = resolve_task_approval(session, approval_id=approval_id, approved=request.approved, note=request.note)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    if approval.agent_run_id:
        await run_manager.record_external_event(
            approval.agent_run_id,
            event_type="task.approval.resolved",
            payload={
                "type": "task.approval.resolved",
                "run_id": approval.agent_run_id,
                "task_id": approval.task_id,
                "approval": serialize_task_approval(approval),
            },
        )
    return TaskApprovalResponse.model_validate(serialize_task_approval(approval))
