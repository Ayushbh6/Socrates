import pytest
from unittest.mock import MagicMock, patch
from pathlib import Path
from datetime import datetime, timezone
from backend.src.tools.system_time import get_system_time
from backend.src.tools.list_resources import make_list_resources
from backend.src.tools.read_resource import make_read_resource


@pytest.fixture
def mock_db():
    return MagicMock()


@pytest.fixture
def mock_asset():
    asset = MagicMock()
    asset.project_id = "p1"
    asset.original_name = "test.txt"
    asset.storage_path = "p1/test.txt"
    asset.kind = "text"
    asset.size_bytes = 100
    asset.created_at = datetime(2026, 4, 19, tzinfo=timezone.utc)
    asset.deleted_at = None
    return asset


def test_get_system_time():
    result = get_system_time()
    assert "timestamp" in result
    assert "weekday" in result
    assert result["timezone"] == "UTC"


def test_list_resources(mock_db, mock_asset):
    mock_db.query().filter().all.return_value = [mock_asset]
    tool = make_list_resources(mock_db, "p1")
    result = tool()
    assert len(result) == 1
    assert result[0]["filename"] == "test.txt"


def test_read_resource_not_found(mock_db):
    mock_db.query().filter().first.return_value = None
    tool = make_read_resource(mock_db, "p1", Path("/tmp"))
    result = tool("missing.txt")
    import json

    data = json.loads(result)
    assert data["ok"] is False
    assert data["error_type"] == "file_not_found"


def test_read_resource_success(mock_db, mock_asset, tmp_path):
    # Setup mock file
    file_dir = tmp_path / "p1"
    file_dir.mkdir()
    file_path = file_dir / "test.txt"
    file_path.write_text("Hello Socrates")

    mock_db.query().filter().first.return_value = mock_asset
    tool = make_read_resource(mock_db, "p1", tmp_path)
    result = tool("test.txt")

    assert result["filename"] == "test.txt"
    assert result["content"] == "Hello Socrates"
