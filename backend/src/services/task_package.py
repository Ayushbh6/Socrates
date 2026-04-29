from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal


TaskPackageFile = Literal["task.md", "plan.md", "todo.md"]

TASK_PACKAGE_FILES: tuple[TaskPackageFile, ...] = ("task.md", "plan.md", "todo.md")
TASK_HEADINGS = ("# Task", "## Objective", "## Context", "## Constraints", "## Deliverables", "## Success Criteria")
PLAN_HEADINGS = ("# Plan", "## Summary", "## Approach", "## Execution Steps", "## Risks", "## Verification")
TODO_HEADINGS = ("# Todo", "## Checklist")
TODO_ITEM_PATTERN = re.compile(r"^- \[(?: |x|X)\] T\d+: \S")
TODO_ITEM_DETAIL_PATTERN = re.compile(r"^- \[(?P<mark> |x|X)\] (?P<item_id>T\d+): (?P<text>\S.*)$")


@dataclass
class TaskPackageValidationError(ValueError):
    error_type: str
    message: str
    missing_sections: tuple[str, ...] = ()
    empty_sections: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        ValueError.__init__(self, self.message)

    def __str__(self) -> str:
        return self.message


@dataclass(frozen=True)
class TodoChecklistItem:
    item_id: str
    text: str
    checked: bool


@dataclass(frozen=True)
class TodoChecklistState:
    items: tuple[TodoChecklistItem, ...]

    @property
    def unchecked_items(self) -> tuple[TodoChecklistItem, ...]:
        return tuple(item for item in self.items if not item.checked)

    @property
    def all_checked(self) -> bool:
        return bool(self.items) and not self.unchecked_items


def render_task_markdown(*, title: str, goal: str, success_criteria: str | None) -> str:
    cleaned_title = title.strip()
    cleaned_goal = goal.strip()
    cleaned_criteria = success_criteria.strip() if success_criteria and success_criteria.strip() else "Complete the task safely and summarize the result."
    return "\n".join(
        [
            "# Task",
            "",
            "## Objective",
            cleaned_title,
            "",
            "## Context",
            cleaned_goal,
            "",
            "## Constraints",
            "Use the runtime-bound task workspace and follow the project safety rules.",
            "",
            "## Deliverables",
            "Produce the requested result in the appropriate task output or response format.",
            "",
            "## Success Criteria",
            cleaned_criteria,
            "",
        ]
    )


def task_package_contract() -> dict[str, object]:
    return {
        "required_files": list(TASK_PACKAGE_FILES),
        "files": {
            "task.md": {"required_headings": list(TASK_HEADINGS)},
            "plan.md": {"required_headings": list(PLAN_HEADINGS)},
            "todo.md": {
                "required_headings": list(TODO_HEADINGS),
                "checklist_format": "- [ ] T1: Describe the action",
                "checked_item_format": "- [x] T1: Describe the completed action",
            },
        },
        "next_step": "Use edit_file to write a valid plan.md at the task root, then get user plan approval before todo.md and implementation work.",
    }


def plan_content_fingerprint(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


@dataclass
class TaskPackageFileStatus:
    exists: bool
    valid: bool
    error: TaskPackageValidationError | None
    content: str | None
    content_sha256: str | None


@dataclass
class TaskPackageDiskState:
    task: TaskPackageFileStatus
    plan: TaskPackageFileStatus
    todo: TaskPackageFileStatus

    @property
    def plan_fingerprint(self) -> str | None:
        if self.plan.valid and self.plan.content is not None and self.plan.content_sha256 is not None:
            return self.plan.content_sha256
        return None


def _read_file_text(path: Path) -> str | None:
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8", errors="replace")


def _file_status(*, path: Path, filename: str) -> TaskPackageFileStatus:
    content = _read_file_text(path)
    exists = content is not None
    if not exists:
        return TaskPackageFileStatus(
            exists=False, valid=False, error=None, content=None, content_sha256=None
        )
    try:
        validate_task_package_file(filename, content)
    except TaskPackageValidationError as exc:
        return TaskPackageFileStatus(
            exists=True, valid=False, error=exc, content=content, content_sha256=plan_content_fingerprint(content)
        )
    sha = plan_content_fingerprint(content)
    return TaskPackageFileStatus(exists=True, valid=True, error=None, content=content, content_sha256=sha)


def get_task_package_disk_state(task_root: Path) -> TaskPackageDiskState:
    root = task_root.resolve()
    return TaskPackageDiskState(
        task=_file_status(path=root / "task.md", filename="task.md"),
        plan=_file_status(path=root / "plan.md", filename="plan.md"),
        todo=_file_status(path=root / "todo.md", filename="todo.md"),
    )


def get_package_state_after_writes(
    task_root: Path, *, updates: dict[str, str | None]
) -> TaskPackageDiskState:
    base = get_task_package_disk_state(task_root)
    for name in ("task.md", "plan.md", "todo.md"):
        if name not in updates:
            continue
        new_val = updates[name]
        if new_val is None:
            empty = TaskPackageFileStatus(
                exists=False, valid=False, error=None, content=None, content_sha256=None
            )
            if name == "task.md":
                base.task = empty
            elif name == "plan.md":
                base.plan = empty
            else:
                base.todo = empty
        else:
            try:
                validate_task_package_file(name, new_val)
            except TaskPackageValidationError as exc:
                err_sha = plan_content_fingerprint(new_val)
                st = TaskPackageFileStatus(
                    exists=True, valid=False, error=exc, content=new_val, content_sha256=err_sha
                )
            else:
                st = TaskPackageFileStatus(
                    exists=True,
                    valid=True,
                    error=None,
                    content=new_val,
                    content_sha256=plan_content_fingerprint(new_val),
                )
            if name == "task.md":
                base.task = st
            elif name == "plan.md":
                base.plan = st
            else:
                base.todo = st
    return base


def validate_task_package_file(filename: str, content: str) -> None:
    if filename == "task.md":
        _validate_headed_document(filename=filename, content=content, headings=TASK_HEADINGS)
        return
    if filename == "plan.md":
        _validate_headed_document(filename=filename, content=content, headings=PLAN_HEADINGS)
        return
    if filename == "todo.md":
        _validate_todo(content)
        return


def parse_todo_checklist(content: str) -> TodoChecklistState:
    validate_task_package_file("todo.md", content)
    lines = content.splitlines()
    checklist_index = next(index for index, line in enumerate(lines) if line.strip() == "## Checklist")
    items: list[TodoChecklistItem] = []
    for line in (line.strip() for line in lines[checklist_index + 1 :] if line.strip()):
        match = TODO_ITEM_DETAIL_PATTERN.match(line)
        if match is None:
            continue
        items.append(
            TodoChecklistItem(
                item_id=match.group("item_id"),
                text=match.group("text"),
                checked=match.group("mark").lower() == "x",
            )
        )
    return TodoChecklistState(items=tuple(items))


def _validate_headed_document(*, filename: str, content: str, headings: tuple[str, ...]) -> None:
    lines = content.splitlines()
    missing = tuple(heading for heading in headings if sum(1 for line in lines if line.strip() == heading) != 1)
    if missing:
        raise TaskPackageValidationError(
            error_type="missing_required_sections",
            message=f"{filename} is missing required section headings or has duplicate headings: {', '.join(missing)}.",
            missing_sections=missing,
        )

    empty_sections: list[str] = []
    for index, heading in enumerate(headings):
        if heading.startswith("# ") and not heading.startswith("## "):
            continue
        start = next(line_index for line_index, line in enumerate(lines) if line.strip() == heading) + 1
        next_heading = headings[index + 1] if index + 1 < len(headings) else None
        if next_heading is None:
            end = len(lines)
        else:
            end = next(line_index for line_index, line in enumerate(lines[start:], start=start) if line.strip() == next_heading)
        body = "\n".join(lines[start:end]).strip()
        if not body:
            empty_sections.append(heading)

    if empty_sections:
        raise TaskPackageValidationError(
            error_type="empty_required_section",
            message=f"{filename} has empty required sections: {', '.join(empty_sections)}.",
            empty_sections=tuple(empty_sections),
        )


def _validate_todo(content: str) -> None:
    _validate_headed_document(filename="todo.md", content=content, headings=TODO_HEADINGS)
    lines = content.splitlines()
    checklist_index = next(index for index, line in enumerate(lines) if line.strip() == "## Checklist")
    checklist_lines = [line.strip() for line in lines[checklist_index + 1 :] if line.strip()]
    checkbox_lines = [line for line in checklist_lines if line.startswith("- [")]
    if not checkbox_lines:
        raise TaskPackageValidationError(
            error_type="invalid_task_file_format",
            message="todo.md must contain at least one markdown checkbox item under ## Checklist.",
        )
    invalid_items = [line for line in checkbox_lines if not TODO_ITEM_PATTERN.match(line)]
    if invalid_items:
        raise TaskPackageValidationError(
            error_type="invalid_task_file_format",
            message="todo.md checklist items must use the format '- [ ] T1: Describe the action' or '- [x] T1: Describe the completed action'.",
        )
