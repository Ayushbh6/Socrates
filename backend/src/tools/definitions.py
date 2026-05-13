from __future__ import annotations

from ..core.schema import ToolDefinition


def _read_tool_definitions() -> list[ToolDefinition]:
    return [
        ToolDefinition(
            name="list_files",
            description="List files in project assets, the current task workspace, or the linked workspace. Supports glob patterns (e.g. '**/*.py') for recursive file discovery.",
            parameters={
                "type": "object",
                "properties": {
                    "scope": {
                        "type": "string",
                        "enum": ["project", "task", "linked_workspace"],
                    },
                    "path": {"type": "string", "default": "."},
                    "pattern": {
                        "type": "string",
                        "description": "Optional glob pattern to filter results, e.g. '**/*.py' or 'src/**/*.ts'. Supports ** for recursive matching.",
                    },
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
                    "scope": {
                        "type": "string",
                        "enum": ["project", "task", "linked_workspace"],
                    },
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
                    "scope": {
                        "type": "string",
                        "enum": ["project", "task", "linked_workspace"],
                    },
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
    ]


def _implementation_tool_definitions() -> list[ToolDefinition]:
    return [
        ToolDefinition(
            name="edit_file",
            description="Replace exact text in one file in the current task workspace or linked workspace.",
            parameters={
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "enum": ["task", "linked_workspace"]},
                    "path": {"type": "string"},
                    "old_text": {"type": "string"},
                    "new_text": {"type": "string"},
                    "replace_all": {"type": "boolean", "default": False},
                    "expected_sha256": {"type": "string"},
                },
                "required": ["scope", "path", "old_text", "new_text"],
            },
        ),
        ToolDefinition(
            name="write_file",
            description="Create or overwrite a whole file in the current task workspace or linked workspace.",
            parameters={
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "enum": ["task", "linked_workspace"]},
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                    "overwrite": {"type": "boolean", "default": False},
                    "expected_sha256": {"type": "string"},
                },
                "required": ["scope", "path", "content"],
            },
        ),
        ToolDefinition(
            name="apply_patch",
            description="Apply an exact-context multi-file patch in the current task workspace or linked workspace. The patch is atomic: if any file or hunk fails validation, no file changes are committed.",
            parameters={
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "enum": ["task", "linked_workspace"]},
                    "patch_text": {"type": "string"},
                    "expected_sha256_map": {
                        "type": "object",
                        "additionalProperties": {"type": "string"},
                    },
                },
                "required": ["scope", "patch_text"],
            },
        ),
    ]


def _command_tool_definition() -> ToolDefinition:
    return ToolDefinition(
        name="execute_command",
        description="Execute a Python command using argv form through the managed Socrates Python runtime in the current task workspace or approved linked workspace. Task commands receive SOCRATES_TASK_ROOT, SOCRATES_WORK_DIR, SOCRATES_OUTPUTS_DIR, SOCRATES_INPUTS_DIR, and SOCRATES_LOGS_DIR environment variables.",
        parameters={
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["task", "linked_workspace"],
                },
                "argv": {"type": "array", "items": {"type": "string"}},
                "cwd": {"type": "string", "default": "."},
                "timeout_sec": {"type": "integer", "default": 60},
            },
            "required": ["scope", "argv"],
        },
    )


def _supervisor_lifecycle_definitions() -> list[ToolDefinition]:
    return [
        ToolDefinition(
            name="write_task_package_file",
            description="Create or revise a canonical task package file. The backend maps file='plan' to plan.md and file='todo' to todo.md; do not provide a path.",
            parameters={
                "type": "object",
                "properties": {
                    "file": {
                        "type": "string",
                        "enum": ["plan", "todo"],
                        "description": "Which canonical task package file to write.",
                    },
                    "content": {"type": "string"},
                },
                "required": ["file", "content"],
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
            name="update_task_status",
            description="Close the active task as completed or failed after lifecycle requirements are satisfied.",
            parameters={
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["completed", "failed"]},
                    "result_summary": {"type": "string"},
                },
                "required": ["status", "result_summary"],
            },
        ),
        ToolDefinition(
            name="start_worker",
            description="Start the bounded worker executor after the active task has an approved plan.md and valid todo.md. Socrates must review the worker result before answering the user.",
            parameters={"type": "object", "properties": {}, "required": []},
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


def build_tool_definitions(*, command_execution_enabled: bool) -> list[ToolDefinition]:
    definitions = [
        *_read_tool_definitions(),
        *_supervisor_lifecycle_definitions(),
    ]
    if command_execution_enabled:
        names = [tool.name for tool in definitions]
        insert_at = names.index("get_system_time")
        definitions.insert(insert_at, _command_tool_definition())
    return definitions


def build_worker_tool_definitions(*, command_execution_enabled: bool) -> list[ToolDefinition]:
    definitions = [
        *_read_tool_definitions(),
    ]
    insert_at = 3
    definitions[insert_at:insert_at] = [
        ToolDefinition(
            name="update_current_todo_item",
            description="Select and update the current worker todo item. Use in_progress to claim the next item, completed with evidence after work, or blocked with reason and recommended_action when stuck. The result returns the updated item and next item.",
            parameters={
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["in_progress", "completed", "blocked"],
                    },
                    "evidence": {
                        "description": "Required when status is completed. Use concrete changed paths, command results, or inspection evidence.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "Required when status is blocked.",
                    },
                    "recommended_action": {
                        "type": "string",
                        "description": "Recommended Socrates action when blocked.",
                    },
                },
                "required": ["status"],
            },
        ),
        ToolDefinition(
            name="skip_todo_item",
            description="Mark the current worker todo item skipped without deleting it. Skips the in-progress item, or the first pending item if none is in progress. Use only when prior completed work genuinely made the current item unnecessary.",
            parameters={
                "type": "object",
                "properties": {
                    "reason": {"type": "string"},
                    "evidence": {
                        "description": "Optional evidence showing why the item is unnecessary.",
                    },
                },
                "required": ["reason"],
            },
        ),
    ]
    definitions.extend(_implementation_tool_definitions())
    if command_execution_enabled:
        definitions.append(_command_tool_definition())
    definitions.append(
        ToolDefinition(
            name="get_system_time",
            description="Returns the current UTC system time and weekday.",
            parameters={"type": "object", "properties": {}, "required": []},
        )
    )
    return definitions
