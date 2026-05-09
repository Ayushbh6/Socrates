from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...core.settings import get_settings
from ...db.models import AgentEventRecord, AgentRunTurn
from ...services.assets import create_project_asset, list_project_assets, delete_project_asset
from ...services.chat import (
    ConversationRunInProgressError,
    RunManager,
    create_message_and_run,
    get_active_run_for_conversation,
    is_terminal_run_status,
    serialize_agent_run,
    serialize_asset,
    serialize_message,
)
from ...services.projects import get_conversation, list_messages
from ...services.utils import to_json_compatible
from .dependencies import get_run_manager, get_session_dependency
from .schemas import AgentRunResponse, AssetResponse, CreateMessageRequest, CreateMessageResponse, MessageResponse

router = APIRouter(tags=["chat"])
logger = logging.getLogger(__name__)


async def _safe_send_json(websocket: WebSocket, payload: Any, *, run_id: str) -> bool:
    """Send a JSON payload over the WebSocket, tolerating malformed values.

    Returns True if the payload was transmitted, False if it was dropped due to
    a serialization error. A single unserializable event must never tear down a
    live stream -- the client would otherwise enter a reconnect loop that yields
    the same bad event on replay. By coercing through `to_json_compatible` and
    then catching residual serialization errors, we guarantee the stream
    continues and the bug is observable in backend logs.
    """

    try:
        await websocket.send_json(payload)
        return True
    except (TypeError, ValueError) as exc:
        event_type = payload.get("type") if isinstance(payload, dict) else None
        seq = payload.get("seq") if isinstance(payload, dict) else None
        logger.warning(
            "Dropping malformed stream payload for run %s (type=%s seq=%s): %s",
            run_id,
            event_type,
            seq,
            exc,
        )
        try:
            await websocket.send_json(to_json_compatible(payload))
            return True
        except (TypeError, ValueError) as retry_exc:
            logger.error(
                "Failed to transmit sanitized payload for run %s (type=%s seq=%s): %s",
                run_id,
                event_type,
                seq,
                retry_exc,
            )
            return False


@router.get("/conversations/{conversation_id}/messages", response_model=list[MessageResponse])
def get_messages(conversation_id: str, session: Session = Depends(get_session_dependency)) -> list[MessageResponse]:
    try:
        messages = list_messages(session, conversation_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return [MessageResponse.model_validate(serialize_message(message)) for message in messages]


@router.get("/conversations/{conversation_id}/active-run", response_model=AgentRunResponse | None)
async def get_active_run(
    conversation_id: str,
    session: Session = Depends(get_session_dependency),
    run_manager: RunManager = Depends(get_run_manager),
) -> AgentRunResponse | None:
    try:
        await run_manager.reconcile_stale_active_runs(conversation_id=conversation_id)
        run = get_active_run_for_conversation(session, conversation_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    if run is None:
        return None

    event_count = session.execute(
        select(func.count(AgentEventRecord.id)).where(AgentEventRecord.agent_run_id == run.id)
    ).scalar_one()
    turn_count = session.execute(
        select(func.count(AgentRunTurn.id)).where(AgentRunTurn.agent_run_id == run.id)
    ).scalar_one()
    return AgentRunResponse.model_validate(
        serialize_agent_run(run, event_count=int(event_count or 0), turn_count=int(turn_count or 0))
    )


@router.post("/agent-runs/{run_id}/cancel", response_model=AgentRunResponse)
async def cancel_agent_run(
    run_id: str,
    session: Session = Depends(get_session_dependency),
    run_manager: RunManager = Depends(get_run_manager),
) -> AgentRunResponse:
    try:
        run = await run_manager.cancel_run(run_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc

    event_count = session.execute(
        select(func.count(AgentEventRecord.id)).where(AgentEventRecord.agent_run_id == run.id)
    ).scalar_one()
    turn_count = session.execute(
        select(func.count(AgentRunTurn.id)).where(AgentRunTurn.agent_run_id == run.id)
    ).scalar_one()
    return AgentRunResponse.model_validate(
        serialize_agent_run(run, event_count=int(event_count or 0), turn_count=int(turn_count or 0))
    )


@router.post("/projects/{project_id}/assets", response_model=AssetResponse, status_code=status.HTTP_201_CREATED)
async def upload_asset(
    project_id: str,
    file: UploadFile = File(...),
    session: Session = Depends(get_session_dependency),
) -> AssetResponse:
    try:
        content = await file.read()
        asset = create_project_asset(
            session,
            project_id=project_id,
            original_name=file.filename or "image",
            mime_type=file.content_type or "application/octet-stream",
            content=content,
        )
    except (LookupError, ValueError) as exc:
        status_code = status.HTTP_404_NOT_FOUND if isinstance(exc, LookupError) else status.HTTP_400_BAD_REQUEST
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc
    return AssetResponse.model_validate(serialize_asset(asset))


@router.get("/projects/{project_id}/assets", response_model=list[AssetResponse])
def get_assets(project_id: str, session: Session = Depends(get_session_dependency)) -> list[AssetResponse]:
    try:
        assets = list_project_assets(session, project_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return [AssetResponse.model_validate(serialize_asset(asset)) for asset in assets]


@router.delete("/projects/{project_id}/assets/{asset_id}", response_model=AssetResponse)
def delete_asset(project_id: str, asset_id: str, session: Session = Depends(get_session_dependency)) -> AssetResponse:
    try:
        asset = delete_project_asset(session, project_id, asset_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return AssetResponse.model_validate(serialize_asset(asset))


@router.post("/conversations/{conversation_id}/messages", response_model=CreateMessageResponse, status_code=status.HTTP_202_ACCEPTED)
async def create_message(
    conversation_id: str,
    request: CreateMessageRequest,
    session: Session = Depends(get_session_dependency),
    run_manager: RunManager = Depends(get_run_manager),
) -> CreateMessageResponse:
    try:
        conversation = get_conversation(session, conversation_id)
        await run_manager.reconcile_stale_active_runs(conversation_id=conversation.id)
        message, run = create_message_and_run(
            session,
            conversation_id=conversation.id,
            model=request.model,
            thinking_level=request.thinking_level,
            input_mode=request.input_mode,
            content_text=request.content_text,
            asset_ids=request.asset_ids,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ConversationRunInProgressError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "conversation_run_in_progress",
                "message": str(exc),
                "run_id": exc.run_id,
            },
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    await run_manager.start_run(run.id)
    return CreateMessageResponse(message_id=message.id, agent_run_id=run.id, status=run.status)


@router.websocket("/agent-runs/{run_id}/stream")
async def stream_run(
    websocket: WebSocket,
    run_id: str,
    after_seq: int = Query(default=0, ge=0),
) -> None:
    run_manager: RunManager = websocket.app.state.run_manager
    if run_manager.get_run_snapshot(run_id) is None:
        await websocket.close(code=4404)
        return

    await websocket.accept()

    queue = await run_manager.subscribe(run_id)
    last_sent_seq = max(after_seq, 0)
    try:
        snapshot = run_manager.get_run_snapshot(run_id)
        if snapshot is None:
            await websocket.close(code=4404)
            return

        await _safe_send_json(websocket, snapshot, run_id=run_id)

        for payload in run_manager.replay_events(run_id, after_seq=after_seq):
            seq_value = payload.get("seq")
            delivered = await _safe_send_json(websocket, payload, run_id=run_id)
            if delivered and isinstance(seq_value, int) and seq_value > last_sent_seq:
                last_sent_seq = seq_value

        snapshot = run_manager.get_run_snapshot(run_id)
        if snapshot is None:
            await websocket.close(code=4404)
            return

        if is_terminal_run_status(snapshot["status"]) and snapshot["last_seq"] <= last_sent_seq:
            await websocket.close()
            return

        heartbeat_interval = max(1, get_settings().stream_heartbeat_interval_seconds)
        while True:
            try:
                payload = await asyncio.wait_for(queue.get(), timeout=heartbeat_interval)
            except asyncio.TimeoutError:
                heartbeat = {
                    "type": "run.heartbeat",
                    "run_id": run_id,
                    "ts": datetime.now(timezone.utc).isoformat(),
                }
                await _safe_send_json(websocket, heartbeat, run_id=run_id)
                continue
            seq_value = payload.get("seq")
            if isinstance(seq_value, int) and seq_value <= last_sent_seq:
                continue
            delivered = await _safe_send_json(websocket, payload, run_id=run_id)
            if delivered and isinstance(seq_value, int):
                last_sent_seq = seq_value
            if payload["type"] in {"run.completed", "run.failed", "run.blocked", "run.cancelled", "run.stalled"}:
                await websocket.close()
                break
    except WebSocketDisconnect:
        pass
    finally:
        await run_manager.unsubscribe(run_id, queue)
