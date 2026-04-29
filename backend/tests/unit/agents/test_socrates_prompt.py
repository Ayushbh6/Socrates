from backend.src.agents.socrates import build_socrates_system_prompt


def test_socrates_prompt_describes_workspace_protocol():
    prompt = build_socrates_system_prompt()

    assert "`list_files`" in prompt
    assert "`read_file`" in prompt
    assert "`search_files`" in prompt
    assert "`edit_file`" in prompt
    assert "`write_file`" in prompt
    assert "`execute_command`" in prompt
    assert "`create_task`" in prompt
    assert "`task.md`" in prompt
    assert "`plan.md`" in prompt
    assert "`todo.md`" in prompt
    assert "Task Lifecycle Doctrine" in prompt
    assert "one-word change" in prompt
    assert "plan MUST be approved" in prompt
    assert "plan_approval_required" in prompt
    assert "todo_required" in prompt
    assert "`update_task_status`" in prompt
    assert "acceptance_required" in prompt
    assert "todo_incomplete" in prompt
    assert "`outputs/`: final deliverables meant for the user" in prompt
    assert "Never write to `task/inputs/` or `task/logs/`" in prompt
    assert "`apply_patch`" in prompt
    assert (
        'use `list_files(scope="project")` first to discover the available resources'
        in prompt
    )
    assert (
        'use `read_file(scope="project", path="...")` on the relevant PDF/image before answering'
        in prompt
    )
    assert (
        "Never claim that no project image or project resource exists unless you verified that with project tools."
        in prompt
    )
