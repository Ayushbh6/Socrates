from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from ..agent import AgentRequest, AgentRunner
from ..agent.events import AgentEvent, AgentEventType
from ..agents import build_socrates_system_prompt
from ..core.schema import Attachment, GenConfig, InputMode, Message, MessageRole, ThinkingLevel
from ..db.models import AgentEventRecord, AgentRun, AgentRunTurn, Asset, Conversation, MessageAsset, MessageRecord, Project
from ..db.session import get_session_factory
from .assets import get_project_assets_by_ids, resolve_asset_bytes
from .projects import get_conversation, next_message_sequence
from .utils import to_json_compatible


def serialize_asset(asset: Asset) -> dict[str, Any]:
    return {
        "id": asset.id,
        "project_id": asset.project_id,
        "kind": asset.kind,
        "source_type": asset.source_type,
        "original_name": asset.original_name,
        "mime_type": asset.mime_type,
        "storage_path": asset.storage_path,
        "size_bytes": asset.size_bytes,
        "sha256": asset.sha256,
        "created_at": asset.created_at.isoformat(),
        "deleted_at": asset.deleted_at.isoformat() if asset.deleted_at else None,
        "metadata": asset.metadata_json,
    }


def serialize_message(message: MessageRecord) -> dict[str, Any]:
    assets = [serialize_asset(link.asset) for link in message.asset_links]
    return {
        "id": message.id,
        "project_id": message.project_id,
        "conversation_id": message.conversation_id,
        "agent_run_id": message.agent_run_id,
        "role": message.role,
        "input_mode": message.input_mode,
        "content_text": message.content_text,
        "thinking_text": message.thinking_text,
        "status": message.status,
        "sequence_no": message.sequence_no,
        "provider": message.provider,
        "model": message.model,
        "created_at": message.created_at.isoformat(),
        "updated_at": message.updated_at.isoformat(),
        "failed_at": message.failed_at.isoformat() if message.failed_at else None,
        "metadata": message.metadata_json,
        "assets": assets,
    }


def serialize_agent_event(record: AgentEventRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "agent_run_id": record.agent_run_id,
        "agent_run_turn_id": record.agent_run_turn_id,
        "sequence_no": record.sequence_no,
        "event_type": record.event_type,
        "status": record.status,
        "content_text": record.content_text,
        "thinking_text": record.thinking_text,
        "tool_call_ref": record.tool_call_ref,
        "payload": record.payload_json,
        "created_at": record.created_at.isoformat(),
    }


def serialize_agent_run_turn(turn: AgentRunTurn) -> dict[str, Any]:
    return {
        "id": turn.id,
        "agent_run_id": turn.agent_run_id,
        "round_index": turn.round_index,
        "phase": turn.phase,
        "provider": turn.provider,
        "model": turn.model,
        "request_json": turn.request_json,
        "response_json": turn.response_json,
        "raw_dump_json": turn.raw_dump_json,
        "parsed_output_json": turn.parsed_output_json,
        "metadata_json": turn.metadata_json,
        "had_thinking": turn.had_thinking,
        "tool_call_count": turn.tool_call_count,
        "parsed_output_present": turn.parsed_output_present,
        "usage_input_tokens": turn.usage_input_tokens,
        "usage_output_tokens": turn.usage_output_tokens,
        "usage_completion_tokens": turn.usage_completion_tokens,
        "usage_total_tokens": turn.usage_total_tokens,
        "elapsed_ms": turn.elapsed_ms,
        "created_at": turn.created_at.isoformat(),
    }


def serialize_agent_run(run: AgentRun, *, event_count: int, turn_count: int) -> dict[str, Any]:
    return {
        "id": run.id,
        "project_id": run.project_id,
        "conversation_id": run.conversation_id,
        "trigger_message_id": run.trigger_message_id,
        "response_message_id": run.response_message_id,
        "status": run.status,
        "provider": run.provider,
        "model": run.model,
        "input_mode": run.input_mode,
        "system_prompt_text": run.system_prompt_text,
        "query_text": run.query_text,
        "request_json": run.request_json,
        "final_response_json": run.final_response_json,
        "final_parsed_json": run.final_parsed_json,
        "aggregated_metadata_json": run.aggregated_metadata_json,
        "usage_input_tokens": run.usage_input_tokens,
        "usage_output_tokens": run.usage_output_tokens,
        "usage_completion_tokens": run.usage_completion_tokens,
        "usage_total_tokens": run.usage_total_tokens,
        "elapsed_ms": run.elapsed_ms,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
        "error_message": run.error_message,
        "created_at": run.created_at.isoformat(),
        "event_count": event_count,
        "turn_count": turn_count,
    }


def get_agent_run(session: Session, run_id: str) -> AgentRun:
    run = session.get(AgentRun, run_id)
    if run is None:
        raise LookupError("Agent run not found.")
    return run


def list_agent_run_events(session: Session, run_id: str) -> list[AgentEventRecord]:
    get_agent_run(session, run_id)
    return list(
        session.execute(
            select(AgentEventRecord)
            .where(AgentEventRecord.agent_run_id == run_id)
            .order_by(AgentEventRecord.sequence_no.asc())
        ).scalars()
    )


def list_agent_run_turns(session: Session, run_id: str) -> list[AgentRunTurn]:
    get_agent_run(session, run_id)
    return list(
        session.execute(
            select(AgentRunTurn)
            .where(AgentRunTurn.agent_run_id == run_id)
            .order_by(AgentRunTurn.round_index.asc())
        ).scalars()
    )


def _message_to_runtime(message: MessageRecord) -> Message:
    attachments = []
    for link in message.asset_links:
        asset = link.asset
        if asset.deleted_at is not None or not asset.mime_type.startswith("image/"):
            continue
        attachments.append(
            Attachment(
                mime_type=asset.mime_type,
                content=resolve_asset_bytes(asset),
                name=asset.original_name,
            )
        )

    return Message(
        role=MessageRole(message.role),
        content=message.content_text,
        thinking=message.thinking_text,
        attachments=attachments or None,
    )


def create_message_and_run(
    session: Session,
    *,
    conversation_id: str,
    model: str,
    thinking_level: ThinkingLevel,
    input_mode: InputMode,
    content_text: str,
    asset_ids: list[str],
) -> tuple[MessageRecord, AgentRun]:
    if input_mode != InputMode.TEXT:
        raise ValueError("Only text input mode is supported in this slice.")

    conversation = get_conversation(session, conversation_id)
    project = session.get(Project, conversation.project_id)
    if project is None:
        raise LookupError("Conversation project not found.")

    assets = get_project_assets_by_ids(session, conversation.project_id, asset_ids)
    sequence_no = next_message_sequence(session, conversation_id)
    user_message = MessageRecord(
        project_id=conversation.project_id,
        conversation_id=conversation.id,
        role=MessageRole.USER.value,
        input_mode=input_mode.value,
        content_text=content_text,
        status="queued",
        sequence_no=sequence_no,
        metadata_json={},
    )
    session.add(user_message)
    session.flush()

    for asset in assets:
        session.add(MessageAsset(message_id=user_message.id, asset_id=asset.id, relation_type="attachment"))

    run = AgentRun(
        project_id=conversation.project_id,
        conversation_id=conversation.id,
        trigger_message_id=user_message.id,
        status="queued",
        model=model,
        input_mode=input_mode.value,
        system_prompt_text=build_socrates_system_prompt(project.default_system_prompt),
        query_text=content_text,
        request_json={
            "model": model,
            "thinking_level": thinking_level.value,
            "input_mode": input_mode.value,
            "asset_ids": asset_ids,
        },
    )
    session.add(run)
    session.flush()
    user_message.agent_run_id = run.id
    conversation.updated_at = datetime.now(timezone.utc)
    session.commit()
    session.refresh(user_message)
    session.refresh(run)
    return user_message, run


class RunManager:
    def __init__(self):
        self._session_factory = get_session_factory()
        self._runner_factory = AgentRunner
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
        self._lock = asyncio.Lock()

    async def start_run(self, run_id: str) -> None:
        async with self._lock:
            task = self._tasks.get(run_id)
            if task and not task.done():
                return
            task = asyncio.create_task(self._execute_run(run_id))
            task.add_done_callback(lambda _: self._tasks.pop(run_id, None))
            self._tasks[run_id] = task

    def subscribe(self, run_id: str) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._subscribers.setdefault(run_id, set()).add(queue)
        return queue

    def unsubscribe(self, run_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        subscribers = self._subscribers.get(run_id)
        if not subscribers:
            return
        subscribers.discard(queue)
        if not subscribers:
            self._subscribers.pop(run_id, None)

    async def publish(self, run_id: str, payload: dict[str, Any]) -> None:
        for queue in list(self._subscribers.get(run_id, set())):
            await queue.put(payload)

    def replay_events(self, run_id: str) -> list[dict[str, Any]]:
        session = self._session_factory()
        try:
            records = list(
                session.execute(
                    select(AgentEventRecord)
                    .where(AgentEventRecord.agent_run_id == run_id)
                    .order_by(AgentEventRecord.sequence_no.asc())
                ).scalars()
            )
            return [record.payload_json for record in records]
        finally:
            session.close()

    def get_run_status(self, run_id: str) -> str | None:
        session = self._session_factory()
        try:
            run = session.get(AgentRun, run_id)
            return run.status if run else None
        finally:
            session.close()

    def _next_event_sequence(self, session: Session, run_id: str) -> int:
        max_seq = session.execute(
            select(func.max(AgentEventRecord.sequence_no)).where(AgentEventRecord.agent_run_id == run_id)
        ).scalar_one()
        return int(max_seq or 0) + 1

    def _ensure_turn(
        self,
        session: Session,
        run: AgentRun,
        round_index: int,
        *,
        provider: str | None = None,
        model: str | None = None,
    ) -> AgentRunTurn:
        turn = session.execute(
            select(AgentRunTurn).where(AgentRunTurn.agent_run_id == run.id, AgentRunTurn.round_index == round_index)
        ).scalars().first()
        if turn is None:
            turn = AgentRunTurn(
                agent_run_id=run.id,
                round_index=round_index,
                provider=provider,
                model=model,
                request_json=run.request_json,
            )
            session.add(turn)
            session.flush()
        return turn

    async def _record_event(
        self,
        session: Session,
        run: AgentRun,
        *,
        event_type: str,
        payload: dict[str, Any],
        turn: AgentRunTurn | None = None,
        status: str = "ok",
        content_text: str | None = None,
        thinking_text: str | None = None,
        tool_call_ref: str | None = None,
    ) -> None:
        record = AgentEventRecord(
            agent_run_id=run.id,
            agent_run_turn_id=turn.id if turn else None,
            sequence_no=self._next_event_sequence(session, run.id),
            event_type=event_type,
            status=status,
            content_text=content_text,
            thinking_text=thinking_text,
            tool_call_ref=tool_call_ref,
            payload_json=payload,
        )
        session.add(record)
        session.commit()
        await self.publish(run.id, payload)

    async def _emit_turn_started(
        self,
        session: Session,
        run: AgentRun,
        turn: AgentRunTurn,
    ) -> None:
        payload = {
            "type": "run.turn.started",
            "run_id": run.id,
            "turn_id": turn.id,
            "round_index": turn.round_index,
        }
        await self._record_event(session, run, event_type="run.turn.started", payload=payload, turn=turn)

    async def _execute_run(self, run_id: str) -> None:
        session = self._session_factory()
        seen_turns: set[int] = set()
        try:
            run = session.execute(
                select(AgentRun)
                .where(AgentRun.id == run_id)
                .options(
                    joinedload(AgentRun.messages).joinedload(MessageRecord.asset_links).joinedload(MessageAsset.asset),
                )
            ).unique().scalars().first()
            if run is None:
                return

            conversation = session.execute(
                select(Conversation)
                .where(Conversation.id == run.conversation_id)
                .options(
                    joinedload(Conversation.messages)
                    .joinedload(MessageRecord.asset_links)
                    .joinedload(MessageAsset.asset)
                )
            ).unique().scalars().first()
            project = session.get(Project, run.project_id)
            trigger_message = session.get(MessageRecord, run.trigger_message_id) if run.trigger_message_id else None
            if conversation is None or project is None or trigger_message is None:
                raise LookupError("Run context is incomplete.")

            run.status = "running"
            run.started_at = datetime.now(timezone.utc)
            run.provider = run.model.split("/", 1)[0] if "/" in run.model else "openai"
            session.commit()
            await self._record_event(
                session,
                run,
                event_type="run.started",
                payload={"type": "run.started", "run_id": run.id, "conversation_id": conversation.id},
            )

            history_records = sorted(
                [message for message in conversation.messages if message.sequence_no < trigger_message.sequence_no],
                key=lambda item: item.sequence_no,
            )
            history = [_message_to_runtime(message) for message in history_records]
            current_assets = [link.asset for link in trigger_message.asset_links if link.asset.deleted_at is None]
            attachments = [
                Attachment(
                    mime_type=asset.mime_type,
                    content=resolve_asset_bytes(asset),
                    name=asset.original_name,
                )
                for asset in current_assets
                if asset.mime_type.startswith("image/")
            ]

            request = AgentRequest(
                model=run.model,
                system_prompt=run.system_prompt_text,
                query=trigger_message.content_text or "",
                history=history,
                attachments=attachments or None,
                input_mode=InputMode(run.input_mode),
                config=GenConfig(
                    thinking=ThinkingLevel(run.request_json.get("thinking_level", ThinkingLevel.OFF.value))
                ),
            )
            runner = self._runner_factory()
            final_event: AgentEvent | None = None

            async for event in runner.stream(request):
                if event.type == AgentEventType.FINAL_RESPONSE:
                    final_event = event
                    continue

                turn = None
                if event.type != AgentEventType.ERROR:
                    turn = self._ensure_turn(
                        session,
                        run,
                        event.round_index,
                        provider=event.provider,
                        model=event.model,
                    )
                    if event.round_index not in seen_turns:
                        seen_turns.add(event.round_index)
                        await self._emit_turn_started(session, run, turn)

                if event.type == AgentEventType.THINKING and event.response and event.response.thinking:
                    await self._record_event(
                        session,
                        run,
                        event_type="run.thinking.delta",
                        payload={
                            "type": "run.thinking.delta",
                            "run_id": run.id,
                            "round_index": event.round_index,
                            "delta": event.response.thinking,
                        },
                        turn=turn,
                        thinking_text=event.response.thinking,
                    )
                elif event.type == AgentEventType.CONTENT and event.response and event.response.content:
                    await self._record_event(
                        session,
                        run,
                        event_type="run.content.delta",
                        payload={
                            "type": "run.content.delta",
                            "run_id": run.id,
                            "round_index": event.round_index,
                            "delta": event.response.content,
                        },
                        turn=turn,
                        content_text=event.response.content,
                    )
                elif event.type == AgentEventType.ERROR:
                    await self._record_event(
                        session,
                        run,
                        event_type="run.warning",
                        payload={
                            "type": "run.warning",
                            "run_id": run.id,
                            "round_index": event.round_index,
                            "message": event.error,
                        },
                        status="error",
                    )

            if final_event is None or final_event.response is None:
                raise RuntimeError("Agent run completed without a final response.")

            final_response = final_event.response
            telemetry_items = final_response.metadata.get("agent_turn_telemetry", [])
            for telemetry in telemetry_items:
                telemetry_data = to_json_compatible(telemetry)
                round_index = telemetry_data.get("round_index", 0)
                turn = self._ensure_turn(session, run, round_index, provider=final_event.provider, model=final_event.model)
                turn.phase = telemetry_data.get("phase", turn.phase)
                usage = telemetry_data.get("usage", {})
                turn.had_thinking = telemetry_data.get("had_thinking", False)
                turn.tool_call_count = telemetry_data.get("tool_call_count", 0)
                turn.parsed_output_present = telemetry_data.get("parsed_output", False)
                turn.elapsed_ms = telemetry_data.get("elapsed_ms", 0.0)
                turn.metadata_json = telemetry_data
                turn.usage_input_tokens = usage.get("input_tokens", 0)
                turn.usage_output_tokens = usage.get("output_tokens", 0)
                turn.usage_completion_tokens = usage.get("completion_tokens", 0)
                turn.usage_total_tokens = usage.get("total_tokens", 0)
                turn.response_json = to_json_compatible(final_response)
                turn.raw_dump_json = to_json_compatible(final_response.raw_dump)
                turn.parsed_output_json = to_json_compatible(final_response.parsed) if final_response.parsed else {}
                session.commit()
                await self._record_event(
                    session,
                    run,
                    event_type="run.turn.completed",
                    payload={
                        "type": "run.turn.completed",
                        "run_id": run.id,
                        "turn_id": turn.id,
                        "round_index": round_index,
                        "phase": turn.phase,
                    },
                    turn=turn,
                )

            assistant_message = MessageRecord(
                project_id=conversation.project_id,
                conversation_id=conversation.id,
                agent_run_id=run.id,
                role=MessageRole.ASSISTANT.value,
                input_mode=InputMode.TEXT.value,
                content_text=final_response.content,
                thinking_text=final_response.thinking,
                status="completed",
                sequence_no=next_message_sequence(session, conversation.id),
                provider=final_event.provider,
                model=final_event.model,
                metadata_json=to_json_compatible(final_response.metadata),
            )
            session.add(assistant_message)
            session.flush()

            run.response_message_id = assistant_message.id
            run.status = "completed"
            run.completed_at = datetime.now(timezone.utc)
            run.final_response_json = to_json_compatible(final_response)
            run.final_parsed_json = to_json_compatible(final_response.parsed) if final_response.parsed else {}
            run.aggregated_metadata_json = to_json_compatible(final_response.metadata)
            usage = final_response.metadata.get("agent_usage", final_response.usage)
            usage_data = to_json_compatible(usage)
            run.usage_input_tokens = usage_data.get("input_tokens", 0)
            run.usage_output_tokens = usage_data.get("output_tokens", 0)
            run.usage_completion_tokens = usage_data.get("completion_tokens", 0)
            run.usage_total_tokens = usage_data.get("total_tokens", 0)
            run.elapsed_ms = final_response.metadata.get("agent_elapsed_ms", 0.0)
            trigger_message.status = "completed"
            conversation.updated_at = datetime.now(timezone.utc)
            session.commit()

            await self._record_event(
                session,
                run,
                event_type="run.message.completed",
                payload={
                    "type": "run.message.completed",
                    "run_id": run.id,
                    "message": serialize_message(assistant_message),
                },
                content_text=assistant_message.content_text,
                thinking_text=assistant_message.thinking_text,
            )
            await self._record_event(
                session,
                run,
                event_type="run.completed",
                payload={
                    "type": "run.completed",
                    "run_id": run.id,
                    "response_message_id": assistant_message.id,
                },
            )
        except Exception as exc:
            session.rollback()
            run = session.get(AgentRun, run_id)
            if run is not None:
                run.status = "failed"
                run.completed_at = datetime.now(timezone.utc)
                run.error_message = str(exc)
                trigger_message = session.get(MessageRecord, run.trigger_message_id) if run.trigger_message_id else None
                if trigger_message is not None:
                    trigger_message.status = "failed"
                    trigger_message.failed_at = datetime.now(timezone.utc)
                session.commit()
                await self._record_event(
                    session,
                    run,
                    event_type="run.failed",
                    payload={"type": "run.failed", "run_id": run.id, "error": str(exc)},
                    status="error",
                )
        finally:
            session.close()
