from __future__ import annotations

from contextlib import contextmanager
import threading
from typing import Iterator


class KeyedLockRegistry:
    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locks: dict[str, threading.RLock] = {}

    def _lock_for(self, key: str) -> threading.RLock:
        with self._guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.RLock()
                self._locks[key] = lock
            return lock

    @contextmanager
    def acquire(self, keys: set[str] | tuple[str, ...] | list[str]) -> Iterator[None]:
        ordered = sorted(set(keys))
        acquired: list[threading.RLock] = []
        try:
            for key in ordered:
                lock = self._lock_for(key)
                lock.acquire()
                acquired.append(lock)
            yield
        finally:
            for lock in reversed(acquired):
                lock.release()


GLOBAL_TOOL_LOCKS = KeyedLockRegistry()
