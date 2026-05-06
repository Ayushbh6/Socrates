import json
from types import SimpleNamespace
import threading
import time

import pytest

from backend.src.agent.tools import build_tool_error_result
from backend.src.core.schema import ToolCall
from backend.src.tools.executor import ProjectToolBatchExecutor
from backend.src.tools.locks import KeyedLockRegistry
from backend.src.tools.read_state import sha256_file
from backend.src.tools.resources import (
    FileResource,
    PriorReadRequirement,
    ToolResourcePlan,
    ToolResourcePlanner,
)


def _executor(tmp_path):
    return ProjectToolBatchExecutor(
        session_factory=lambda: None,
        project_id="project-1",
        conversation_id="conversation-1",
        run_id="run-1",
        uploads_dir=tmp_path,
        lock_registry=KeyedLockRegistry(),
    )


def test_task_package_path_variants_are_planned_as_package_files(tmp_path):
    task_root = tmp_path / "task"
    task_root.mkdir()

    class FakeRuntime:
        def __init__(self):
            self.context = SimpleNamespace(
                current_task=SimpleNamespace(workspace_root=str(task_root)),
                conversation_id="conversation-1",
                run=SimpleNamespace(id="run-1"),
            )

        def _resolve_edit_target(self, _scope, path, *, allow_missing):
            return (task_root / path).resolve(), None

    planner = ToolResourcePlanner(FakeRuntime())
    call = ToolCall(
        id="write_plan",
        name="write_file",
        arguments={"scope": "task", "path": "./plan.md", "content": "# Plan\n"},
    )

    plan = planner.plan(call)

    assert plan.write_files[0].argument_path == "plan.md"
    assert plan.prior_read_requirements == []
    assert ProjectToolBatchExecutor._touches_task_package(plan) is True


@pytest.mark.asyncio
async def test_same_file_writes_are_serialized_and_independent_failures_continue(
    tmp_path, monkeypatch
):
    target = tmp_path / "sample.py"
    target.write_text("a = 1\nb = 2\n", encoding="utf-8")
    resource = FileResource(
        key=f"file:{target.resolve()}",
        path=target.resolve(),
        argument_path="sample.py",
    )
    calls = [
        ToolCall(
            id="edit_a",
            name="edit_file",
            arguments={"old_text": "a = 1", "new_text": "a = 10"},
        ),
        ToolCall(
            id="edit_missing",
            name="edit_file",
            arguments={"old_text": "missing", "new_text": "still missing"},
        ),
        ToolCall(
            id="edit_b",
            name="edit_file",
            arguments={"old_text": "b = 2", "new_text": "b = 20"},
        ),
    ]
    plans = [
        ToolResourcePlan(
            tool_call=call,
            write_files=[resource],
            lock_keys={resource.key},
        )
        for call in calls
    ]
    monkeypatch.setattr(ProjectToolBatchExecutor, "_plan_tool_calls", lambda *_: plans)

    active = 0
    max_active = 0
    active_lock = threading.Lock()

    def fake_execute(self, tool_call):
        nonlocal active, max_active
        with active_lock:
            active += 1
            max_active = max(max_active, active)
        try:
            time.sleep(0.02)
            source = target.read_text(encoding="utf-8")
            old_text = tool_call.arguments["old_text"]
            if old_text not in source:
                return build_tool_error_result(
                    tool_name=tool_call.name,
                    error_type="ValueError",
                    message="old_text was not found.",
                    retryable=False,
                )
            target.write_text(
                source.replace(old_text, tool_call.arguments["new_text"], 1),
                encoding="utf-8",
            )
            return json.dumps({"ok": True, "tool_name": tool_call.name, "data": {}})
        finally:
            with active_lock:
                active -= 1

    monkeypatch.setattr(ProjectToolBatchExecutor, "_execute_with_fresh_runtime", fake_execute)

    results = [json.loads(item) for item in await _executor(tmp_path)(calls)]

    assert max_active == 1
    assert [result["ok"] for result in results] == [True, False, True]
    assert target.read_text(encoding="utf-8") == "a = 10\nb = 20\n"


@pytest.mark.asyncio
async def test_same_batch_read_and_write_rejects_the_write(tmp_path, monkeypatch):
    target = tmp_path / "sample.py"
    target.write_text("a = 1\n", encoding="utf-8")
    resource = FileResource(
        key=f"file:{target.resolve()}",
        path=target.resolve(),
        argument_path="sample.py",
    )
    read_call = ToolCall(id="read", name="read_file", arguments={})
    edit_call = ToolCall(id="edit", name="edit_file", arguments={})
    plans = [
        ToolResourcePlan(tool_call=read_call, read_files=[resource]),
        ToolResourcePlan(
            tool_call=edit_call,
            write_files=[resource],
            lock_keys={resource.key},
        ),
    ]
    monkeypatch.setattr(ProjectToolBatchExecutor, "_plan_tool_calls", lambda *_: plans)
    monkeypatch.setattr(
        ProjectToolBatchExecutor,
        "_record_rejected_tool_call",
        lambda _self, _tool_call, result: result,
    )
    monkeypatch.setattr(
        ProjectToolBatchExecutor,
        "_execute_with_fresh_runtime",
        lambda *_: json.dumps({"ok": True, "tool_name": "read_file", "data": {}}),
    )

    results = [json.loads(item) for item in await _executor(tmp_path)([read_call, edit_call])]

    assert results[0]["ok"] is True
    assert results[1]["ok"] is False
    assert results[1]["error_type"] == "same_batch_read_write_conflict"


@pytest.mark.asyncio
async def test_existing_file_write_requires_prior_read_or_expected_sha(tmp_path, monkeypatch):
    target = tmp_path / "sample.py"
    target.write_text("a = 1\n", encoding="utf-8")
    resource = FileResource(
        key=f"file:{target.resolve()}",
        path=target.resolve(),
        argument_path="sample.py",
    )
    call = ToolCall(
        id="edit",
        name="edit_file",
        arguments={"old_text": "a = 1", "new_text": "a = 10"},
    )
    plan = ToolResourcePlan(
        tool_call=call,
        write_files=[resource],
        lock_keys={resource.key},
        prior_read_requirements=[
            PriorReadRequirement(resource=resource, expected_argument="expected_sha256")
        ],
    )
    executor = _executor(tmp_path)
    monkeypatch.setattr(ProjectToolBatchExecutor, "_plan_tool_calls", lambda *_: [plan])
    monkeypatch.setattr(
        ProjectToolBatchExecutor,
        "_record_rejected_tool_call",
        lambda _self, _tool_call, result: result,
    )

    missing_read = json.loads((await executor([call]))[0])
    assert missing_read["error_type"] == "read_before_write_required"

    executor.read_state.record(key=resource.key, sha256=sha256_file(target))
    captured_arguments = {}

    def fake_execute(_self, tool_call):
        captured_arguments.update(tool_call.arguments)
        return json.dumps({"ok": True, "tool_name": tool_call.name, "data": {}})

    monkeypatch.setattr(ProjectToolBatchExecutor, "_execute_with_fresh_runtime", fake_execute)

    success = json.loads((await executor([call]))[0])

    assert success["ok"] is True
    assert captured_arguments["expected_sha256"] == sha256_file(target)
