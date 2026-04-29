from __future__ import annotations

from dataclasses import dataclass


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


def parse_apply_patch_text(patch_text: str) -> list[PatchOperation]:
    if len(patch_text) > MAX_PATCH_CHARACTERS:
        raise ValueError(
            f"Patch exceeds the maximum size of {MAX_PATCH_CHARACTERS} characters."
        )
    lines = patch_text.splitlines()
    if len(lines) < 2 or lines[0] != "*** Begin Patch" or lines[-1] != "*** End Patch":
        raise ValueError(
            "Patch must start with '*** Begin Patch' and end with '*** End Patch'."
        )

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
            operations.append(
                PatchOperation(kind="add", path=path, content_lines=content_lines)
            )
            continue
        if line.startswith("*** Delete File: "):
            path = line[len("*** Delete File: ") :].strip()
            index += 1
            while index < len(lines) - 1 and not lines[index].startswith("*** "):
                if lines[index].strip():
                    raise ValueError(
                        "Delete File sections must not contain hunk content."
                    )
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
            operations.append(
                PatchOperation(
                    kind="update", path=path, hunks=parse_patch_hunks(section_lines)
                )
            )
            continue
        raise ValueError(f"Unsupported patch directive: {line}")

    if not operations:
        raise ValueError("Patch does not contain any file operations.")
    if len(operations) > MAX_PATCH_FILES:
        raise ValueError(
            f"Patch exceeds the maximum of {MAX_PATCH_FILES} file operations."
        )
    return operations


def parse_patch_hunks(section_lines: list[str]) -> list[PatchHunk]:
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
            raise ValueError(
                "Each update hunk must include at least one context or removed line."
            )
    return hunks


def apply_patch_hunks(source: str, hunks: list[PatchHunk]) -> str:
    original_lines = source.splitlines()
    trailing_newline = source.endswith("\n")
    cursor = 0
    output: list[str] = []

    for hunk in hunks:
        expected = [text for kind, text in hunk.lines if kind in {" ", "-"}]
        match_index = find_subsequence(original_lines, expected, cursor)
        if match_index is None:
            raise ValueError("Patch context did not match the file exactly.")
        output.extend(original_lines[cursor:match_index])
        scan_index = match_index
        for kind, text in hunk.lines:
            if kind == " ":
                if (
                    scan_index >= len(original_lines)
                    or original_lines[scan_index] != text
                ):
                    raise ValueError("Patch context did not match the file exactly.")
                output.append(original_lines[scan_index])
                scan_index += 1
            elif kind == "-":
                if (
                    scan_index >= len(original_lines)
                    or original_lines[scan_index] != text
                ):
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


def join_patch_lines(lines: list[str]) -> str:
    if not lines:
        return ""
    return "\n".join(lines) + "\n"


def find_subsequence(lines: list[str], needle: list[str], start: int) -> int | None:
    if not needle:
        return start
    last_index = len(lines) - len(needle)
    for index in range(start, last_index + 1):
        if lines[index : index + len(needle)] == needle:
            return index
    return None
