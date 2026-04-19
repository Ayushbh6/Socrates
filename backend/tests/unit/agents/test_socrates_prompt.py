from backend.src.agents.socrates import build_socrates_system_prompt


def test_socrates_prompt_describes_workspace_protocol():
    prompt = build_socrates_system_prompt()

    assert "`list_files`" in prompt
    assert "`read_file`" in prompt
    assert "`search_files`" in prompt
    assert "`edit_file`" in prompt
    assert "`execute_command`" in prompt
    assert "`create_task`" in prompt
    assert "`inputs/`: backend-managed, read-only." in prompt
    assert "`work/`: your scratch area for scripts" in prompt
    assert "`outputs/`: final deliverables meant for the user" in prompt
    assert "Never write to `task/inputs/`." in prompt
    assert "Never write to `task/logs/`." in prompt
    assert "`multi_edit`" in prompt
    assert "`apply_patch`" in prompt
