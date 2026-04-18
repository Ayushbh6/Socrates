from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db.models import User
from .utils import apply_updates


def get_bootstrap_status(session: Session) -> dict[str, bool]:
    user = session.execute(select(User)).scalars().first()
    return {
        "has_user": user is not None,
        "onboarding_completed": bool(user and user.onboarding_completed_at),
    }


def get_current_user(session: Session) -> User | None:
    return session.execute(select(User)).scalars().first()


def create_user(session: Session, display_name: str, preferences: dict | None = None) -> User:
    if get_current_user(session) is not None:
        raise ValueError("Bootstrap has already been completed.")

    now = datetime.now(timezone.utc)
    user = User(
        display_name=display_name,
        onboarding_completed_at=now,
        preferences_json=preferences or {},
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user


def update_user(session: Session, *, display_name: str | None = None, preferences: dict | None = None) -> User:
    user = get_current_user(session)
    if user is None:
        raise LookupError("No local user profile exists yet.")

    apply_updates(
        user,
        {
            "display_name": display_name,
            "preferences_json": preferences if preferences is not None else user.preferences_json,
        },
    )
    session.commit()
    session.refresh(user)
    return user
