from backend.src.tools.definitions import build_tool_definitions, build_worker_tool_definitions


def test_tool_definitions_include_lean_edit_surface_without_command():
    definitions = build_tool_definitions(command_execution_enabled=False)
    names = [tool.name for tool in definitions]

    assert names == [
        "list_files",
        "read_file",
        "search_files",
        "write_task_package_file",
        "create_task",
        "update_task_status",
        "start_worker",
        "write_project_note",
        "get_system_time",
    ]

    package_schema = next(
        tool.parameters for tool in definitions if tool.name == "write_task_package_file"
    )
    assert package_schema["properties"]["file"]["enum"] == ["plan", "todo"]
    assert package_schema["required"] == ["file", "content"]


def test_tool_definitions_conditionally_include_execute_command():
    definitions = build_tool_definitions(command_execution_enabled=True)
    names = [tool.name for tool in definitions]

    assert "execute_command" in names
    assert len(names) == 10
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
    skip_schema = next(tool.parameters for tool in definitions if tool.name == "skip_todo_item")
    assert "todo_id" not in skip_schema["properties"]
    assert skip_schema["required"] == ["reason"]
