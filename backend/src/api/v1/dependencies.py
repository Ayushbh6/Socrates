from fastapi import Depends, Request
from sqlalchemy.orm import Session

from ...db.session import get_db_session
from ...services.chat import RunManager


def get_session_dependency() -> Session:
    yield from get_db_session()


def get_run_manager(request: Request) -> RunManager:
    return request.app.state.run_manager
