from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path, PurePosixPath


TASK_ROOT_DIRS = ("inputs", "work", "outputs", "logs")
RESERVED_TASK_FOLDER_NAMES = frozenset(
    {"input", "inputs", "output", "outputs", "log", "logs", "work"}
)
CANONICAL_TASK_FOLDER_BY_RESERVED = {
    "input": "inputs",
    "inputs": "inputs",
    "output": "outputs",
    "outputs": "outputs",
    "log": "logs",
    "logs": "logs",
    "work": "work",
}
SINGULAR_RESERVED_ROOTS = {"input", "output", "log"}


@dataclass(frozen=True)
class ReservedTaskFolderViolation:
    path: str
    reserved_name: str
    canonical_target: str
    empty: bool
    safe_auto_removed: bool = False

    def as_dict(self) -> dict[str, object]:
        return {
            "path": self.path,
            "reserved_name": self.reserved_name,
            "canonical_target": self.canonical_target,
            "empty": self.empty,
            "safe_auto_removed": self.safe_auto_removed,
        }


def validate_task_write_relative_path(path: str) -> list[ReservedTaskFolderViolation]:
    parts = _logical_parts(path)
    if not parts:
        return []
    violations: list[ReservedTaskFolderViolation] = []
    first = parts[0].lower()
    if first in SINGULAR_RESERVED_ROOTS:
        violations.append(_violation_from_parts(parts[:1], empty=False))
    for index, part in enumerate(parts[1:], start=1):
        if part.lower() in RESERVED_TASK_FOLDER_NAMES:
            violations.append(_violation_from_parts(parts[: index + 1], empty=False))
    return violations


def scan_task_workspace_for_reserved_folders(
    task_root: Path, *, auto_remove_empty: bool
) -> list[ReservedTaskFolderViolation]:
    root = task_root.resolve()
    if not root.exists():
        return []
    candidates = sorted(
        (path for path in root.rglob("*") if path.is_dir()),
        key=lambda path: len(path.relative_to(root).parts),
        reverse=True,
    )
    violations: list[ReservedTaskFolderViolation] = []
    for directory in candidates:
        rel_parts = directory.relative_to(root).parts
        if not _directory_is_reserved_violation(rel_parts):
            continue
        empty = _is_empty_dir(directory)
        removed = False
        if empty and auto_remove_empty:
            directory.rmdir()
            removed = True
        violations.append(
            ReservedTaskFolderViolation(
                path="/".join(rel_parts),
                reserved_name=rel_parts[-1],
                canonical_target=CANONICAL_TASK_FOLDER_BY_RESERVED[
                    rel_parts[-1].lower()
                ],
                empty=empty,
                safe_auto_removed=removed,
            )
        )
    return list(reversed(violations))


def task_path_environment(task_root: Path) -> dict[str, str]:
    root = task_root.resolve()
    return {
        "SOCRATES_TASK_ROOT": str(root),
        "SOCRATES_INPUTS_DIR": str(root / "inputs"),
        "SOCRATES_WORK_DIR": str(root / "work"),
        "SOCRATES_OUTPUTS_DIR": str(root / "outputs"),
        "SOCRATES_LOGS_DIR": str(root / "logs"),
    }


def reserved_violation_message(violation: ReservedTaskFolderViolation) -> str:
    parts = violation.path.split("/")
    name = violation.reserved_name
    canonical = violation.canonical_target
    if len(parts) == 1:
        return (
            f"You cannot create {name}/ as a task root. "
            f"Use the existing task root folder: {canonical}/."
        )
    parent = "/".join(parts[:-1])
    return (
        f"You cannot create another {name}/ folder inside {parent}/. "
        f"Use the existing task root folder: {canonical}/."
    )


def reserved_violation_suggestion() -> str:
    return (
        "Write scratch files under work/ and final deliverables under outputs/. "
        "If a script runs from work/, write outputs using SOCRATES_OUTPUTS_DIR."
    )


def command_reserved_violation_suggestion() -> str:
    return (
        "Move any final deliverables into the top-level outputs/ folder, update "
        "the script to use SOCRATES_OUTPUTS_DIR, remove the nested folder, and "
        "rerun verification."
    )


def _logical_parts(path: str) -> tuple[str, ...]:
    cleaned = path.strip().replace("\\", "/")
    if not cleaned:
        return ()
    return tuple(part for part in PurePosixPath(cleaned).parts if part not in {"."})


def _violation_from_parts(parts: tuple[str, ...], *, empty: bool) -> ReservedTaskFolderViolation:
    reserved_name = parts[-1]
    return ReservedTaskFolderViolation(
        path="/".join(parts),
        reserved_name=reserved_name,
        canonical_target=CANONICAL_TASK_FOLDER_BY_RESERVED[reserved_name.lower()],
        empty=empty,
    )


def _directory_is_reserved_violation(parts: tuple[str, ...]) -> bool:
    if not parts:
        return False
    name = parts[-1].lower()
    if name not in RESERVED_TASK_FOLDER_NAMES:
        return False
    if len(parts) == 1:
        return name in SINGULAR_RESERVED_ROOTS
    return True


def _is_empty_dir(path: Path) -> bool:
    try:
        next(path.iterdir())
        return False
    except StopIteration:
        return True
