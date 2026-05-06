from pathlib import Path

from backend.src.agents import SOCRATES_BASE_PROMPT, build_socrates_system_prompt
from backend.src.core.settings import get_settings
from backend.src.services.tasks import _host_visible_task_workspace_root


def test_settings_resolve_app_data_defaults(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "premchat-data"))

    settings = get_settings()

    assert settings.socrates_home == tmp_path / "premchat-data"
    assert settings.app_data_dir == tmp_path / "premchat-data"
    assert settings.uploads_dir == tmp_path / "premchat-data" / "files" / "uploads"
    assert settings.logs_dir == tmp_path / "premchat-data" / "logs"
    assert settings.cache_dir == tmp_path / "premchat-data" / "cache"
    assert settings.projects_dir == tmp_path / "premchat-data" / "projects"
    assert settings.socrates_runtime_dir == tmp_path / "premchat-data" / "runtime"
    assert settings.socrates_python_venv == tmp_path / "premchat-data" / "runtime" / "python" / "venv"
    assert settings.database_url.endswith("premchat.db")


def test_settings_resolve_default_home_to_socrates(monkeypatch, tmp_path):
    monkeypatch.delenv("APP_DATA_DIR", raising=False)
    monkeypatch.delenv("SOCRATES_HOME", raising=False)
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path / "home"))

    settings = get_settings()

    assert settings.socrates_home == tmp_path / "home" / ".socrates"
    assert settings.app_data_dir == tmp_path / "home" / ".socrates"
    assert settings.database_url == f"sqlite:///{tmp_path / 'home' / '.socrates' / 'data' / 'premchat.db'}"
    assert settings.uploads_dir == tmp_path / "home" / ".socrates" / "files" / "uploads"
    assert settings.logs_dir == tmp_path / "home" / ".socrates" / "logs"
    assert settings.cache_dir == tmp_path / "home" / ".socrates" / "cache"
    assert settings.projects_dir == tmp_path / "home" / ".socrates" / "projects"
    assert settings.socrates_runtime_dir == tmp_path / "home" / ".socrates" / "runtime"
    assert settings.socrates_python_venv == tmp_path / "home" / ".socrates" / "runtime" / "python" / "venv"


def test_settings_resolve_socrates_home_override(monkeypatch, tmp_path):
    monkeypatch.delenv("APP_DATA_DIR", raising=False)
    monkeypatch.setenv("SOCRATES_HOME", str(tmp_path / ".socrates"))

    settings = get_settings()

    assert settings.socrates_home == tmp_path / ".socrates"
    assert settings.app_data_dir == tmp_path / ".socrates"
    assert settings.uploads_dir == tmp_path / ".socrates" / "files" / "uploads"
    assert settings.logs_dir == tmp_path / ".socrates" / "logs"
    assert settings.cache_dir == tmp_path / ".socrates" / "cache"
    assert settings.projects_dir == tmp_path / ".socrates" / "projects"
    assert settings.socrates_runtime_dir == tmp_path / ".socrates" / "runtime"
    assert settings.socrates_python_venv == tmp_path / ".socrates" / "runtime" / "python" / "venv"


def test_settings_resolve_socrates_overrides(monkeypatch, tmp_path):
    monkeypatch.setenv("SOCRATES_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("SOCRATES_HOME_HOST", str(tmp_path / "host-home"))
    monkeypatch.setenv("SOCRATES_RUNTIME_DIR", str(tmp_path / "runtime"))
    monkeypatch.setenv("SOCRATES_PROJECTS_DIR", str(tmp_path / "projects"))
    monkeypatch.setenv("SOCRATES_PYTHON_VENV", str(tmp_path / "python-venv"))

    settings = get_settings()

    assert settings.socrates_home == tmp_path / "home"
    assert settings.socrates_home_host == tmp_path / "host-home"
    assert settings.app_data_host_dir == tmp_path / "host-home"
    assert settings.socrates_runtime_dir == tmp_path / "runtime"
    assert settings.projects_dir == tmp_path / "projects"
    assert settings.socrates_python_venv == tmp_path / "python-venv"


def test_host_visible_task_workspace_root_uses_socrates_home(monkeypatch, tmp_path):
    monkeypatch.setenv("SOCRATES_HOME", str(tmp_path / "container-home"))
    monkeypatch.setenv("SOCRATES_HOME_HOST", str(tmp_path / "host-home"))

    task = type(
        "TaskStub",
        (),
        {
            "workspace_root": str(
                tmp_path
                / "container-home"
                / "projects"
                / "project-1"
                / "tasks"
                / "task-1"
            )
        },
    )()

    assert _host_visible_task_workspace_root(task) == str(
        tmp_path / "host-home" / "projects" / "project-1" / "tasks" / "task-1"
    )


def test_socrates_prompt_appends_project_instructions():
    prompt = build_socrates_system_prompt("Focus on finance research.")

    assert SOCRATES_BASE_PROMPT.strip() in prompt
    assert "Project-specific instructions" in prompt
    assert "Focus on finance research." in prompt
