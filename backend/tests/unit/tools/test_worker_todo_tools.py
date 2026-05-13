from types import SimpleNamespace
import json

from backend.src.tools import skip_todo_item, update_current_todo_item


class FakeRuntime:
    def __init__(self, task_root):
        self.task_root = task_root
        self.synced = False

    def _require_task(self):
        return SimpleNamespace(workspace_root=str(self.task_root))

    def _sync_task_outputs_if_needed(self):
        self.synced = True


def write_todo(tmp_path, body: str):
    (tmp_path / "todo.md").write_text(body, encoding="utf-8")


def error_payload(result):
    return json.loads(result) if isinstance(result, str) else result


def test_update_current_todo_item_claims_first_pending_and_returns_next(tmp_path):
    write_todo(tmp_path, "# Todo\n\n## Checklist\n- [ ] T1: First\n- [ ] T2: Second\n")
    runtime = FakeRuntime(tmp_path)

    result = update_current_todo_item.handle(runtime, status="in_progress")

    assert result["item"]["id"] == "T1"
    assert result["item"]["status"] == "in_progress"
    assert result["next_item"]["id"] == "T2"
    assert result["done"] is False
    assert runtime.synced is True


def test_update_current_todo_item_completes_current_with_evidence_and_returns_next(tmp_path):
    write_todo(
        tmp_path,
        "# Todo\n\n## Checklist\n- [ ] T1: First\n  - Status: in_progress\n- [ ] T2: Second\n",
    )
    runtime = FakeRuntime(tmp_path)

    result = update_current_todo_item.handle(
        runtime,
        status="completed",
        evidence={"changed_paths": ["outputs/result.txt"]},
    )

    assert result["item"]["id"] == "T1"
    assert result["item"]["status"] == "completed"
    assert result["next_item"]["id"] == "T2"
    assert "- [x] T1: First" in (tmp_path / "todo.md").read_text(encoding="utf-8")
    assert "Evidence:" in (tmp_path / "todo.md").read_text(encoding="utf-8")


def test_update_current_todo_item_rejects_completion_without_in_progress(tmp_path):
    write_todo(tmp_path, "# Todo\n\n## Checklist\n- [ ] T1: First\n")

    result = update_current_todo_item.handle(
        FakeRuntime(tmp_path),
        status="completed",
        evidence="done",
    )

    payload = error_payload(result)
    assert payload["ok"] is False
    assert payload["error_type"] == "todo_current_item_required"


def test_update_current_todo_item_blocks_with_reason_and_recommended_action(tmp_path):
    write_todo(
        tmp_path,
        "# Todo\n\n## Checklist\n- [ ] T1: First\n  - Status: in_progress\n",
    )

    missing_action = update_current_todo_item.handle(
        FakeRuntime(tmp_path),
        status="blocked",
        reason="Need credentials.",
    )
    payload = error_payload(missing_action)
    assert payload["ok"] is False
    assert payload["error_type"] == "todo_block_recommended_action_required"

    result = update_current_todo_item.handle(
        FakeRuntime(tmp_path),
        status="blocked",
        reason="Need credentials.",
        recommended_action="Ask the user for credentials.",
    )

    assert result["item"]["status"] == "blocked"
    assert result["item"]["recommended_action"] == "Ask the user for credentials."


def test_skip_todo_item_requires_reason_and_returns_next(tmp_path):
    write_todo(tmp_path, "# Todo\n\n## Checklist\n- [ ] T1: First\n- [ ] T2: Second\n")

    missing_reason = skip_todo_item.handle(FakeRuntime(tmp_path), reason=" ")
    payload = error_payload(missing_reason)
    assert payload["ok"] is False
    assert payload["error_type"] == "todo_skip_reason_required"

    result = skip_todo_item.handle(
        FakeRuntime(tmp_path),
        reason="T2 already covers this.",
    )

    assert result["item"]["id"] == "T1"
    assert result["item"]["status"] == "skipped"
    assert result["next_item"]["id"] == "T2"


def test_skip_todo_item_rejects_non_current_todo_id(tmp_path):
    write_todo(tmp_path, "# Todo\n\n## Checklist\n- [ ] T1: First\n- [ ] T2: Second\n")

    result = skip_todo_item.handle(
        FakeRuntime(tmp_path),
        todo_id="T2",
        reason="Trying to skip ahead.",
    )

    payload = error_payload(result)
    assert payload["ok"] is False
    assert payload["error_type"] == "todo_item_not_current"
    assert "current item is T1" in payload["message"]


def test_skip_todo_item_skips_in_progress_item_before_pending(tmp_path):
    write_todo(
        tmp_path,
        "# Todo\n\n## Checklist\n- [ ] T1: First\n  - Status: in_progress\n- [ ] T2: Second\n",
    )

    result = skip_todo_item.handle(
        FakeRuntime(tmp_path),
        reason="Covered by earlier implementation.",
    )

    assert result["item"]["id"] == "T1"
    assert result["item"]["status"] == "skipped"
    assert result["next_item"]["id"] == "T2"
