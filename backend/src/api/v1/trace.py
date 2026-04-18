from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...db.models import AgentEventRecord, AgentRunTurn
from ...services import (
    get_agent_run,
    list_agent_run_events,
    list_agent_run_turns,
    serialize_agent_event,
    serialize_agent_run,
    serialize_agent_run_turn,
)
from .dependencies import get_session_dependency
from .schemas import AgentRunEventResponse, AgentRunResponse, AgentRunTurnResponse

router = APIRouter(tags=["trace"])


@router.get("/agent-runs/{run_id}", response_model=AgentRunResponse)
def get_run(run_id: str, session: Session = Depends(get_session_dependency)) -> AgentRunResponse:
    try:
        run = get_agent_run(session, run_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    event_count = session.execute(
        select(func.count(AgentEventRecord.id)).where(AgentEventRecord.agent_run_id == run_id)
    ).scalar_one()
    turn_count = session.execute(
        select(func.count(AgentRunTurn.id)).where(AgentRunTurn.agent_run_id == run_id)
    ).scalar_one()
    return AgentRunResponse.model_validate(
        serialize_agent_run(run, event_count=int(event_count or 0), turn_count=int(turn_count or 0))
    )


@router.get("/agent-runs/{run_id}/turns", response_model=list[AgentRunTurnResponse])
def get_run_turns(run_id: str, session: Session = Depends(get_session_dependency)) -> list[AgentRunTurnResponse]:
    try:
        turns = list_agent_run_turns(session, run_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return [AgentRunTurnResponse.model_validate(serialize_agent_run_turn(turn)) for turn in turns]


@router.get("/agent-runs/{run_id}/events", response_model=list[AgentRunEventResponse])
def get_run_events(run_id: str, session: Session = Depends(get_session_dependency)) -> list[AgentRunEventResponse]:
    try:
        events = list_agent_run_events(session, run_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return [AgentRunEventResponse.model_validate(serialize_agent_event(event)) for event in events]
