from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import shlex
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from sqlalchemy.orm import Session

from ..agent.tools import build_tool_error_result
from ..core.schema import ToolCall, ToolDefinition
from ..db.models import AgentRun, Asset, MessageRecord, ProjectWorkspace, Task, ToolExecution
from ..services.tasks import (
    create_note_asset,
    create_task,
    create_task_approval,
    ensure_task_input_assets,
    find_matching_approval,
    get_active_task_for_conversation,
    get_project_notes_dir,
    log_workspace_action,
    select_default_project_workspace,
    serialize_task,
    sync_task_output_artifacts,
)
from .list_resources import make_list_resources
from .read_resource import make_read_resource
from .search_resources import make_search_resources
from .system_time import get_system_time
from .utils import _path_within, resolve_asset_by_id_or_name, resolve_asset_path

MAX_PATCH_CHARACTERS = 200_000
MAX_PATCH_FILES = 50


@dataclass
class PatchHunk:
    lines: list[tuple[str, str]]


@dataclass
class PatchOperation:
    kind: str
    path: str
    hunks: list[PatchHunk] | None = None
    content_lines: list[str] | None = None


@dataclass
class ToolContext:
    session: Session
    project_id: str
    conversation_id: str
    run: AgentRun
    uploads_dir: Path
    host_workspaces_dir: Path
    current_task: Task | None = None
    current_tool_execution_id: str | None = None

    def refresh_task(self) -> Task | None:
        self.current_task = get_active_task_for_conversation(self.session, self.conversation_id)
        return self.current_task


class ProjectToolRuntime:
    def __init__(self, context: ToolContext):
        self.context = context
        self._command_execution_enabled = self._running_inside_docker()
        self._project_list_resources = make_list_resources(context.session, context.project_id)
        self._project_read_resource = make_read_resource(context.session, context.project_id, context.uploads_dir)
        self._project_search_resources = make_search_resources(context.session, context.project_id, context.uploads_dir)
        self.definitions = self._build_definitions()
        self.handlers: dict[str, Callable[..., Any]] = {
            "list_files": self.list_files,
            "read_file": self.read_file,
            "search_files": self.search_files,
            "edit_file": self.edit_file,
            "get_system_time": get_system_time,
            "create_task": self.create_task,
            "write_project_note": self.write_project_note,
            "execute_command": self.execute_command,
        }

    def _build_definitions(self) -> list[ToolDefinition]:
        definitions = [
            ToolDefinition(
                name="list_files",
                description="List files in project assets, the current task workspace, or the linked workspace.",
                parameters={
                    "type": "object",
                    "properties": {
                        "scope": {"type": "string", "enum": ["project", "task", "linked_workspace"]},
                        "path": {"type": "string", "default": "."},
                    },
                    "required": ["scope"],
                },
            ),
            ToolDefinition(
                name="read_file",
                description="Read a file from project assets, the current task workspace, or the linked workspace. When a project asset is an image, use this tool to inspect the image itself before answering questions about what the image shows.",
                parameters={
                    "type": "object",
                    "properties": {
                        "scope": {"type": "string", "enum": ["project", "task", "linked_workspace"]},
                        "path": {"type": "string"},
                        "offset": {"type": "integer", "default": 0},
                        "limit": {"type": "integer", "default": 10000},
                        "line_start": {"type": "integer"},
                        "line_end": {"type": "integer"},
                    },
                    "required": ["scope", "path"],
                },
            ),
            ToolDefinition(
                name="search_files",
                description="Search file contents in project assets, the current task workspace, or the linked workspace.",
                parameters={
                    "type": "object",
                    "properties": {
                        "scope": {"type": "string", "enum": ["project", "task", "linked_workspace"]},
                        "query": {"type": "string"},
                        "path": {"type": "string", "default": "."},
                        "include_glob": {"type": "string", "default": "**"},
                        "exclude_glob": {"type": "string"},
                        "max_matches": {"type": "integer", "default": 50},
                        "context_lines": {"type": "integer", "default": 2},
                        "case_sensitive": {"type": "boolean", "default": False},
                        "regex": {"type": "boolean", "default": False},
                    },
                    "required": ["scope", "query"],
                },
            ),
            ToolDefinition(
                name="edit_file",
                description="View, create, replace, insert into, or overwrite files in the current task workspace or linked workspace.",
                parameters={
                    "type": "object",
                    "properties": {
                        "scope": {"type": "string", "enum": ["task", "linked_workspace"]},
                        "path": {"type": "string"},
                        "operation": {
                            "type": "string",
                            "enum": ["view", "create", "str_replace", "insert", "overwrite", "multi_edit", "apply_patch"],
                        },
                        "content": {"type": "string"},
                        "old_text": {"type": "string"},
                        "new_text": {"type": "string"},
                        "replace_all": {"type": "boolean", "default": False},
                        "insert_after_line": {"type": "integer"},
                        "edits": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "operation": {"type": "string", "enum": ["str_replace", "insert"]},
                                    "old_text": {"type": "string"},
                                    "new_text": {"type": "string"},
                                    "replace_all": {"type": "boolean", "default": False},
                                    "content": {"type": "string"},
                                    "insert_after_line": {"type": "integer"},
                                },
                                "required": ["operation"],
                            },
                        },
                        "patch_text": {"type": "string"},
                        "expected_sha256": {"type": "string"},
                        "expected_sha256_map": {"type": "object", "additionalProperties": {"type": "string"}},
                    },
                    "required": ["scope", "operation"],
                },
            ),
            ToolDefinition(
                name="create_task",
                description="Create or resume the active task before any substantial file writing or command execution.",
                parameters={
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "goal": {"type": "string"},
                        "success_criteria": {"type": "string"},
                    },
                    "required": ["title", "goal"],
                },
            ),
            ToolDefinition(
                name="write_project_note",
                description="Write a small project note in chat mode. New or appended content only, maximum 10 lines.",
                parameters={
                    "type": "object",
                    "properties": {
                        "path_or_title": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["path_or_title", "content"],
                },
            ),
            ToolDefinition(
                name="get_system_time",
                description="Returns the current UTC system time and weekday.",
                parameters={"type": "object", "properties": {}, "required": []},
            ),
        ]
        if self._command_execution_enabled:
            definitions.insert(
                -1,
                ToolDefinition(
                    name="execute_command",
                    description="Execute a command using argv form in the current task workspace or approved linked workspace.",
                    parameters={
                        "type": "object",
                        "properties": {
                            "scope": {"type": "string", "enum": ["task", "linked_workspace"]},
                            "argv": {"type": "array", "items": {"type": "string"}},
                            "cwd": {"type": "string", "default": "."},
                            "timeout_sec": {"type": "integer", "default": 15},
                        },
                        "required": ["scope", "argv"],
                    },
                ),
            )
        return definitions

    def execute(self, tool_call: ToolCall) -> Any:
        handler = self.handlers.get(tool_call.name)
        if handler is None:
            return build_tool_error_result(
                tool_name=tool_call.name,
                error_type="missing_tool",
                message=f"No handler registered for tool '{tool_call.name}'.",
                suggestion="Call one of the available tools instead.",
            )

        tool_execution = ToolExecution(
            agent_run_id=self.context.run.id,
            task_id=self.context.current_task.id if self.context.current_task else None,
            tool_call_id=tool_call.id,
            tool_name=tool_call.name,
            arguments_json=tool_call.arguments,
            status="running",
            started_at=self._now(),
        )
        self.context.session.add(tool_execution)
        self.context.session.commit()
        self.context.current_tool_execution_id = tool_execution.id

        try:
            result = handler(**tool_call.arguments)
            tool_execution.status = "completed"
            tool_execution.task_id = self.context.current_task.id if self.context.current_task else None
            if isinstance(result, str):
                tool_execution.result_text = result
                try:
                    tool_execution.result_json = json.loads(result)
                except json.JSONDecodeError:
                    tool_execution.result_json = {"result": result}
            else:
                tool_execution.result_json = result
                tool_execution.result_text = json.dumps(result, default=str)
            return result
        except Exception as exc:
            tool_execution.status = "failed"
            tool_execution.error_text = str(exc)
            tool_execution.result_json = {
                "ok": False,
                "tool_name": tool_call.name,
                "error_type": exc.__class__.__name__,
                "message": str(exc),
                "retryable": False,
            }
            tool_execution.result_text = json.dumps(tool_execution.result_json, default=str)
            raise
        finally:
            tool_execution.completed_at = self._now()
            self.context.session.commit()
            self.context.current_tool_execution_id = None

    def create_task(self, title: str, goal: str, success_criteria: str | None = None):
        workspace = select_default_project_workspace(self.context.session, self.context.project_id)
        task = create_task(
            self.context.session,
            project_id=self.context.project_id,
            conversation_id=self.context.conversation_id,
            title=title,
            goal_text=goal,
            success_criteria_text=success_criteria,
            created_from_agent_run_id=self.context.run.id,
            project_workspace_id=workspace.id if workspace else None,
        )
        self.context.current_task = task
        self.context.run.task_id = task.id
        self.context.run.execution_mode = "task"
        task.last_agent_run_id = self.context.run.id
        if self.context.run.trigger_message_id:
            trigger_message = self.context.session.get(MessageRecord, self.context.run.trigger_message_id)
            if trigger_message is not None:
                trigger_message.task_id = task.id
                trigger_message.execution_mode = "task"
                trigger_assets = [link.asset for link in trigger_message.asset_links if link.asset.deleted_at is None]
                ensure_task_input_assets(self.context.session, task=task, assets=trigger_assets)
        self.context.session.commit()
        return {"task": serialize_task(task)}

    def write_project_note(self, path_or_title: str, content: str):
        lines = [line for line in content.splitlines() if line.strip() or line == ""]
        if len(lines) > 10:
            return self._task_required_error("write_project_note", "This note is larger than the chat-mode note limit. Create a task first.")
        prior_writes = (
            self.context.session.query(ToolExecution)
            .filter(
                ToolExecution.agent_run_id == self.context.run.id,
                ToolExecution.tool_name == "write_project_note",
                ToolExecution.id != self.context.current_tool_execution_id,
            )
            .count()
        )
        if prior_writes >= 1:
            return self._task_required_error("write_project_note", "Only one small note write is allowed in chat mode per run. Create a task first.")
        asset = create_note_asset(
            self.context.session,
            project_id=self.context.project_id,
            title=Path(path_or_title).stem or "project-note",
            content=content,
            created_by_task_id=self.context.current_task.id if self.context.current_task else None,
        )
        log_workspace_action(
            self.context.session,
            action_type="write_project_note",
            workspace_scope="managed_task" if self.context.current_task else "managed_project",
            task_id=self.context.current_task.id if self.context.current_task else None,
            agent_run_id=self.context.run.id,
            tool_execution_id=self.context.current_tool_execution_id,
            target_path=str(get_project_notes_dir(self.context.project_id) / asset.original_name),
        )
        return {"asset_id": asset.id, "filename": asset.original_name}

    def list_files(self, scope: str, path: str = "."):
        if scope == "project":
            prefix = "" if path in {".", ""} else path.strip()
            entries = [
                entry
                for entry in self._project_list_resources()
                if not prefix or entry["filename"].startswith(prefix)
            ]
            return {"entries": entries}

        base_root, workspace_id = self._resolve_scope_root(scope)
        target = self._resolve_relative_path(base_root, path, allow_missing=False)
        if not target.is_dir():
            raise NotADirectoryError(f"'{path}' is not a directory.")
        entries = []
        for entry in sorted(target.iterdir(), key=lambda item: (item.is_file(), item.name.lower())):
            entries.append(
                {
                    "path": str(entry.relative_to(base_root)),
                    "name": entry.name,
                    "is_dir": entry.is_dir(),
                    "size_bytes": entry.stat().st_size if entry.is_file() else None,
                }
            )
        log_workspace_action(
            self.context.session,
            action_type="list_files",
            workspace_scope=scope,
            task_id=self.context.current_task.id if self.context.current_task else None,
            agent_run_id=self.context.run.id,
            tool_execution_id=self.context.current_tool_execution_id,
            project_workspace_id=workspace_id,
            target_path=str(target),
            arguments_json={"path": path},
        )
        return {"entries": entries}

    def read_file(
        self,
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
        if line_start is not None and line_end is not None and line_end != -1 and line_end < line_start:
            raise ValueError("line_end must be >= line_start.")

        if scope == "project":
            asset = resolve_asset_by_id_or_name(self.context.session, self.context.project_id, filename=path)
            if asset is not None and asset.mime_type.startswith("image/"):
                return self._remap_project_tool_result(
                    self._project_read_resource(filename=path, offset=offset, limit=limit),
                    tool_name="read_file",
                )
            if line_start is None and line_end is None:
                return self._remap_project_tool_result(
                    self._project_read_resource(filename=path, offset=offset, limit=limit),
                    tool_name="read_file",
                )
            asset_path = resolve_asset_path(self.context.session, self.context.project_id, path, self.context.uploads_dir)
            if asset is None or asset_path is None:
                return build_tool_error_result(
                    tool_name="read_file",
                    error_type="file_not_found",
                    message=f"Resource '{path}' not found in project resources.",
                    retryable=False,
                )
            content = self._read_project_asset_text(asset_path)
            return self._build_line_range_result(
                path=path,
                content=content,
                line_start=line_start,
                line_end=line_end,
                asset_id=asset.id,
            )

        base_root, workspace_id = self._resolve_scope_root(scope)
        target = self._resolve_relative_path(base_root, path, allow_missing=False)
        if target.is_dir():
            raise IsADirectoryError(f"'{path}' is a directory.")
        content = target.read_text(encoding="utf-8", errors="replace")
        if line_start is not None or line_end is not None:
            result = self._build_line_range_result(
                path=str(target.relative_to(base_root)),
                content=content,
                line_start=line_start,
                line_end=line_end,
            )
        else:
            chunk = content[offset : offset + limit]
            result = {"path": str(target.relative_to(base_root)), "content": chunk, "more_available": len(content) > offset + limit}
        log_workspace_action(
            self.context.session,
            action_type="read_file",
            workspace_scope=scope,
            task_id=self.context.current_task.id if self.context.current_task else None,
            agent_run_id=self.context.run.id,
            tool_execution_id=self.context.current_tool_execution_id,
            project_workspace_id=workspace_id,
            target_path=str(target),
            arguments_json={"offset": offset, "limit": limit, "line_start": line_start, "line_end": line_end},
        )
        return result

    def search_files(
        self,
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
            return self._search_project_assets(
                query=query,
                path=path,
                include_glob=include_glob,
                exclude_glob=exclude_glob,
                max_matches=max_matches,
                context_lines=context_lines,
                case_sensitive=case_sensitive,
                regex=regex,
            )

        base_root, workspace_id = self._resolve_scope_root(scope)
        target = self._resolve_relative_path(base_root, path, allow_missing=False)
        pattern = self._compile_search_pattern(query=query, case_sensitive=case_sensitive, regex=regex)
        paths = self._collect_search_paths(
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
            self.context.session,
            action_type="search_files",
            workspace_scope=scope,
            task_id=self.context.current_task.id if self.context.current_task else None,
            agent_run_id=self.context.run.id,
            tool_execution_id=self.context.current_tool_execution_id,
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
        return {"query": query, "match_count": len(matches), "matches": matches, "truncated": len(matches) == max_matches}

    def edit_file(
        self,
        scope: str,
        operation: str,
        path: str | None = None,
        content: str | None = None,
        old_text: str | None = None,
        new_text: str | None = None,
        replace_all: bool = False,
        insert_after_line: int | None = None,
        edits: list[dict[str, Any]] | None = None,
        patch_text: str | None = None,
        expected_sha256: str | None = None,
        expected_sha256_map: dict[str, str] | None = None,
    ):
        if scope == "task" and self.context.current_task is None:
            return self._task_required_error("edit_file", "Create a task before editing files.")
        if scope == "project":
            return build_tool_error_result(
                tool_name="edit_file",
                error_type="permission_denied",
                message="Project assets are read-only. Create a task or use the linked workspace for edits.",
                retryable=False,
            )
        if operation != "apply_patch" and not path:
            raise ValueError("path is required for this edit operation.")
        if operation == "apply_patch":
            if patch_text is None or not patch_text.strip():
                raise ValueError("patch_text is required for apply_patch.")
            operations = self._parse_apply_patch_text(patch_text)
            if scope == "linked_workspace":
                approval_error = self._require_approval_if_needed(
                    scope="linked_workspace",
                    argv=["__edit_file__", "__apply_patch__"],
                    cwd=".",
                    approval_type="linked_workspace_write",
                    request_json={
                        "scope": scope,
                        "operation": operation,
                        "paths": [item.path for item in operations],
                    },
                )
                if approval_error is not None:
                    return approval_error
            return self._apply_patch_operations(
                scope=scope,
                operations=operations,
                expected_sha256_map=expected_sha256_map,
            )
        if scope == "linked_workspace":
            approval_error = self._require_approval_if_needed(
                scope="linked_workspace",
                argv=["__edit_file__", path, operation],
                cwd=".",
                approval_type="linked_workspace_write",
                request_json={"scope": scope, "path": path, "operation": operation},
            )
            if approval_error is not None:
                return approval_error

        target, workspace_id = self._resolve_edit_target(scope, path, allow_missing=operation in {"create"})
        if operation == "view":
            return self.read_file(scope=scope, path=path)

        if operation == "create":
            if content is None:
                raise ValueError("content is required for create.")
            if target.exists():
                raise FileExistsError(f"'{path}' already exists.")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        elif operation == "overwrite":
            if content is None:
                raise ValueError("content is required for overwrite.")
            target.parent.mkdir(parents=True, exist_ok=True)
            self._check_expected_sha256(target, expected_sha256)
            target.write_text(content, encoding="utf-8")
        elif operation == "str_replace":
            if old_text is None or new_text is None:
                raise ValueError("old_text and new_text are required for str_replace.")
            self._check_expected_sha256(target, expected_sha256)
            source = target.read_text(encoding="utf-8", errors="replace")
            count = source.count(old_text)
            if count == 0:
                raise ValueError("old_text was not found.")
            if not replace_all and count != 1:
                raise ValueError("old_text matched multiple times. Use replace_all=true or choose a more specific string.")
            updated = source.replace(old_text, new_text) if replace_all else source.replace(old_text, new_text, 1)
            target.write_text(updated, encoding="utf-8")
        elif operation == "insert":
            if content is None or insert_after_line is None:
                raise ValueError("content and insert_after_line are required for insert.")
            self._check_expected_sha256(target, expected_sha256)
            source = target.read_text(encoding="utf-8", errors="replace")
            lines = source.splitlines()
            if insert_after_line < 0 or insert_after_line > len(lines):
                raise ValueError("insert_after_line is out of range.")
            insert_lines = content.splitlines()
            updated_lines = lines[:insert_after_line] + insert_lines + lines[insert_after_line:]
            trailing_newline = "\n" if source.endswith("\n") or not source else ""
            target.write_text("\n".join(updated_lines) + trailing_newline, encoding="utf-8")
        elif operation == "multi_edit":
            if not edits:
                raise ValueError("edits is required for multi_edit.")
            self._check_expected_sha256(target, expected_sha256)
            source = target.read_text(encoding="utf-8", errors="replace")
            updated = self._apply_multi_edit(source, edits)
            target.write_text(updated, encoding="utf-8")
        else:
            raise ValueError("Unsupported edit operation.")

        if scope == "task":
            self._sync_task_outputs_if_needed()
        log_workspace_action(
            self.context.session,
            action_type="edit_file",
            workspace_scope=scope,
            task_id=self.context.current_task.id if self.context.current_task else None,
            agent_run_id=self.context.run.id,
            tool_execution_id=self.context.current_tool_execution_id,
            project_workspace_id=workspace_id,
            target_path=str(target),
            arguments_json={"path": path, "operation": operation},
        )
        return {"path": str(target.relative_to(self._resolve_scope_root(scope)[0])), "operation": operation}

    def _apply_patch_operations(
        self,
        *,
        scope: str,
        operations: list[PatchOperation],
        expected_sha256_map: dict[str, str] | None = None,
    ):
        base_root, workspace_id = self._resolve_scope_root(scope)
        plans: list[dict[str, Any]] = []

        for item in operations:
            target, _ = self._resolve_edit_target(scope, item.path, allow_missing=item.kind == "add")
            if item.kind == "add":
                if target.exists():
                    raise FileExistsError(f"'{item.path}' already exists.")
                plans.append(
                    {
                        "path": target,
                        "relative_path": str(target.relative_to(base_root)),
                        "kind": "add",
                        "existed": False,
                        "old_text": None,
                        "new_text": self._join_patch_lines(item.content_lines or []),
                    }
                )
                continue

            if not target.exists():
                raise FileNotFoundError(f"'{item.path}' does not exist.")
            if target.is_dir():
                raise IsADirectoryError(f"'{item.path}' is a directory.")

            source = target.read_text(encoding="utf-8", errors="replace")
            self._check_expected_sha256(target, expected_sha256_map.get(item.path) if expected_sha256_map else None)
            if item.kind == "delete":
                plans.append(
                    {
                        "path": target,
                        "relative_path": str(target.relative_to(base_root)),
                        "kind": "delete",
                        "existed": True,
                        "old_text": source,
                        "new_text": None,
                    }
                )
                continue

            plans.append(
                {
                    "path": target,
                    "relative_path": str(target.relative_to(base_root)),
                    "kind": "update",
                    "existed": True,
                    "old_text": source,
                    "new_text": self._apply_patch_hunks(source, item.hunks or []),
                }
            )

        created_files: list[str] = []
        updated_files: list[str] = []
        deleted_files: list[str] = []
        applied: list[dict[str, Any]] = []

        try:
            for plan in plans:
                target = plan["path"]
                new_text = plan["new_text"]
                if new_text is None:
                    target.unlink()
                    deleted_files.append(plan["relative_path"])
                else:
                    self._atomic_write_text(target, new_text)
                    if plan["kind"] == "add":
                        created_files.append(plan["relative_path"])
                    else:
                        updated_files.append(plan["relative_path"])
                applied.append(plan)
        except Exception:
            for plan in reversed(applied):
                target = plan["path"]
                if plan["existed"]:
                    self._atomic_write_text(target, plan["old_text"])
                elif target.exists():
                    target.unlink()
            raise

        if scope == "task":
            self._sync_task_outputs_if_needed()

        touched_paths = [plan["relative_path"] for plan in plans]
        log_workspace_action(
            self.context.session,
            action_type="edit_file",
            workspace_scope=scope,
            task_id=self.context.current_task.id if self.context.current_task else None,
            agent_run_id=self.context.run.id,
            tool_execution_id=self.context.current_tool_execution_id,
            project_workspace_id=workspace_id,
            target_path=str(base_root),
            arguments_json={
                "operation": "apply_patch",
                "touched_paths": touched_paths,
                "created_files": created_files,
                "updated_files": updated_files,
                "deleted_files": deleted_files,
            },
        )
        return {
            "operation": "apply_patch",
            "touched_paths": touched_paths,
            "created_files": created_files,
            "updated_files": updated_files,
            "deleted_files": deleted_files,
        }

    def _search_project_assets(
        self,
        *,
        query: str,
        path: str,
        include_glob: str,
        exclude_glob: str | None,
        max_matches: int,
        context_lines: int,
        case_sensitive: bool,
        regex: bool,
    ):
        pattern = self._compile_search_pattern(query=query, case_sensitive=case_sensitive, regex=regex)
        assets = (
            self.context.session.query(Asset)
            .filter(Asset.project_id == self.context.project_id, Asset.deleted_at == None)
            .all()
        )
        matches: list[dict[str, Any]] = []
        for asset in assets:
            if not self._project_asset_matches(asset.original_name, path=path, include_glob=include_glob, exclude_glob=exclude_glob):
                continue
            asset_path = resolve_asset_path(self.context.session, self.context.project_id, asset.original_name, self.context.uploads_dir)
            if asset_path is None:
                continue
            try:
                text = self._read_project_asset_text(asset_path)
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
                        "asset_id": asset.id,
                        "path": asset.original_name,
                        "filename": asset.original_name,
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
        return {"query": query, "match_count": len(matches), "matches": matches, "truncated": len(matches) == max_matches}

    def execute_command(self, scope: str, argv: list[str], cwd: str = ".", timeout_sec: int = 15):
        if not argv:
            raise ValueError("argv must contain at least one argument.")
        if scope == "task" and self.context.current_task is None:
            return self._task_required_error("execute_command", "Create a task before running commands.")
        if not self._running_inside_docker():
            return build_tool_error_result(
                tool_name="execute_command",
                error_type="sandbox_unavailable",
                message="Command execution is disabled outside the Docker runtime sandbox.",
                retryable=False,
                suggestion="Run PremChat inside Docker to use command execution safely.",
            )
        blocked_reason = self._blocked_command_reason(argv)
        if blocked_reason is not None:
            return build_tool_error_result(
                tool_name="execute_command",
                error_type="command_blocked",
                message=blocked_reason,
                retryable=False,
            )

        base_root, workspace_id = self._resolve_scope_root(scope)
        workdir = self._resolve_command_cwd(scope, base_root, cwd)
        path_error = self._validate_command_paths(scope=scope, base_root=base_root, workdir=workdir, argv=argv)
        if path_error is not None:
            return path_error
        approval_error = self._require_approval_if_needed(scope=scope, argv=argv, cwd=str(workdir.relative_to(base_root)))
        if approval_error is not None:
            return approval_error

        env = None
        if scope == "task":
            env = self._task_command_env()

        result = subprocess.run(
            argv,
            cwd=workdir,
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            env=env,
        )
        stdout = result.stdout[:20000]
        stderr = result.stderr[:20000]
        if scope == "task":
            self._sync_task_outputs_if_needed()
        log_workspace_action(
            self.context.session,
            action_type="execute_command",
            workspace_scope=scope,
            task_id=self.context.current_task.id if self.context.current_task else None,
            agent_run_id=self.context.run.id,
            tool_execution_id=self.context.current_tool_execution_id,
            project_workspace_id=workspace_id,
            target_path=str(workdir),
            command_text=shlex.join(argv),
            arguments_json={"cwd": cwd, "timeout_sec": timeout_sec},
            stdout_text=stdout,
            stderr_text=stderr,
            exit_code=result.returncode,
            success=result.returncode == 0,
        )
        return {
            "argv": argv,
            "cwd": str(workdir.relative_to(base_root)),
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": result.returncode,
            "success": result.returncode == 0,
        }

    @staticmethod
    def _remap_project_tool_result(result: Any, *, tool_name: str) -> Any:
        if not isinstance(result, str):
            return result
        try:
            payload = json.loads(result)
        except json.JSONDecodeError:
            return result
        if isinstance(payload, dict) and payload.get("tool_name"):
            payload["tool_name"] = tool_name
            return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
        return result

    def _resolve_edit_target(self, scope: str, path: str, *, allow_missing: bool) -> tuple[Path, str | None]:
        base_root, workspace_id = self._resolve_scope_root(scope)
        target = self._resolve_relative_path(base_root, path, allow_missing=allow_missing)
        if scope == "task":
            task = self._require_task()
            task_root = Path(task.workspace_root)
            work_root = (task_root / "work").resolve()
            outputs_root = (task_root / "outputs").resolve()
            if not (_path_within(work_root, target) or _path_within(outputs_root, target)):
                raise PermissionError("Task edits are only allowed inside work/ and outputs/.")
        return target, workspace_id

    def _resolve_scope_root(self, scope: str) -> tuple[Path, str | None]:
        if scope == "project":
            raise ValueError("Project scope does not have a writable workspace root.")
        if scope == "task":
            task = self._require_task()
            return Path(task.workspace_root), None
        if scope == "linked_workspace":
            task = self._require_task()
            if task.project_workspace_id is None:
                raise PermissionError("This task is not linked to a project workspace.")
            workspace = self.context.session.get(ProjectWorkspace, task.project_workspace_id)
            if workspace is None or not workspace.access_granted or workspace.access_revoked_at is not None:
                raise PermissionError("Linked workspace access has not been granted.")
            workspace_root = Path(workspace.root_path).resolve()
            host_root = self.context.host_workspaces_dir.resolve()
            if not _path_within(host_root, workspace_root):
                raise PermissionError("Linked workspace path is outside the mounted host workspaces root.")
            return workspace_root, workspace.id
        raise ValueError("Unsupported workspace scope.")

    @staticmethod
    def _compile_search_pattern(*, query: str, case_sensitive: bool, regex: bool) -> re.Pattern[str]:
        flags = 0 if case_sensitive else re.IGNORECASE
        return re.compile(query if regex else re.escape(query), flags)

    @staticmethod
    def _project_asset_matches(name: str, *, path: str, include_glob: str, exclude_glob: str | None) -> bool:
        if path not in {"", "."}:
            if any(char in path for char in "*?[]"):
                if not fnmatch.fnmatch(name, path):
                    return False
            elif not (name == path or name.startswith(path.rstrip("/") + "/")):
                return False
        if include_glob and include_glob != "**" and not fnmatch.fnmatch(name, include_glob):
            return False
        if exclude_glob and fnmatch.fnmatch(name, exclude_glob):
            return False
        return True

    def _collect_search_paths(self, *, base_root: Path, target: Path, include_glob: str, exclude_glob: str | None) -> list[Path]:
        if target.is_file():
            return [target]
        paths: list[Path] = []
        for item in target.rglob("*"):
            if not item.is_file():
                continue
            relative_name = str(item.relative_to(base_root))
            if include_glob and include_glob != "**" and not fnmatch.fnmatch(relative_name, include_glob):
                continue
            if exclude_glob and fnmatch.fnmatch(relative_name, exclude_glob):
                continue
            paths.append(item)
        return paths

    @staticmethod
    def _read_project_asset_text(path: Path) -> str:
        if path.suffix.lower() == ".pdf":
            import PyPDF2

            with path.open("rb") as handle:
                reader = PyPDF2.PdfReader(handle)
                return "".join((page.extract_text() or "") + "\n" for page in reader.pages)
        return path.read_text(encoding="utf-8", errors="replace")

    def _build_line_range_result(
        self,
        *,
        path: str,
        content: str,
        line_start: int | None,
        line_end: int | None,
        asset_id: str | None = None,
    ) -> dict[str, Any]:
        lines = content.splitlines()
        total_lines = len(lines)
        start = line_start or 1
        end = total_lines if line_end in {None, -1} else line_end
        start_index = min(max(start, 1), total_lines + 1) - 1
        end_index = min(max(end, 0), total_lines)
        selected = lines[start_index:end_index]
        chunk = "\n".join(selected)
        if selected and content.endswith("\n") and end_index == total_lines:
            chunk += "\n"
        result = {
            "path": path,
            "content": chunk,
            "line_start": start,
            "line_end": end if end != total_lines or line_end not in {None, -1} else total_lines,
            "total_lines": total_lines,
            "more_available_before": start_index > 0,
            "more_available_after": end_index < total_lines,
        }
        if asset_id is not None:
            result["asset_id"] = asset_id
        return result

    @staticmethod
    def _sha256_text(content: str) -> str:
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    def _check_expected_sha256(self, target: Path, expected_sha256: str | None) -> None:
        if not expected_sha256:
            return
        if not target.exists():
            raise FileNotFoundError(f"'{target.name}' does not exist.")
        current = self._sha256_text(target.read_text(encoding="utf-8", errors="replace"))
        if current != expected_sha256:
            raise RuntimeError("Edit conflict: file content has changed since it was last read.")

    def _apply_multi_edit(self, source: str, edits: list[dict[str, Any]]) -> str:
        updated = source
        for edit in edits:
            op = edit.get("operation")
            if op == "str_replace":
                old_text = edit.get("old_text")
                new_text = edit.get("new_text")
                if old_text is None or new_text is None:
                    raise ValueError("Each str_replace edit requires old_text and new_text.")
                count = updated.count(old_text)
                if count == 0:
                    raise ValueError("old_text was not found during multi_edit.")
                replace_all = bool(edit.get("replace_all", False))
                if not replace_all and count != 1:
                    raise ValueError("old_text matched multiple times during multi_edit. Use replace_all=true or be more specific.")
                updated = updated.replace(old_text, new_text) if replace_all else updated.replace(old_text, new_text, 1)
            elif op == "insert":
                content = edit.get("content")
                insert_after_line = edit.get("insert_after_line")
                if content is None or insert_after_line is None:
                    raise ValueError("Each insert edit requires content and insert_after_line.")
                lines = updated.splitlines()
                if insert_after_line < 0 or insert_after_line > len(lines):
                    raise ValueError("insert_after_line is out of range during multi_edit.")
                insert_lines = content.splitlines()
                updated_lines = lines[:insert_after_line] + insert_lines + lines[insert_after_line:]
                trailing_newline = "\n" if updated.endswith("\n") or not updated else ""
                updated = "\n".join(updated_lines) + trailing_newline
            else:
                raise ValueError("multi_edit only supports str_replace and insert operations.")
        return updated

    def _parse_apply_patch_text(self, patch_text: str) -> list[PatchOperation]:
        if len(patch_text) > MAX_PATCH_CHARACTERS:
            raise ValueError(f"Patch exceeds the maximum size of {MAX_PATCH_CHARACTERS} characters.")
        lines = patch_text.splitlines()
        if len(lines) < 2 or lines[0] != "*** Begin Patch" or lines[-1] != "*** End Patch":
            raise ValueError("Patch must start with '*** Begin Patch' and end with '*** End Patch'.")

        operations: list[PatchOperation] = []
        index = 1
        while index < len(lines) - 1:
            line = lines[index]
            if not line:
                index += 1
                continue
            if line.startswith("*** Move to: "):
                raise ValueError("Move operations are not supported.")
            if line.startswith("*** Add File: "):
                path = line[len("*** Add File: ") :].strip()
                index += 1
                content_lines: list[str] = []
                while index < len(lines) - 1 and not lines[index].startswith("*** "):
                    entry = lines[index]
                    if entry == "*** End of File":
                        index += 1
                        continue
                    if not entry.startswith("+"):
                        raise ValueError("Add File sections may only contain '+' lines.")
                    content_lines.append(entry[1:])
                    index += 1
                operations.append(PatchOperation(kind="add", path=path, content_lines=content_lines))
                continue
            if line.startswith("*** Delete File: "):
                path = line[len("*** Delete File: ") :].strip()
                index += 1
                while index < len(lines) - 1 and not lines[index].startswith("*** "):
                    if lines[index].strip():
                        raise ValueError("Delete File sections must not contain hunk content.")
                    index += 1
                operations.append(PatchOperation(kind="delete", path=path))
                continue
            if line.startswith("*** Update File: "):
                path = line[len("*** Update File: ") :].strip()
                index += 1
                if index < len(lines) - 1 and lines[index].startswith("*** Move to: "):
                    raise ValueError("Move operations are not supported.")
                section_lines: list[str] = []
                while index < len(lines) - 1 and not lines[index].startswith("*** "):
                    if lines[index] != "*** End of File":
                        section_lines.append(lines[index])
                    index += 1
                operations.append(PatchOperation(kind="update", path=path, hunks=self._parse_patch_hunks(section_lines)))
                continue
            raise ValueError(f"Unsupported patch directive: {line}")

        if not operations:
            raise ValueError("Patch does not contain any file operations.")
        if len(operations) > MAX_PATCH_FILES:
            raise ValueError(f"Patch exceeds the maximum of {MAX_PATCH_FILES} file operations.")
        return operations

    def _parse_patch_hunks(self, section_lines: list[str]) -> list[PatchHunk]:
        if not section_lines:
            raise ValueError("Update File sections require at least one hunk.")
        hunks: list[PatchHunk] = []
        current_lines: list[tuple[str, str]] = []

        for line in section_lines:
            if line.startswith("@@"):
                if current_lines:
                    hunks.append(PatchHunk(lines=current_lines))
                    current_lines = []
                continue
            if not line or line[0] not in {" ", "+", "-"}:
                raise ValueError(f"Malformed patch hunk line: {line}")
            current_lines.append((line[0], line[1:]))

        if current_lines:
            hunks.append(PatchHunk(lines=current_lines))
        if not hunks:
            raise ValueError("Update File sections require at least one hunk.")
        for hunk in hunks:
            if not any(kind in {" ", "-"} for kind, _ in hunk.lines):
                raise ValueError("Each update hunk must include at least one context or removed line.")
        return hunks

    def _apply_patch_hunks(self, source: str, hunks: list[PatchHunk]) -> str:
        original_lines = source.splitlines()
        trailing_newline = source.endswith("\n")
        cursor = 0
        output: list[str] = []

        for hunk in hunks:
            expected = [text for kind, text in hunk.lines if kind in {" ", "-"}]
            match_index = self._find_subsequence(original_lines, expected, cursor)
            if match_index is None:
                raise ValueError("Patch context did not match the file exactly.")
            output.extend(original_lines[cursor:match_index])
            scan_index = match_index
            for kind, text in hunk.lines:
                if kind == " ":
                    if scan_index >= len(original_lines) or original_lines[scan_index] != text:
                        raise ValueError("Patch context did not match the file exactly.")
                    output.append(original_lines[scan_index])
                    scan_index += 1
                elif kind == "-":
                    if scan_index >= len(original_lines) or original_lines[scan_index] != text:
                        raise ValueError("Patch removal did not match the file exactly.")
                    scan_index += 1
                elif kind == "+":
                    output.append(text)
            cursor = scan_index

        output.extend(original_lines[cursor:])
        result = "\n".join(output)
        if trailing_newline and (result or source):
            result += "\n"
        return result

    @staticmethod
    def _find_subsequence(lines: list[str], needle: list[str], start: int) -> int | None:
        if not needle:
            return start
        last_index = len(lines) - len(needle)
        for index in range(start, last_index + 1):
            if lines[index : index + len(needle)] == needle:
                return index
        return None

    @staticmethod
    def _join_patch_lines(lines: list[str]) -> str:
        if not lines:
            return ""
        return "\n".join(lines) + "\n"

    @staticmethod
    def _atomic_write_text(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.parent / f".premchat-{path.name}.{uuid.uuid4().hex}.tmp"
        temp_path.write_text(content, encoding="utf-8")
        os.replace(temp_path, path)

    def _resolve_relative_path(self, base_root: Path, relative_path: str, *, allow_missing: bool) -> Path:
        candidate = (base_root / relative_path).resolve()
        if not _path_within(base_root, candidate):
            raise ValueError("Path escapes the allowed workspace root.")
        if not allow_missing and not candidate.exists():
            raise FileNotFoundError(f"Workspace path '{relative_path}' does not exist.")
        return candidate

    def _resolve_command_cwd(self, scope: str, base_root: Path, cwd: str) -> Path:
        if scope == "task" and cwd in {".", ""}:
            cwd = "work"
        workdir = self._resolve_relative_path(base_root, cwd, allow_missing=False)
        if scope == "task":
            task = self._require_task()
            task_root = Path(task.workspace_root)
            work_root = (task_root / "work").resolve()
            outputs_root = (task_root / "outputs").resolve()
            if not (_path_within(work_root, workdir) or _path_within(outputs_root, workdir)):
                raise PermissionError("Task commands may only run from work/ or outputs/.")
        return workdir

    def _validate_command_paths(self, *, scope: str, base_root: Path, workdir: Path, argv: list[str]) -> str | None:
        allowed_roots = [base_root.resolve()]
        if scope == "linked_workspace" and self.context.current_task is not None:
            allowed_roots.append(Path(self.context.current_task.workspace_root).resolve())

        for token in argv[1:]:
            if token in {"-c", "--command", "-e", "--eval"}:
                return build_tool_error_result(
                    tool_name="execute_command",
                    error_type="command_blocked",
                    message="Inline shell or inline code execution flags are blocked. Write a script file and execute that instead.",
                    retryable=False,
                )
            if token.startswith("/"):
                candidate = Path(token).resolve()
            elif "/" in token or token.startswith("."):
                candidate = (workdir / token).resolve()
            else:
                continue
            if not any(_path_within(root, candidate) for root in allowed_roots):
                return build_tool_error_result(
                    tool_name="execute_command",
                    error_type="command_blocked",
                    message=f"Command argument path '{token}' escapes the allowed workspace.",
                    retryable=False,
                )
        return None

    def _task_command_env(self) -> dict[str, str]:
        task = self._require_task()
        venv_bin = Path(task.venv_path) / ("Scripts" if Path(task.venv_path).joinpath("Scripts").exists() else "bin")
        env = dict(os.environ)
        env["VIRTUAL_ENV"] = task.venv_path
        env["PATH"] = str(venv_bin) + os.pathsep + env.get("PATH", "")
        return env

    def _sync_task_outputs_if_needed(self) -> None:
        task = self.context.current_task or self.context.refresh_task()
        if task is None:
            return
        sync_task_output_artifacts(self.context.session, task=task)

    @staticmethod
    def _running_inside_docker() -> bool:
        return Path("/.dockerenv").exists() or os.environ.get("PREMCHAT_COMMAND_SANDBOX") == "docker"

    def _blocked_command_reason(self, argv: list[str]) -> str | None:
        if not argv:
            return None
        head = argv[0].lower()
        blocked_heads = {
            "rm",
            "sudo",
            "dd",
            "mkfs",
            "mount",
            "umount",
            "shutdown",
            "reboot",
            "diskutil",
            "launchctl",
            "osascript",
            "bash",
            "sh",
            "zsh",
            "fish",
        }
        if head in blocked_heads:
            return f"Command '{argv[0]}' is permanently blocked."
        if head in {"python", "python3", "node"} and any(flag in argv[1:] for flag in ("-c", "-e")):
            return "Inline code execution flags are blocked. Write a script file in work/ and execute it instead."
        return None

    def _is_risky_command(self, argv: list[str]) -> tuple[bool, str]:
        if not argv:
            return False, "none"
        head = argv[0].lower()
        normalized = [item.lower() for item in argv]
        joined = " ".join(normalized)
        if head in {"mv", "chmod", "chown"}:
            return True, "destructive_command"
        if head in {"curl", "wget"}:
            return True, "network_command"
        if head in {"pip", "pip3", "npm", "pnpm", "yarn"} and "install" in normalized:
            return True, "dependency_install"
        if len(normalized) >= 3 and normalized[:3] == ["python", "-m", "pip"] and "install" in normalized:
            return True, "dependency_install"
        if len(normalized) >= 3 and normalized[:3] == ["python3", "-m", "pip"] and "install" in normalized:
            return True, "dependency_install"
        if "git clone" in joined:
            return True, "network_command"
        return False, "none"

    def _require_approval_if_needed(
        self,
        *,
        scope: str,
        argv: list[str],
        cwd: str,
        approval_type: str | None = None,
        request_json: dict[str, Any] | None = None,
    ) -> str | None:
        task = self.context.current_task
        if task is None:
            return None
        risky, inferred_type = self._is_risky_command(argv)
        needs_approval = scope == "linked_workspace" or risky
        if not needs_approval and approval_type is None:
            return None
        final_type = approval_type or ("linked_workspace_command" if scope == "linked_workspace" else inferred_type)
        payload = request_json or {"scope": scope, "argv": argv, "cwd": cwd}
        existing = find_matching_approval(self.context.session, task_id=task.id, approval_type=final_type, request_json=payload)
        if existing is not None and existing.status == "approved":
            return None
        approval = existing or create_task_approval(
            self.context.session,
            task_id=task.id,
            agent_run_id=self.context.run.id,
            tool_execution_id=self.context.current_tool_execution_id,
            approval_type=final_type,
            request_json=payload,
        )
        return json.dumps(
            {
                "ok": False,
                "tool_name": "execute_command" if approval_type is None else "linked_workspace_access",
                "error_type": "approval_required",
                "message": "This action requires user approval before Socrates may proceed.",
                "retryable": True,
                "suggestion": f"Wait for approval id {approval.id} to be approved, then retry the exact same tool call.",
                "approval_id": approval.id,
            },
            ensure_ascii=True,
            separators=(",", ":"),
        )

    def _require_task(self) -> Task:
        task = self.context.current_task or self.context.refresh_task()
        if task is None:
            raise PermissionError("Create a task before using task-scoped tools.")
        return task

    def _task_required_error(self, tool_name: str, message: str) -> str:
        return build_tool_error_result(
            tool_name=tool_name,
            error_type="task_required",
            message=message,
            retryable=True,
            suggestion="Call create_task first, then retry the task-scoped action.",
        )

    @staticmethod
    def _now():
        from datetime import datetime, timezone

        return datetime.now(timezone.utc)
