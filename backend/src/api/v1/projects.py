from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ...services.projects import (
    create_conversation,
    create_project,
    get_project,
    list_conversations,
    list_projects,
    update_project,
)
from .dependencies import get_session_dependency
from .schemas import (
    ConversationCreateRequest,
    ConversationResponse,
    ProjectCreateRequest,
    ProjectResponse,
    ProjectUpdateRequest,
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
        conversation = create_conversation(session, project_id=project_id, title=request.title, summary=request.summary)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _to_conversation_response(conversation)
