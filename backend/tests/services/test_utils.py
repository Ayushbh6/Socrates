import json
import math
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from uuid import UUID

from pydantic import BaseModel

from backend.src.services.utils import to_json_compatible


class _BinaryPayload(BaseModel):
    raw_dump: dict[str, object]


def test_to_json_compatible_serializes_bytes_inside_pydantic_models():
    payload = _BinaryPayload(raw_dump={"blob": b"\xff\xd6binary"})

    result = to_json_compatible(payload)

    assert result == {
        "raw_dump": {
            "blob": {
                "type": "bytes",
                "length": 8,
                "base64": "/9ZiaW5hcnk=",
            }
        }
    }


def test_to_json_compatible_replaces_nan_and_infinity_with_none():
    payload = {
        "nan": float("nan"),
        "pos_inf": float("inf"),
        "neg_inf": float("-inf"),
        "finite": 3.14,
    }

    result = to_json_compatible(payload)

    assert result["nan"] is None
    assert result["pos_inf"] is None
    assert result["neg_inf"] is None
    assert result["finite"] == 3.14
    # The normalized tree must survive json.dumps with default (strict) settings.
    json.dumps(result, allow_nan=False)


def test_to_json_compatible_handles_decimal_uuid_path_and_date():
    uid = UUID("12345678-1234-5678-1234-567812345678")
    moment = datetime(2026, 4, 21, 10, 30, tzinfo=timezone.utc)
    today = date(2026, 4, 21)
    payload = {
        "price": Decimal("19.99"),
        "user_id": uid,
        "log_path": Path("/tmp/run.log"),
        "created_at": moment,
        "today": today,
    }

    result = to_json_compatible(payload)

    assert result["price"] == 19.99
    assert result["user_id"] == str(uid)
    assert result["log_path"] == "/tmp/run.log"
    assert result["created_at"] == moment.isoformat()
    assert result["today"] == today.isoformat()
    json.dumps(result, allow_nan=False)


def test_to_json_compatible_falls_back_to_repr_for_unknown_objects():
    class _OpaqueThing:
        def __repr__(self) -> str:
            return "<OpaqueThing:42>"

    payload = {"thing": _OpaqueThing()}

    result = to_json_compatible(payload)

    assert result == {"thing": "<OpaqueThing:42>"}
    json.dumps(result, allow_nan=False)


def test_to_json_compatible_normalizes_non_string_dict_keys():
    payload = {1: "int-key", (2, 3): "tuple-key"}

    result = to_json_compatible(payload)

    assert set(result.keys()) == {"1", "(2, 3)"}
    json.dumps(result, allow_nan=False)


def test_to_json_compatible_handles_set_and_frozenset():
    result = to_json_compatible({"tags": {"alpha", "beta"}, "frozen": frozenset({"gamma"})})

    assert sorted(result["tags"]) == ["alpha", "beta"]
    assert result["frozen"] == ["gamma"]


def test_to_json_compatible_deeply_nested_payload_is_json_safe():
    payload = {
        "list": [float("nan"), Decimal("1.5"), {"key": b"abc"}],
        "tuple": (1, UUID("00000000-0000-0000-0000-000000000001")),
        "nested": {"floats": [math.inf, -math.inf]},
    }

    result = to_json_compatible(payload)

    # Every leaf must be JSON-serializable in strict mode.
    json.dumps(result, allow_nan=False)
    assert result["list"][0] is None
    assert result["list"][1] == 1.5
    assert result["list"][2] == {"key": {"type": "bytes", "length": 3, "base64": "YWJj"}}
    assert result["tuple"][0] == 1
    assert result["tuple"][1] == "00000000-0000-0000-0000-000000000001"
    assert result["nested"]["floats"] == [None, None]