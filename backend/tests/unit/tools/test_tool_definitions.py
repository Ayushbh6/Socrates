from backend.src.tools.definitions import build_tool_definitions, build_worker_tool_definitions


def test_tool_definitions_include_lean_edit_surface_without_command():
    definitions = build_tool_definitions(command_execution_enabled=False)
    names = [tool.name for tool in definitions]

    assert names == [
        "list_files",
        "read_file",
        "search_files",
        "edit_file",
        "write_file",
        "apply_patch",
        "create_task",
        "update_task_status",
        "start_worker",
        "write_project_note",
        "get_system_time",
    ]

    edit_schema = next(
        tool.parameters for tool in definitions if tool.name == "edit_file"
    )
    assert "operation" not in edit_schema["properties"]
    assert edit_schema["required"] == ["scope", "path", "old_text", "new_text"]


def test_tool_definitions_conditionally_include_execute_command():
    definitions = build_tool_definitions(command_execution_enabled=True)
    names = [tool.name for tool in definitions]

    assert "execute_command" in names
    assert len(names) == 12
    command = next(tool for tool in definitions if tool.name == "execute_command")
    assert "SOCRATES_OUTPUTS_DIR" in command.description


def test_worker_tool_definitions_use_worker_allowlist():
    definitions = build_worker_tool_definitions(command_execution_enabled=True)
    names = [tool.name for tool in definitions]

    assert names == [
        "list_files",
        "read_file",
        "search_files",
        "update_current_todo_item",
        "skip_todo_item",
        "edit_file",
        "write_file",
        "apply_patch",
        "execute_command",
        "get_system_time",
    ]
    assert "create_task" not in names
    assert "update_task_status" not in names
    assert "start_worker" not in names
