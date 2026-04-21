from __future__ import annotations

import base64
import math
from collections.abc import Iterable
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Any
from uuid import UUID

from pydantic import BaseModel


_JSON_PRIMITIVES = (str, bool, int, type(None))


def to_json_compatible(value: Any) -> Any:
    """Normalize arbitrary Python values into a JSON-safe tree.

    Guarantees the returned tree can be serialized by `json.dumps` with default
    settings and transmitted via `websocket.send_json` without raising. Types
    that cannot round-trip through JSON (NaN, Infinity, bytes, Decimal, UUID,
    datetime, Path, Enum, Pydantic models) are converted to lossless, explicit
    representations. Truly unknown objects fall back to `repr(...)` rather than
    raising, so a bug in one tool result can never kill a live WebSocket.
    """

    if isinstance(value, _JSON_PRIMITIVES):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, BaseModel):
        return to_json_compatible(value.model_dump(mode="python"))
    if isinstance(value, Enum):
        return to_json_compatible(value.value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Decimal):
        try:
            as_float = float(value)
        except (OverflowError, ValueError):
            return str(value)
        if math.isnan(as_float) or math.isinf(as_float):
            return str(value)
        return as_float
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        data = bytes(value)
        return {
            "type": "bytes",
            "length": len(data),
            "base64": base64.b64encode(data).decode("ascii"),
        }
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        for key, item in value.items():
            normalized_key = key if isinstance(key, str) else str(key)
            normalized[normalized_key] = to_json_compatible(item)
        return normalized
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_json_compatible(item) for item in value]
    try:
        return repr(value)
    except Exception:  # pragma: no cover - last-resort fallback
        return f"<unserializable {type(value).__name__}>"


def apply_updates(instance: Any, values: dict[str, Any]) -> Any:
    for key, value in values.items():
        if value is not None:
            setattr(instance, key, value)
    return instance


def first(items: Iterable[Any]) -> Any | None:
    for item in items:
        return item
    return None
