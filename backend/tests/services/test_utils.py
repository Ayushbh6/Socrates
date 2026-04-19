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