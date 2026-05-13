from __future__ import annotations

from typing import Any

from ..services.tasks import log_workspace_action
from .utils import _path_within


def handle(runtime: Any, scope: str, path: str = ".", pattern: str | None = None):
    normalized_path, path_changed = runtime.normalize_path_argument(path)
    path = normalized_path
    if scope == "project":
        prefix = "" if path in {".", ""} else path.strip()
        entries = [
            entry
            for entry in runtime._project_list_resources()
            if not prefix or entry["filename"].startswith(prefix)
        ]
        if pattern:
            import fnmatch

            entries = [
                entry
                for entry in entries
                if fnmatch.fnmatch(entry["filename"], pattern)
            ]
        result = {"entries": entries}
        if path_changed:
            result["normalized_path"] = path
        return result

    base_root, workspace_id = runtime._resolve_scope_root(scope)
    target = runtime._resolve_relative_path(base_root, path, allow_missing=False)
    if not target.is_dir():
        raise NotADirectoryError(f"'{path}' is not a directory.")

    entries = []
    if pattern:
        matched = sorted(
            target.glob(pattern),
            key=lambda item: (item.is_file(), str(item.relative_to(target)).lower()),
        )
        for entry in matched:
            if not _path_within(base_root, entry):
                continue
            entries.append(_entry_payload(entry, base_root))
    else:
        for entry in sorted(
            target.iterdir(), key=lambda item: (item.is_file(), item.name.lower())
        ):
            entries.append(_entry_payload(entry, base_root))

    log_workspace_action(
        runtime.context.session,
        action_type="list_files",
        workspace_scope=scope,
        task_id=runtime.context.current_task.id
        if runtime.context.current_task
        else None,
        agent_run_id=runtime.context.run.id,
        tool_execution_id=runtime.context.current_tool_execution_id,
        project_workspace_id=workspace_id,
        target_path=str(target),
        arguments_json={"path": path, "pattern": pattern},
    )
    result = {"entries": entries}
    if path_changed:
        result["normalized_path"] = path
    return result


def _entry_payload(entry, base_root):
    return {
        "path": str(entry.relative_to(base_root)),
        "name": entry.name,
        "is_dir": entry.is_dir(),
        "size_bytes": entry.stat().st_size if entry.is_file() else None,
    }
