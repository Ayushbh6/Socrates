import pytest
from unittest.mock import MagicMock, patch
from pathlib import Path
from datetime import datetime, timezone
from backend.src.tools.system_time import get_system_time
from backend.src.tools.list_resources import make_list_resources
from backend.src.tools.read_resource import make_read_resource
from backend.src.tools.search_resources import make_search_resources
from backend.src.tools.python_interpreter import make_python_interpreter

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

def test_python_interpreter_blocked_import(tmp_path):
    tool = make_python_interpreter("p1", tmp_path)
    result = tool("import os\nos.system('ls')")
    import json
    data = json.loads(result)
    assert data["ok"] is False
    assert data["error_type"] == "security_violation"

def test_python_interpreter_success(tmp_path):
    tool = make_python_interpreter("p1", tmp_path)
    result = tool("print(1 + 1)")
    assert result["success"] is True
    assert result["stdout"].strip() == "2"

def test_search_resources_success(mock_db, mock_asset, tmp_path):
    # Setup mock file
    file_dir = tmp_path / "p1"
    file_dir.mkdir()
    file_path = file_dir / "test.txt"
    file_path.write_text("The unexamined life is not worth living.\nWisdom begins in wonder.")
    
    mock_db.query().filter().all.return_value = [mock_asset]
    tool = make_search_resources(mock_db, "p1", tmp_path)
    result = tool(query="Wisdom")
    
    assert result["match_count"] == 1
    assert "wonder" in result["matches"][0]["match"]
