from __future__ import annotations

from typing import Any

from ..agent.tools import build_tool_error_result
from ..services.tasks import log_workspace_action
from .utils import resolve_asset_by_id_or_name, resolve_asset_path


def handle(
    runtime: Any,
    scope: str,
    path: str,
    offset: int = 0,
    limit: int = 10000,
    line_start: int | None = None,
    line_end: int | None = None,
):
    if line_start is not None and line_start < 1:
        raise ValueError("line_start must be >= 1.")
    if line_end is not None and line_end != -1 and line_end < 1:
        raise ValueError("line_end must be >= 1 or -1.")
    if (
        line_start is not None
        and line_end is not None
        and line_end != -1
        and line_end < line_start
    ):
        raise ValueError("line_end must be >= line_start.")

    if scope == "project":
        asset = resolve_asset_by_id_or_name(
            runtime.context.session, runtime.context.project_id, filename=path
        )
        if asset is not None and asset.mime_type.startswith("image/"):
            return runtime._remap_project_tool_result(
                runtime._project_read_resource(
                    filename=path, offset=offset, limit=limit
                ),
                tool_name="read_file",
            )
        if line_start is None and line_end is None:
            return runtime._remap_project_tool_result(
                runtime._project_read_resource(
                    filename=path, offset=offset, limit=limit
                ),
                tool_name="read_file",
            )
        asset_path = resolve_asset_path(
            runtime.context.session,
            runtime.context.project_id,
            path,
            runtime.context.uploads_dir,
        )
        if asset is None or asset_path is None:
            return build_tool_error_result(
                tool_name="read_file",
                error_type="file_not_found",
                message=f"Resource '{path}' not found in project resources.",
                retryable=False,
            )
        content = runtime._read_project_asset_text(asset_path)
        return runtime._build_line_range_result(
            path=path,
            content=content,
            line_start=line_start,
            line_end=line_end,
            asset_id=asset.id,
        )

    base_root, workspace_id = runtime._resolve_scope_root(scope)
    target = runtime._resolve_relative_path(base_root, path, allow_missing=False)
    if target.is_dir():
        raise IsADirectoryError(f"'{path}' is a directory.")
    content = target.read_text(encoding="utf-8", errors="replace")
    if line_start is not None or line_end is not None:
        result = runtime._build_line_range_result(
            path=str(target.relative_to(base_root)),
            content=content,
            line_start=line_start,
            line_end=line_end,
        )
        result["sha256"] = runtime._sha256_text(content)
    else:
        chunk = content[offset : offset + limit]
        result = {
            "path": str(target.relative_to(base_root)),
            "content": chunk,
            "more_available": len(content) > offset + limit,
            "sha256": runtime._sha256_text(content),
        }
    log_workspace_action(
        runtime.context.session,
        action_type="read_file",
        workspace_scope=scope,
        task_id=runtime.context.current_task.id
        if runtime.context.current_task
        else None,
        agent_run_id=runtime.context.run.id,
        tool_execution_id=runtime.context.current_tool_execution_id,
        project_workspace_id=workspace_id,
        target_path=str(target),
        arguments_json={
            "offset": offset,
            "limit": limit,
            "line_start": line_start,
            "line_end": line_end,
        },
    )
    return result
