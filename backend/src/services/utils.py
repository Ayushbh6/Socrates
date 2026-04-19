from __future__ import annotations

import base64
from collections.abc import Iterable
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel


def to_json_compatible(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return to_json_compatible(value.model_dump(mode="python"))
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        data = bytes(value)
        return {
            "type": "bytes",
            "length": len(data),
            "base64": base64.b64encode(data).decode("ascii"),
        }
    if isinstance(value, dict):
        return {key: to_json_compatible(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_json_compatible(item) for item in value]
    return value


def apply_updates(instance: Any, values: dict[str, Any]) -> Any:
    for key, value in values.items():
        if value is not None:
            setattr(instance, key, value)
    return instance


def first(items: Iterable[Any]) -> Any | None:
    for item in items:
        return item
    return None
