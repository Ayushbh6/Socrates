import pytest

from backend.src.services.task_package import (
    TaskPackageValidationError,
    get_package_state_after_writes,
    get_task_package_disk_state,
    parse_todo_checklist,
    plan_content_fingerprint,
    render_task_markdown,
    validate_task_package_file,
)


def test_render_task_markdown_is_canonical():
    content = render_task_markdown(
        title="Inspect report",
        goal="Review the report.",
        success_criteria="Produce a summary.",
    )

    assert content.startswith("# Task\n")
    assert "## Objective\nInspect report" in content
    assert "## Context\nReview the report." in content
    assert "## Constraints\n" in content
    assert "## Deliverables\n" in content
    assert "## Success Criteria\nProduce a summary." in content
    validate_task_package_file("task.md", content)


def test_plan_validation_reports_missing_sections():
    with pytest.raises(TaskPackageValidationError) as exc_info:
        validate_task_package_file("plan.md", "# Plan\n\n## Summary\nOnly summary.\n")

    assert exc_info.value.error_type == "missing_required_sections"
    assert "## Verification" in exc_info.value.missing_sections


def test_todo_validation_requires_stable_checkbox_ids():
    with pytest.raises(TaskPackageValidationError) as exc_info:
        validate_task_package_file("todo.md", "# Todo\n\n## Checklist\n- do the work\n")

    assert exc_info.value.error_type == "invalid_task_file_format"

    validate_task_package_file("todo.md", "# Todo\n\n## Checklist\n- [ ] T1: Do the work\n- [x] T2: Check it\n")


def test_parse_todo_checklist_reports_checked_and_unchecked_items():
    state = parse_todo_checklist("# Todo\n\n## Checklist\n- [x] T1: Do the work\n- [ ] T2: Verify it\n")

    assert [item.item_id for item in state.items] == ["T1", "T2"]
    assert [item.checked for item in state.items] == [True, False]
    assert state.all_checked is False
    assert [item.item_id for item in state.unchecked_items] == ["T2"]


def test_parse_todo_checklist_reports_all_checked():
    state = parse_todo_checklist("# Todo\n\n## Checklist\n- [x] T1: Do the work\n- [X] T2: Verify it\n")

    assert state.all_checked is True
    assert state.unchecked_items == ()


def test_plan_content_fingerprint_is_deterministic():
    a = plan_content_fingerprint("hello\n")
    b = plan_content_fingerprint("hello\n")
    assert a == b
    assert a != plan_content_fingerprint("hello")
    assert plan_content_fingerprint("# Plan\nA\n") != plan_content_fingerprint("# Plan\nB\n")


def test_get_task_package_disk_state_reports_missing_and_valid(tmp_path):
    task_root = tmp_path / "t"
    task_root.mkdir()
    (task_root / "task.md").write_text(
        "\n".join(
            [
                "# Task",
                "",
                "## Objective",
                "X",
                "",
                "## Context",
                "Y",
                "",
                "## Constraints",
                "Z",
                "",
                "## Deliverables",
                "D",
                "",
                "## Success Criteria",
                "S",
                "",
            ]
        ),
        encoding="utf-8",
    )
    ptext = "\n".join(
        [
            "# Plan",
            "",
            "## Summary",
            "S",
            "",
            "## Approach",
            "A",
            "",
            "## Execution Steps",
            "E",
            "",
            "## Risks",
            "R",
            "",
            "## Verification",
            "V",
            "",
        ]
    )
    (task_root / "plan.md").write_text(ptext, encoding="utf-8")

    st = get_task_package_disk_state(task_root)
    assert st.task.valid is True
    assert st.plan.valid is True
    assert st.todo.exists is False
    assert st.plan_fingerprint == plan_content_fingerprint(ptext)

    st2 = get_package_state_after_writes(task_root, updates={"todo.md": "bad"})
    assert st2.todo.valid is False
    assert st2.todo.error is not None
