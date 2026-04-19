from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from ..core.model_catalog import DEFAULT_MODEL, DEFAULT_THINKING_LEVEL, normalize_thinking_level, require_supported_model
from ..core.schema import ThinkingLevel
from ..db.models import Conversation, MessageAsset, MessageRecord, Project
from .bootstrap import get_current_user
from .utils import apply_updates

# Placeholder title for new conversations; replaced on first user message unless renamed.
NEW_CONVERSATION_PLACEHOLDER_TITLE = "New conversation"


def derive_initial_conversation_title(content_text: str) -> str:
    """Raw title from the first word of the first user message (product rule)."""
    stripped = content_text.strip()
    if not stripped:
        return NEW_CONVERSATION_PLACEHOLDER_TITLE
    first_word = stripped.split()[0]
    if len(first_word) > 5:
        return f"{first_word[:5]}..."
    return first_word


def list_projects(session: Session) -> list[Project]:
    return list(
        session.execute(
            select(Project).where(Project.archived_at.is_(None)).order_by(Project.created_at.desc())
        ).scalars()
    )


def create_project(
    session: Session,
    *,
    name: str,
    description: str | None = None,
    default_system_prompt: str | None = None,
    status: str = "active",
) -> Project:
    user = get_current_user(session)
    if user is None:
        raise LookupError("Bootstrap is required before creating projects.")

    project = Project(
        user_id=user.id,
        name=name,
        description=description,
        default_system_prompt=default_system_prompt,
        status=status,
    )
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


def get_project(session: Session, project_id: str) -> Project:
    project = session.get(Project, project_id)
    if project is None or project.archived_at is not None:
        raise LookupError("Project not found.")
    return project


def update_project(
    session: Session,
    project_id: str,
    *,
    name: str | None = None,
    description: str | None = None,
    status: str | None = None,
    default_system_prompt: str | None = None,
) -> Project:
    project = get_project(session, project_id)
    apply_updates(
        project,
        {
            "name": name,
            "description": description,
            "status": status,
            "default_system_prompt": default_system_prompt,
        },
    )
    session.commit()
    session.refresh(project)
    return project


def list_conversations(session: Session, project_id: str) -> list[Conversation]:
    get_project(session, project_id)
    return list(
        session.execute(
            select(Conversation)
            .where(Conversation.project_id == project_id, Conversation.archived_at.is_(None))
            .order_by(Conversation.updated_at.desc())
        ).scalars()
    )


def create_conversation(
    session: Session,
    *,
    project_id: str,
    title: str | None,
    summary: str | None = None,
    model: str | None = None,
    thinking_level: ThinkingLevel | None = None,
) -> Conversation:
    get_project(session, project_id)
    resolved_model = model or DEFAULT_MODEL
    require_supported_model(resolved_model)
    resolved_thinking = normalize_thinking_level(
        resolved_model,
        thinking_level or DEFAULT_THINKING_LEVEL,
    )
    resolved_title = (title.strip() if title else None) or NEW_CONVERSATION_PLACEHOLDER_TITLE
    conversation = Conversation(
        project_id=project_id,
        title=resolved_title,
        summary=summary,
        model=resolved_model,
        thinking_level=resolved_thinking.value,
    )
    session.add(conversation)
    session.commit()
    session.refresh(conversation)
    return conversation


def update_conversation(
    session: Session,
    conversation_id: str,
    *,
    title: str | None = None,
    summary: str | None = None,
    model: str | None = None,
    thinking_level: ThinkingLevel | None = None,
) -> Conversation:
    conversation = get_conversation(session, conversation_id)
    resolved_model = model or conversation.model
    require_supported_model(resolved_model)
    resolved_thinking = normalize_thinking_level(
        resolved_model,
        thinking_level or ThinkingLevel(conversation.thinking_level),
    )
    apply_updates(
        conversation,
        {
            "title": title,
            "summary": summary,
            "model": resolved_model,
            "thinking_level": resolved_thinking.value,
        },
    )
    conversation.updated_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(conversation)
    return conversation


def get_conversation(session: Session, conversation_id: str) -> Conversation:
    conversation = session.get(Conversation, conversation_id)
    if conversation is None or conversation.archived_at is not None:
        raise LookupError("Conversation not found.")
    get_project(session, conversation.project_id)
    return conversation


def archive_project(session: Session, project_id: str) -> Project:
    project = get_project(session, project_id)
    project.archived_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(project)
    return project


def archive_conversation(session: Session, conversation_id: str) -> Conversation:
    conversation = get_conversation(session, conversation_id)
    conversation.archived_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(conversation)
    return conversation


def list_messages(session: Session, conversation_id: str) -> list[MessageRecord]:
    conversation = get_conversation(session, conversation_id)
    return list(
        session.execute(
            select(MessageRecord)
            .where(MessageRecord.conversation_id == conversation.id)
            .options(joinedload(MessageRecord.asset_links).joinedload(MessageAsset.asset))
            .order_by(MessageRecord.sequence_no.asc())
        ).unique().scalars()
    )


def next_message_sequence(session: Session, conversation_id: str) -> int:
    max_seq = session.execute(
        select(func.max(MessageRecord.sequence_no)).where(MessageRecord.conversation_id == conversation_id)
    ).scalar_one()
    return int(max_seq or 0) + 1
