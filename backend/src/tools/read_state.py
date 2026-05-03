from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import threading


@dataclass(frozen=True)
class FileReadRecord:
    key: str
    sha256: str


class RunReadState:
    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._records: dict[str, FileReadRecord] = {}

    def record(self, *, key: str, sha256: str) -> None:
        with self._guard:
            self._records[key] = FileReadRecord(key=key, sha256=sha256)

    def get_sha256(self, key: str) -> str | None:
        with self._guard:
            record = self._records.get(key)
            return record.sha256 if record is not None else None

    def has_read(self, key: str) -> bool:
        return self.get_sha256(key) is not None

    def forget(self, key: str) -> None:
        with self._guard:
            self._records.pop(key, None)


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    import hashlib

    content = path.read_text(encoding="utf-8", errors="replace")
    return hashlib.sha256(content.encode("utf-8")).hexdigest()
