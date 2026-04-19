from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session

from ...services.assets import create_project_asset, list_project_assets, delete_project_asset
from ...services.chat import RunManager, create_message_and_run, serialize_asset, serialize_message
from ...services.projects import get_conversation, list_messages
from .dependencies import get_run_manager, get_session_dependency
from .schemas import AssetResponse, CreateMessageRequest, CreateMessageResponse, MessageResponse

router = APIRouter(tags=["chat"])


@router.get("/conversations/{conversation_id}/messages", response_model=list[MessageResponse])
def get_messages(conversation_id: str, session: Session = Depends(get_session_dependency)) -> list[MessageResponse]:
    try:
        messages = list_messages(session, conversation_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return [MessageResponse.model_validate(serialize_message(message)) for message in messages]


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
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    await run_manager.start_run(run.id)
    return CreateMessageResponse(message_id=message.id, agent_run_id=run.id, status=run.status)


@router.websocket("/agent-runs/{run_id}/stream")
async def stream_run(websocket: WebSocket, run_id: str) -> None:
    run_manager: RunManager = websocket.app.state.run_manager
    if run_manager.get_run_status(run_id) is None:
        await websocket.close(code=4404)
        return

    await websocket.accept()

    # Subscribe BEFORE replaying so live events emitted during/after the DB
    # read are buffered in the queue. We then replay DB events (each carries
    # its own seq) and finally drain the queue while skipping any payload
    # whose seq was already covered by the replay. This eliminates the
    # subscribe/replay race that would otherwise drop mid-stream deltas.
    queue = await run_manager.subscribe(run_id)
    last_replayed_seq = 0
    try:
        for payload in run_manager.replay_events(run_id):
            await websocket.send_json(payload)
            seq_value = payload.get("seq")
            if isinstance(seq_value, int) and seq_value > last_replayed_seq:
                last_replayed_seq = seq_value
            if payload["type"] in {"run.completed", "run.failed"}:
                await websocket.close()
                return

        status_value = run_manager.get_run_status(run_id)
        if status_value in {"completed", "failed"}:
            # Run finished while we were replaying; drain any straggler
            # events that were published after our DB read so the client
            # still receives the terminal frame.
            while not queue.empty():
                payload = queue.get_nowait()
                seq_value = payload.get("seq")
                if isinstance(seq_value, int) and seq_value <= last_replayed_seq:
                    continue
                await websocket.send_json(payload)
                if payload["type"] in {"run.completed", "run.failed"}:
                    break
            await websocket.close()
            return

        while True:
            payload = await queue.get()
            seq_value = payload.get("seq")
            if isinstance(seq_value, int) and seq_value <= last_replayed_seq:
                continue
            await websocket.send_json(payload)
            if payload["type"] in {"run.completed", "run.failed"}:
                await websocket.close()
                break
    except WebSocketDisconnect:
        pass
    finally:
        await run_manager.unsubscribe(run_id, queue)
