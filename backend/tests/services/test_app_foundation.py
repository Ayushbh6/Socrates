from backend.src.agents import SOCRATES_BASE_PROMPT, build_socrates_system_prompt
from backend.src.core.settings import get_settings


def test_settings_resolve_app_data_defaults(monkeypatch, tmp_path):
    monkeypatch.setenv("APP_DATA_DIR", str(tmp_path / "premchat-data"))

    settings = get_settings()

    assert settings.app_data_dir == tmp_path / "premchat-data"
    assert settings.uploads_dir == tmp_path / "premchat-data" / "files" / "uploads"
    assert settings.logs_dir == tmp_path / "premchat-data" / "logs"
    assert settings.cache_dir == tmp_path / "premchat-data" / "cache"
    assert settings.database_url.endswith("premchat.db")


def test_socrates_prompt_appends_project_instructions():
    prompt = build_socrates_system_prompt("Focus on finance research.")

    assert SOCRATES_BASE_PROMPT.strip() in prompt
    assert "Project-specific instructions" in prompt
    assert "Focus on finance research." in prompt
