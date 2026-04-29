from __future__ import annotations

from typing import Any

from ..services.tasks import log_workspace_action


def handle(
    runtime: Any,
    scope: str,
    query: str,
    path: str = ".",
    include_glob: str = "**",
    exclude_glob: str | None = None,
    max_matches: int = 50,
    context_lines: int = 2,
    case_sensitive: bool = False,
    regex: bool = False,
):
    if scope == "project":
        return runtime._search_project_assets(
            query=query,
            path=path,
            include_glob=include_glob,
            exclude_glob=exclude_glob,
            max_matches=max_matches,
            context_lines=context_lines,
            case_sensitive=case_sensitive,
            regex=regex,
        )

    base_root, workspace_id = runtime._resolve_scope_root(scope)
    target = runtime._resolve_relative_path(base_root, path, allow_missing=False)
    pattern = runtime._compile_search_pattern(
        query=query, case_sensitive=case_sensitive, regex=regex
    )
    paths = runtime._collect_search_paths(
        base_root=base_root,
        target=target,
        include_glob=include_glob,
        exclude_glob=exclude_glob,
    )
    matches: list[dict[str, Any]] = []
    for file_path in paths:
        relative_name = str(file_path.relative_to(base_root))
        try:
            text = file_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        lines = text.splitlines()
        for index, line in enumerate(lines):
            match = pattern.search(line)
            if not match:
                continue
            start = max(0, index - context_lines)
            end = min(len(lines), index + context_lines + 1)
            matches.append(
                {
                    "path": relative_name,
                    "line_no": index + 1,
                    "match": line.strip(),
                    "column_start": match.start() + 1,
                    "column_end": match.end(),
                    "context": lines[start:end],
                }
            )
            if len(matches) >= max_matches:
                break
        if len(matches) >= max_matches:
            break
    log_workspace_action(
        runtime.context.session,
        action_type="search_files",
        workspace_scope=scope,
        task_id=runtime.context.current_task.id
        if runtime.context.current_task
        else None,
        agent_run_id=runtime.context.run.id,
        tool_execution_id=runtime.context.current_tool_execution_id,
        project_workspace_id=workspace_id,
        target_path=str(target),
        arguments_json={
            "query": query,
            "path": path,
            "include_glob": include_glob,
            "exclude_glob": exclude_glob,
            "case_sensitive": case_sensitive,
            "regex": regex,
        },
    )
    return {
        "query": query,
        "match_count": len(matches),
        "matches": matches,
        "truncated": len(matches) == max_matches,
    }
