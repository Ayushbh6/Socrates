from types import SimpleNamespace
import json
from pathlib import Path

from backend.src.core.schema import ToolCall
from backend.src.tools.worker_runtime import WorkerToolRuntime


class FakeBaseRuntime:
    def __init__(self, task_root: Path | None = None):
        task = SimpleNamespace(workspace_root=str(task_root)) if task_root else None
        self.context = SimpleNamespace(
            current_task=task,
            refresh_task=lambda: task,
        )
        self._command_execution_enabled = False
        self.handlers = {
            "read_file": lambda **kwargs: {"ok": True, "tool_name": "read_file", **kwargs},
            "write_file": lambda **kwargs: {"ok": True, "tool_name": "write_file", **kwargs},
            "edit_file": lambda **kwargs: {"ok": True, "tool_name": "edit_file", **kwargs},
            "apply_patch": lambda **kwargs: {"ok": True, "tool_name": "apply_patch", **kwargs},
        }
        self.definitions = []

    def execute(self, tool_call: ToolCall):
        handler = self.handlers.get(tool_call.name)
        if handler is None:
            raise AssertionError(f"missing handler for {tool_call.name}")
        return handler(**tool_call.arguments)

    def _resolve_relative_path(self, root: Path, path: str, *, allow_missing: bool):
        target = (root / path).resolve()
        target.relative_to(root.resolve())
        return target


def test_worker_runtime_rejects_supervisor_only_tools():
    runtime = WorkerToolRuntime(FakeBaseRuntime())

    payload = json.loads(
        runtime.execute(ToolCall(id="call_1", name="create_task", arguments={}))
    )

    assert payload["ok"] is False
    assert payload["error_type"] == "permission_denied"


def test_worker_runtime_blocks_generic_task_package_mutations(tmp_path):
    for name in ("task.md", "plan.md", "todo.md"):
        (tmp_path / name).write_text("x", encoding="utf-8")
    runtime = WorkerToolRuntime(FakeBaseRuntime(tmp_path))

    for tool_call in [
        ToolCall(id="write", name="write_file", arguments={"scope": "task", "path": "todo.md", "content": "x"}),
        ToolCall(id="edit", name="edit_file", arguments={"scope": "task", "path": "todo.md", "old_text": "x", "new_text": "y"}),
        ToolCall(id="patch", name="apply_patch", arguments={"scope": "task", "patch_text": "*** Begin Patch\n*** Update File: todo.md\n@@\n-x\n+y\n*** End Patch\n"}),
    ]:
        payload = json.loads(runtime.execute(tool_call))
        assert payload["ok"] is False
        assert payload["error_type"] == "permission_denied"


def test_worker_runtime_allows_reads_and_work_output_writes(tmp_path):
    (tmp_path / "todo.md").write_text("# Todo\n", encoding="utf-8")
    runtime = WorkerToolRuntime(FakeBaseRuntime(tmp_path))

    read_result = runtime.execute(
        ToolCall(id="read", name="read_file", arguments={"scope": "task", "path": "todo.md"})
    )
    work_result = runtime.execute(
        ToolCall(id="work", name="write_file", arguments={"scope": "task", "path": "work/notes.txt", "content": "x"})
    )
    output_result = runtime.execute(
        ToolCall(id="output", name="write_file", arguments={"scope": "task", "path": "outputs/result.txt", "content": "x"})
    )

    assert read_result["ok"] is True
    assert work_result["ok"] is True
    assert output_result["ok"] is True
