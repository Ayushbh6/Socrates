from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..core.settings import Settings, get_settings


@dataclass(frozen=True)
class ManagedPythonRuntime:
    venv_path: Path
    python_path: Path
    metadata_path: Path
    exists: bool
    valid: bool
    version: str | None = None
    error: str | None = None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_venv_python_path(venv_path: Path) -> Path:
    if sys.platform.startswith("win") or (venv_path / "Scripts").exists():
        return venv_path / "Scripts" / "python.exe"
    return venv_path / "bin" / "python"


def get_runtime_metadata_path(settings: Settings | None = None) -> Path:
    resolved_settings = settings or get_settings()
    return resolved_settings.socrates_runtime_dir / "python" / "runtime.json"


def inspect_managed_python_runtime(settings: Settings | None = None) -> ManagedPythonRuntime:
    resolved_settings = settings or get_settings()
    venv_path = resolved_settings.socrates_python_venv
    python_path = get_venv_python_path(venv_path)
    metadata_path = get_runtime_metadata_path(resolved_settings)
    exists = (venv_path / "pyvenv.cfg").exists()
    valid = exists and python_path.exists()
    version: str | None = None
    error: str | None = None

    if valid:
        try:
            result = subprocess.run(
                [str(python_path), "--version"],
                check=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
            version = (result.stdout or result.stderr).strip()
        except (OSError, subprocess.SubprocessError) as exc:
            valid = False
            error = str(exc)

    return ManagedPythonRuntime(
        venv_path=venv_path,
        python_path=python_path,
        metadata_path=metadata_path,
        exists=exists,
        valid=valid,
        version=version,
        error=error,
    )


def ensure_managed_python_runtime(settings: Settings | None = None) -> ManagedPythonRuntime:
    resolved_settings = settings or get_settings()
    status = inspect_managed_python_runtime(resolved_settings)
    if not status.valid:
        status.venv_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.run(
                [sys.executable, "-m", "venv", str(status.venv_path)],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr.strip() if exc.stderr else str(exc)
            raise RuntimeError(f"Failed to create Socrates Python runtime: {stderr}") from exc

        status = inspect_managed_python_runtime(resolved_settings)
        if not status.valid:
            raise RuntimeError(status.error or "Socrates Python runtime was created but is not executable.")

    _write_runtime_metadata(status)
    return status


def _write_runtime_metadata(status: ManagedPythonRuntime) -> None:
    status.metadata_path.parent.mkdir(parents=True, exist_ok=True)
    status.metadata_path.write_text(
        json.dumps(
            {
                "venv_path": str(status.venv_path),
                "python_path": str(status.python_path),
                "valid": status.valid,
                "version": status.version,
                "checked_at": _utc_now_iso(),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
