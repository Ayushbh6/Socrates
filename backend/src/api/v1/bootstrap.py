from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ...services.bootstrap import create_user, get_bootstrap_status, get_current_user, update_user
from .dependencies import get_session_dependency
from .schemas import BootstrapCreateRequest, BootstrapStatusResponse, UpdateUserRequest, UserResponse

router = APIRouter(tags=["bootstrap"])


def _to_user_response(user) -> UserResponse:
    return UserResponse(
        id=user.id,
        display_name=user.display_name,
        preferences=user.preferences_json,
        created_at=user.created_at,
        updated_at=user.updated_at,
        onboarding_completed_at=user.onboarding_completed_at,
    )


@router.get("/bootstrap", response_model=BootstrapStatusResponse)
def bootstrap_status(session: Session = Depends(get_session_dependency)) -> BootstrapStatusResponse:
    return BootstrapStatusResponse(**get_bootstrap_status(session))


@router.post("/bootstrap", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def bootstrap_create(
    request: BootstrapCreateRequest,
    session: Session = Depends(get_session_dependency),
) -> UserResponse:
    try:
        user = create_user(session, display_name=request.display_name, preferences=request.preferences)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return _to_user_response(user)


@router.get("/me", response_model=UserResponse)
def me(session: Session = Depends(get_session_dependency)) -> UserResponse:
    user = get_current_user(session)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No local user profile exists.")
    return _to_user_response(user)


@router.patch("/me", response_model=UserResponse)
def update_me(
    request: UpdateUserRequest,
    session: Session = Depends(get_session_dependency),
) -> UserResponse:
    try:
        user = update_user(session, display_name=request.display_name, preferences=request.preferences)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _to_user_response(user)
