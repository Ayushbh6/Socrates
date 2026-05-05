import json

from backend.src.core.settings import get_settings
from backend.src.services.python_runtime import (
    ensure_managed_python_runtime,
    get_venv_python_path,
    inspect_managed_python_runtime,
)
from backend.src.services.tasks import ensure_project_venv, get_project_venv_path


def test_managed_python_runtime_reports_missing_runtime(monkeypatch, tmp_path):
    monkeypatch.setenv("SOCRATES_HOME", str(tmp_path / ".socrates"))
    monkeypatch.delenv("APP_DATA_DIR", raising=False)

    status = inspect_managed_python_runtime()

    assert status.venv_path == tmp_path / ".socrates" / "runtime" / "python" / "venv"
    assert status.python_path == get_venv_python_path(status.venv_path)
    assert status.exists is False
    assert status.valid is False


def test_ensure_managed_python_runtime_creates_single_runtime(monkeypatch, tmp_path):
    monkeypatch.setenv("SOCRATES_HOME", str(tmp_path / ".socrates"))
    monkeypatch.delenv("APP_DATA_DIR", raising=False)

    status = ensure_managed_python_runtime()

    assert status.venv_path == tmp_path / ".socrates" / "runtime" / "python" / "venv"
    assert (status.venv_path / "pyvenv.cfg").exists()
    assert status.python_path.exists()
    assert status.valid is True
    assert status.version is not None

    metadata = json.loads(status.metadata_path.read_text(encoding="utf-8"))
    assert metadata["venv_path"] == str(status.venv_path)
    assert metadata["python_path"] == str(status.python_path)
    assert metadata["valid"] is True


def test_project_venv_helpers_use_managed_python_runtime(monkeypatch, tmp_path):
    monkeypatch.setenv("SOCRATES_HOME", str(tmp_path / ".socrates"))
    monkeypatch.delenv("APP_DATA_DIR", raising=False)

    settings = get_settings()
    project_id = "project-1"

    assert get_project_venv_path(project_id) == settings.socrates_python_venv
    assert ensure_project_venv(project_id) == settings.socrates_python_venv
    assert (settings.socrates_python_venv / "pyvenv.cfg").exists()
    assert not (settings.projects_dir / project_id / ".venv").exists()
