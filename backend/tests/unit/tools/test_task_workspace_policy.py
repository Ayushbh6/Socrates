from backend.src.tools.task_workspace_policy import (
    scan_task_workspace_for_reserved_folders,
    task_path_environment,
    validate_task_write_relative_path,
)


def test_task_write_policy_rejects_nested_reserved_folders():
    invalid_paths = [
        "output/squares.txt",
        "work/output/squares.txt",
        "work/outputs/squares.txt",
        "work/folder_1/output/squares.txt",
        "outputs/work/script.py",
        "outputs/logs/run.txt",
    ]

    for path in invalid_paths:
        violations = validate_task_write_relative_path(path)
        assert violations, path
        assert violations[0].canonical_target in {"inputs", "work", "outputs", "logs"}


def test_task_write_policy_allows_work_and_output_files():
    valid_paths = [
        "work/script.py",
        "work/tmp/analysis.json",
        "outputs/squares.txt",
        "outputs/reports/final.md",
    ]

    for path in valid_paths:
        assert validate_task_write_relative_path(path) == []


def test_reserved_folder_scan_removes_empty_violations_and_preserves_non_empty(tmp_path):
    (tmp_path / "work" / "outputs").mkdir(parents=True)
    (tmp_path / "work" / "folder_1" / "output").mkdir(parents=True)
    (tmp_path / "work" / "folder_1" / "output" / "result.txt").write_text(
        "recoverable\n", encoding="utf-8"
    )

    violations = scan_task_workspace_for_reserved_folders(
        tmp_path, auto_remove_empty=True
    )

    by_path = {item.path: item for item in violations}
    assert by_path["work/outputs"].safe_auto_removed is True
    assert by_path["work/outputs"].empty is True
    assert not (tmp_path / "work" / "outputs").exists()
    assert by_path["work/folder_1/output"].safe_auto_removed is False
    assert by_path["work/folder_1/output"].empty is False
    assert (tmp_path / "work" / "folder_1" / "output" / "result.txt").exists()


def test_task_path_environment_exposes_canonical_dirs(tmp_path):
    env = task_path_environment(tmp_path)

    assert env["SOCRATES_TASK_ROOT"] == str(tmp_path.resolve())
    assert env["SOCRATES_INPUTS_DIR"] == str(tmp_path.resolve() / "inputs")
    assert env["SOCRATES_WORK_DIR"] == str(tmp_path.resolve() / "work")
    assert env["SOCRATES_OUTPUTS_DIR"] == str(tmp_path.resolve() / "outputs")
    assert env["SOCRATES_LOGS_DIR"] == str(tmp_path.resolve() / "logs")
