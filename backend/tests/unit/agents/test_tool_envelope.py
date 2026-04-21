"""Unit tests for the canonical tool-result envelope enforcement.

These lock in the guarantees made by `backend.src.agent.tools.execute_tool_call`
so that no matter what a tool handler returns -- a bare string, a dict without
the canonical shape, a dict that *happens* to look like the shape, a handler
that raises, or a handler that returns NaN/Decimal/bytes -- the agent loop
always observes a serialized JSON envelope of the form
`{"ok": bool, "tool_name": str, ...}`.

This is what prevents a misbehaving tool from inadvertently burning through
`max_consecutive_failures`.
"""

from __future__ import annotations

import json
import math
from decimal import Decimal
from typing import Any, Dict

import pytest

from backend.src.agent.tools import (
    build_tool_error_result,
    build_tool_success_result,
    execute_tool_call,
)
from backend.src.core.schema import ToolCall


def _call(name: str = "demo", arguments: Dict[str, Any] | None = None) -> ToolCall:
    return ToolCall(id="c1", name=name, arguments=arguments or {})


def _parse(envelope: str) -> Dict[str, Any]:
    payload = json.loads(envelope)
    assert isinstance(payload, dict)
    assert isinstance(payload.get("ok"), bool)
    assert isinstance(payload.get("tool_name"), str) and payload["tool_name"]
    return payload


def test_builder_success_envelope_has_required_shape():
    payload = _parse(build_tool_success_result(tool_name="demo", data={"n": 1}))
    assert payload == {"ok": True, "tool_name": "demo", "data": {"n": 1}}


def test_builder_error_envelope_has_required_shape():
    payload = _parse(
        build_tool_error_result(
            tool_name="demo",
            error_type="boom",
            message="x",
            retryable=True,
            suggestion="retry",
        )
    )
    assert payload == {
        "ok": False,
        "tool_name": "demo",
        "error_type": "boom",
        "message": "x",
        "retryable": True,
        "suggestion": "retry",
    }


@pytest.mark.asyncio
async def test_handler_returning_bare_string_is_wrapped_in_envelope():
    async def run() -> str:
        return await execute_tool_call(
            _call(), tool_handlers={"demo": lambda: "just a string"}
        )

    payload = _parse(await run())
    assert payload["ok"] is True
    assert payload["data"] == "just a string"


@pytest.mark.asyncio
async def test_handler_returning_plain_dict_is_wrapped_as_data():
    async def run() -> str:
        return await execute_tool_call(
            _call(),
            tool_handlers={"demo": lambda: {"rows": [1, 2, 3]}},
        )

    payload = _parse(await run())
    assert payload["ok"] is True
    assert payload["data"] == {"rows": [1, 2, 3]}


@pytest.mark.asyncio
async def test_handler_returning_valid_envelope_dict_is_passed_through():
    async def run() -> str:
        return await execute_tool_call(
            _call(),
            tool_handlers={
                "demo": lambda: {
                    "ok": False,
                    "tool_name": "demo",
                    "error_type": "DomainError",
                    "message": "not found",
                    "retryable": False,
                }
            },
        )

    payload = _parse(await run())
    assert payload["ok"] is False
    assert payload["error_type"] == "DomainError"
    assert payload["message"] == "not found"


@pytest.mark.asyncio
async def test_handler_returning_envelope_with_wrong_tool_name_is_corrected():
    async def run() -> str:
        return await execute_tool_call(
            _call(name="demo"),
            tool_handlers={
                "demo": lambda: {"ok": True, "tool_name": "impostor", "data": 42}
            },
        )

    payload = _parse(await run())
    assert payload["tool_name"] == "demo"
    assert payload["data"] == 42


@pytest.mark.asyncio
async def test_handler_returning_pseudo_envelope_with_non_bool_ok_is_rewrapped():
    """A dict with {"ok": "true", "tool_name": "x"} is NOT a canonical envelope.

    The strict shape check requires `ok` to be a real bool, so this gets
    treated as plain data and wrapped in a success envelope. The agent loop
    would otherwise mis-read the non-bool as truthy/falsey.
    """

    async def run() -> str:
        return await execute_tool_call(
            _call(),
            tool_handlers={
                "demo": lambda: {"ok": "yes", "tool_name": "demo", "data": "hi"}
            },
        )

    payload = _parse(await run())
    assert payload["ok"] is True
    assert payload["data"] == {"ok": "yes", "tool_name": "demo", "data": "hi"}


@pytest.mark.asyncio
async def test_handler_returning_serialized_envelope_string_is_passed_through():
    envelope = build_tool_success_result(tool_name="demo", data={"v": 7})

    async def run() -> str:
        return await execute_tool_call(
            _call(), tool_handlers={"demo": lambda: envelope}
        )

    assert (await run()) == envelope


@pytest.mark.asyncio
async def test_handler_returning_json_string_without_envelope_shape_is_wrapped():
    async def run() -> str:
        return await execute_tool_call(
            _call(),
            tool_handlers={"demo": lambda: '{"foo": "bar"}'},
        )

    payload = _parse(await run())
    assert payload["ok"] is True
    assert payload["data"] == '{"foo": "bar"}'


@pytest.mark.asyncio
async def test_handler_returning_none_still_produces_valid_envelope():
    async def run() -> str:
        return await execute_tool_call(
            _call(), tool_handlers={"demo": lambda: None}
        )

    payload = _parse(await run())
    assert payload["ok"] is True
    assert payload["data"] is None


@pytest.mark.asyncio
async def test_handler_returning_non_json_safe_values_are_sanitized_not_raised():
    """NaN / Infinity / Decimal / bytes would normally crash `json.dumps`.

    Those crashes used to bubble up as `Exception` from the handler path and
    be counted as tool failures, burning through `max_consecutive_failures`.
    After Fix D, `_json_safe` coerces everything into a JSON-safe tree before
    serialization, so the envelope is still emitted successfully with `ok=True`.
    """

    payload_in = {
        "nan": float("nan"),
        "inf": math.inf,
        "neg_inf": -math.inf,
        "amount": Decimal("1.5"),
        "blob": b"hello",
    }

    async def run() -> str:
        return await execute_tool_call(
            _call(), tool_handlers={"demo": lambda: payload_in}
        )

    payload = _parse(await run())
    assert payload["ok"] is True
    data = payload["data"]
    assert data["nan"] is None
    assert data["inf"] is None
    assert data["neg_inf"] is None
    assert data["amount"] == 1.5
    assert data["blob"]["type"] == "bytes"
    assert data["blob"]["length"] == 5


@pytest.mark.asyncio
async def test_handler_raising_unexpected_exception_produces_error_envelope():
    def broken() -> str:
        raise RuntimeError("kaboom")

    payload = _parse(
        await execute_tool_call(_call(), tool_handlers={"demo": broken})
    )
    assert payload["ok"] is False
    assert payload["error_type"] == "RuntimeError"
    assert payload["message"] == "kaboom"
    assert payload["retryable"] is False


@pytest.mark.asyncio
async def test_handler_raising_type_error_is_classified_as_validation_error():
    def wrong_args(a: int, b: int) -> int:
        return a + b

    payload = _parse(
        await execute_tool_call(
            ToolCall(id="c1", name="demo", arguments={"a": 1}),
            tool_handlers={"demo": wrong_args},
        )
    )
    assert payload["ok"] is False
    assert payload["error_type"] == "validation_error"
    assert payload["retryable"] is True


@pytest.mark.asyncio
async def test_missing_handler_returns_envelope_instead_of_raising():
    payload = _parse(
        await execute_tool_call(_call(name="nope"), tool_handlers={})
    )
    assert payload["ok"] is False
    assert payload["error_type"] == "missing_tool"
    assert payload["retryable"] is False


@pytest.mark.asyncio
async def test_no_executor_or_handlers_returns_configuration_error_envelope():
    payload = _parse(await execute_tool_call(_call()))
    assert payload["ok"] is False
    assert payload["error_type"] == "missing_tool"
