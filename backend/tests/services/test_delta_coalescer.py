from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

import pytest

from backend.src.services.chat import (
    _DELTA_KIND_CONTENT,
    _DELTA_KIND_THINKING,
    _DeltaCoalescer,
)


@dataclass
class _FakeRun:
    id: str = "run-test"


@dataclass
class _FakeTurn:
    id: str = "turn-test"
    round_index: int = 0


@dataclass
class _RecordedEvent:
    event_type: str
    payload: dict[str, Any]
    turn: _FakeTurn | None
    content_text: str | None
    thinking_text: str | None


@dataclass
class _RecorderStub:
    recorded: list[_RecordedEvent] = field(default_factory=list)

    async def record(
        self,
        _session: Any,
        _run: _FakeRun,
        *,
        event_type: str,
        payload: dict[str, Any],
        turn: _FakeTurn | None = None,
        status: str = "ok",
        content_text: str | None = None,
        thinking_text: str | None = None,
        tool_call_ref: str | None = None,
    ) -> None:
        del status, tool_call_ref
        self.recorded.append(
            _RecordedEvent(
                event_type=event_type,
                payload=payload,
                turn=turn,
                content_text=content_text,
                thinking_text=thinking_text,
            )
        )


def _build(flush_ms: int = 60, flush_chars: int = 80) -> tuple[_DeltaCoalescer, _RecorderStub]:
    recorder = _RecorderStub()
    coalescer = _DeltaCoalescer(
        record_event=recorder.record,
        flush_ms=flush_ms,
        flush_chars=flush_chars,
    )
    return coalescer, recorder


@pytest.mark.asyncio
async def test_coalescer_merges_small_content_deltas_within_window():
    coalescer, recorder = _build(flush_ms=10_000, flush_chars=1000)
    run = _FakeRun()
    turn = _FakeTurn(round_index=0)

    for chunk in ("He", "llo, ", "Soc", "rates."):
        await coalescer.feed(
            None,
            run,
            kind=_DELTA_KIND_CONTENT,
            round_index=0,
            turn=turn,
            delta=chunk,
        )

    assert recorder.recorded == []

    await coalescer.flush(None, run)

    assert len(recorder.recorded) == 1
    event = recorder.recorded[0]
    assert event.event_type == "run.content.delta"
    assert event.payload["delta"] == "Hello, Socrates."
    assert event.payload["round_index"] == 0
    assert event.content_text == "Hello, Socrates."
    assert event.turn is turn


@pytest.mark.asyncio
async def test_coalescer_flushes_when_char_threshold_reached():
    coalescer, recorder = _build(flush_ms=10_000, flush_chars=10)
    run = _FakeRun()
    turn = _FakeTurn()

    await coalescer.feed(None, run, kind=_DELTA_KIND_CONTENT, round_index=0, turn=turn, delta="12345")
    assert recorder.recorded == []

    await coalescer.feed(None, run, kind=_DELTA_KIND_CONTENT, round_index=0, turn=turn, delta="6789AB")
    assert len(recorder.recorded) == 1
    assert recorder.recorded[0].payload["delta"] == "123456789AB"

    await coalescer.flush(None, run)
    assert len(recorder.recorded) == 1


@pytest.mark.asyncio
async def test_coalescer_flushes_when_time_threshold_reached():
    coalescer, recorder = _build(flush_ms=5, flush_chars=10_000)
    run = _FakeRun()
    turn = _FakeTurn()

    await coalescer.feed(None, run, kind=_DELTA_KIND_CONTENT, round_index=0, turn=turn, delta="short")
    await asyncio.sleep(0.02)
    await coalescer.feed(None, run, kind=_DELTA_KIND_CONTENT, round_index=0, turn=turn, delta=" answer")

    assert len(recorder.recorded) == 1
    assert recorder.recorded[0].payload["delta"] == "short answer"


@pytest.mark.asyncio
async def test_coalescer_flushes_on_kind_change():
    coalescer, recorder = _build(flush_ms=10_000, flush_chars=10_000)
    run = _FakeRun()
    turn = _FakeTurn()

    await coalescer.feed(None, run, kind=_DELTA_KIND_THINKING, round_index=0, turn=turn, delta="thinking part")
    await coalescer.feed(None, run, kind=_DELTA_KIND_CONTENT, round_index=0, turn=turn, delta="content part")
    await coalescer.flush(None, run)

    kinds = [event.event_type for event in recorder.recorded]
    assert kinds == ["run.thinking.delta", "run.content.delta"]
    assert recorder.recorded[0].payload["delta"] == "thinking part"
    assert recorder.recorded[0].thinking_text == "thinking part"
    assert recorder.recorded[0].content_text is None
    assert recorder.recorded[1].payload["delta"] == "content part"
    assert recorder.recorded[1].content_text == "content part"
    assert recorder.recorded[1].thinking_text is None


@pytest.mark.asyncio
async def test_coalescer_flushes_on_round_index_change():
    coalescer, recorder = _build(flush_ms=10_000, flush_chars=10_000)
    run = _FakeRun()
    turn_a = _FakeTurn(id="turn-a", round_index=0)
    turn_b = _FakeTurn(id="turn-b", round_index=1)

    await coalescer.feed(None, run, kind=_DELTA_KIND_CONTENT, round_index=0, turn=turn_a, delta="round-0")
    await coalescer.feed(None, run, kind=_DELTA_KIND_CONTENT, round_index=1, turn=turn_b, delta="round-1")
    await coalescer.flush(None, run)

    assert [event.payload["round_index"] for event in recorder.recorded] == [0, 1]
    assert [event.payload["delta"] for event in recorder.recorded] == ["round-0", "round-1"]
    assert recorder.recorded[0].turn is turn_a
    assert recorder.recorded[1].turn is turn_b


@pytest.mark.asyncio
async def test_coalescer_flush_on_empty_buffer_is_noop():
    coalescer, recorder = _build()
    run = _FakeRun()

    await coalescer.flush(None, run)
    await coalescer.flush(None, run)

    assert recorder.recorded == []


@pytest.mark.asyncio
async def test_coalescer_ignores_empty_deltas():
    coalescer, recorder = _build(flush_ms=10_000, flush_chars=10_000)
    run = _FakeRun()
    turn = _FakeTurn()

    await coalescer.feed(None, run, kind=_DELTA_KIND_CONTENT, round_index=0, turn=turn, delta="")
    await coalescer.flush(None, run)

    assert recorder.recorded == []


@pytest.mark.asyncio
async def test_coalescer_preserves_full_text_across_many_small_chunks():
    coalescer, recorder = _build(flush_ms=2, flush_chars=4)
    run = _FakeRun()
    turn = _FakeTurn()
    source = "Socrates is a calm, rigorous, reflective guide for careful thought. " * 5

    for char in source:
        await coalescer.feed(None, run, kind=_DELTA_KIND_CONTENT, round_index=0, turn=turn, delta=char)
    await coalescer.flush(None, run)

    reassembled = "".join(event.payload["delta"] for event in recorder.recorded)
    assert reassembled == source
    assert len(recorder.recorded) < len(source)
