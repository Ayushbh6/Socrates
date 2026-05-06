from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from sqlalchemy.orm import Session

from ..agent.tools import build_tool_error_result
from ..core.schema import ToolCall, ToolDefinition
from ..db.models import (
    AgentRun,
    Asset,
    ProjectWorkspace,
    Task,
    ToolExecution,
)
from ..services.tasks import (
    create_task_approval,
    ensure_plan_approval_for_revision,
    find_matching_approval,
    get_active_task_for_conversation,
    is_plan_sha256_approved,
    sync_task_output_artifacts,
)
from ..services.python_runtime import ensure_managed_python_runtime
from ..services.task_package import (
    TASK_PACKAGE_FILES,
    TaskPackageDiskState,
    TaskPackageValidationError,
    get_package_state_after_writes,
    get_task_package_disk_state,
    plan_content_fingerprint,
    validate_task_package_file,
)
from .list_resources import make_list_resources
from .read_resource import make_read_resource
from .system_time import get_system_time
from .utils import _path_within, resolve_asset_path
from .definitions import build_tool_definitions
from .task_workspace_policy import (
    ReservedTaskFolderViolation,
    command_reserved_violation_suggestion,
    reserved_violation_message,
    reserved_violation_suggestion,
    scan_task_workspace_for_reserved_folders,
    task_path_environment,
    validate_task_write_relative_path,
)
from . import apply_patch as apply_patch_tool
from . import create_task as create_task_tool
from . import edit_file as edit_file_tool
from . import execute_command as execute_command_tool
from . import list_files as list_files_tool
from . import read_file as read_file_tool
from . import search_files as search_files_tool
from . import start_worker as start_worker_tool
from . import update_task_status as update_task_status_tool
from . import write_file as write_file_tool
from . import write_project_note as write_project_note_tool


@dataclass
class ToolContext:
    session: Session
    project_id: str
    conversation_id: str
    run: AgentRun
    uploads_dir: Path
    current_task: Task | None = None
    current_tool_execution_id: str | None = None
    parent_event_sink: Callable[[dict[str, Any]], None] | None = None

    def refresh_task(self) -> Task | None:
        self.current_task = get_active_task_for_conversation(
            self.session, self.conversation_id
        )
        return self.current_task


class ProjectToolRuntime:
    def __init__(self, context: ToolContext):
        self.context = context
        self._command_execution_enabled = True
        self._project_list_resources = make_list_resources(
            context.session, context.project_id
        )
        self._project_read_resource = make_read_resource(
            context.session, context.project_id, context.uploads_dir
        )
        self.definitions = self._build_definitions()
        self.handlers: dict[str, Callable[..., Any]] = {
            "list_files": lambda **kwargs: list_files_tool.handle(self, **kwargs),
            "read_file": lambda **kwargs: read_file_tool.handle(self, **kwargs),
            "search_files": lambda **kwargs: search_files_tool.handle(self, **kwargs),
            "edit_file": lambda **kwargs: edit_file_tool.handle(self, **kwargs),
            "write_file": lambda **kwargs: write_file_tool.handle(self, **kwargs),
            "apply_patch": lambda **kwargs: apply_patch_tool.handle(self, **kwargs),
            "get_system_time": get_system_time,
            "create_task": lambda **kwargs: create_task_tool.handle(self, **kwargs),
            "start_worker": lambda **kwargs: start_worker_tool.handle(self, **kwargs),
            "update_task_status": lambda **kwargs: update_task_status_tool.handle(
                self, **kwargs
            ),
            "write_project_note": lambda **kwargs: write_project_note_tool.handle(
                self, **kwargs
            ),
        }
        if self._command_execution_enabled:
            self.handlers["execute_command"] = lambda **kwargs: (
                execute_command_tool.handle(self, **kwargs)
            )

    def _build_definitions(self) -> list[ToolDefinition]:
        return build_tool_definitions(
            command_execution_enabled=self._command_execution_enabled
        )

    def execute(self, tool_call: ToolCall) -> Any:
        handler = self.handlers.get(tool_call.name)
        if handler is None:
            return build_tool_error_result(
                tool_name=tool_call.name,
                error_type="missing_tool",
                message=f"No handler registered for tool '{tool_call.name}'.",
                suggestion="Call one of the available tools instead.",
            )

        tool_execution = ToolExecution(
            agent_run_id=self.context.run.id,
            task_id=self.context.current_task.id if self.context.current_task else None,
            tool_call_id=tool_call.id,
            tool_name=tool_call.name,
            arguments_json=tool_call.arguments,
            status="running",
            started_at=self._now(),
        )
        self.context.session.add(tool_execution)
        self.context.session.commit()
        self.context.current_tool_execution_id = tool_execution.id

        try:
            result = handler(**tool_call.arguments)
            tool_execution.status = "completed"
            if self.context.current_task is not None:
                tool_execution.task_id = self.context.current_task.id
            elif self.context.run.task_id is not None:
                tool_execution.task_id = self.context.run.task_id
            if isinstance(result, str):
                tool_execution.result_text = result
                try:
                    tool_execution.result_json = json.loads(result)
                except json.JSONDecodeError:
                    tool_execution.result_json = {"result": result}
            else:
                tool_execution.result_json = result
                tool_execution.result_text = json.dumps(result, default=str)
            return result
        except Exception as exc:
            tool_execution.status = "failed"
            tool_execution.error_text = str(exc)
            tool_execution.result_json = {
                "ok": False,
                "tool_name": tool_call.name,
                "error_type": exc.__class__.__name__,
                "message": str(exc),
                "retryable": False,
            }
            tool_execution.result_text = json.dumps(
                tool_execution.result_json, default=str
            )
            raise
        finally:
            tool_execution.completed_at = self._now()
            self.context.session.commit()
            self.context.current_tool_execution_id = None

    def _search_project_assets(
        self,
        *,
        query: str,
        path: str,
        include_glob: str,
        exclude_glob: str | None,
        max_matches: int,
        context_lines: int,
        case_sensitive: bool,
        regex: bool,
    ):
        pattern = self._compile_search_pattern(
            query=query, case_sensitive=case_sensitive, regex=regex
        )
        assets = (
            self.context.session.query(Asset)
            .filter(
                Asset.project_id == self.context.project_id, Asset.deleted_at == None
            )
            .all()
        )
        matches: list[dict[str, Any]] = []
        for asset in assets:
            if not self._project_asset_matches(
                asset.original_name,
                path=path,
                include_glob=include_glob,
                exclude_glob=exclude_glob,
            ):
                continue
            asset_path = resolve_asset_path(
                self.context.session,
                self.context.project_id,
                asset.original_name,
                self.context.uploads_dir,
            )
            if asset_path is None:
                continue
            try:
                text = self._read_project_asset_text(asset_path)
            except Exception:
                continue
            lines = text.splitlines()
            for index, line in enumerate(lines):
                match = pattern.search(line)
                if not match:
                    continue
                start = max(0, index - context_lines)
                end = min(len(lines), index + context_lines + 1)
                matches.append(
                    {
                        "asset_id": asset.id,
                        "path": asset.original_name,
                        "filename": asset.original_name,
                        "line_no": index + 1,
                        "match": line.strip(),
                        "column_start": match.start() + 1,
                        "column_end": match.end(),
                        "context": lines[start:end],
                    }
                )
                if len(matches) >= max_matches:
                    break
            if len(matches) >= max_matches:
                break
        return {
            "query": query,
            "match_count": len(matches),
            "matches": matches,
            "truncated": len(matches) == max_matches,
        }

    @staticmethod
    def _remap_project_tool_result(result: Any, *, tool_name: str) -> Any:
        if not isinstance(result, str):
            return result
        try:
            payload = json.loads(result)
        except json.JSONDecodeError:
            return result
        if isinstance(payload, dict) and payload.get("tool_name"):
            payload["tool_name"] = tool_name
            return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
        return result

    def _current_user_message_accepts_completion(self) -> bool:
        text = (self.context.run.query_text or "").strip().lower()
        normalized = re.sub(r"\s+", " ", text)
        acceptance_phrases = (
            "i accept",
            "accepted",
            "i approve",
            "approved",
            "looks good",
            "looks great",
            "ship it",
            "mark it complete",
            "mark as complete",
            "mark the task complete",
            "complete the task",
            "task complete",
            "we are done",
            "this is done",
            "i am satisfied",
            "i'm satisfied",
        )
        return any(phrase in normalized for phrase in acceptance_phrases)

    def _resolve_edit_target(
        self, scope: str, path: str, *, allow_missing: bool
    ) -> tuple[Path, str | None]:
        base_root, workspace_id = self._resolve_scope_root(scope)
        target = self._resolve_relative_path(
            base_root, path, allow_missing=allow_missing
        )
        if scope == "task":
            task = self._require_task()
            task_root = Path(task.workspace_root).resolve()
            work_root = (task_root / "work").resolve()
            outputs_root = (task_root / "outputs").resolve()
            relative_path = str(target.relative_to(task_root))
            is_package_file = relative_path in TASK_PACKAGE_FILES
            if not (
                _path_within(work_root, target)
                or _path_within(outputs_root, target)
                or is_package_file
            ):
                raise PermissionError(
                    "Task edits are only allowed inside work/, outputs/, task.md, plan.md, and todo.md."
                )
        return target, workspace_id

    def _validate_task_package_write(
        self, target: Path, content: str, *, tool_name: str = "edit_file"
    ) -> str | None:
        if self.context.current_task is None:
            return None
        task_root = Path(self.context.current_task.workspace_root).resolve()
        try:
            relative_path = str(target.resolve().relative_to(task_root))
        except ValueError:
            return None
        if relative_path not in TASK_PACKAGE_FILES:
            return None
        try:
            validate_task_package_file(relative_path, content)
        except TaskPackageValidationError as exc:
            return self._task_package_validation_error(exc, tool_name=tool_name)
        return None

    def _validate_task_package_delete(
        self, relative_path: Path, *, tool_name: str = "edit_file"
    ) -> str | None:
        path = str(relative_path)
        if path not in TASK_PACKAGE_FILES:
            return None
        return self._task_package_validation_error(
            TaskPackageValidationError(
                error_type="invalid_task_file_format",
                message=f"{path} is a canonical task package file and cannot be deleted.",
            ),
            tool_name=tool_name,
        )

    def _task_package_validation_error(
        self, exc: TaskPackageValidationError, *, tool_name: str = "edit_file"
    ) -> str:
        payload: dict[str, Any] = {
            "ok": False,
            "tool_name": tool_name,
            "error_type": exc.error_type,
            "message": exc.message,
            "retryable": True,
            "suggestion": "Repair the task package file so it matches the canonical required structure, then retry the write.",
        }
        if exc.missing_sections:
            payload["missing_sections"] = list(exc.missing_sections)
        if exc.empty_sections:
            payload["empty_sections"] = list(exc.empty_sections)
        return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))

    def _lifecycle_gate_error(
        self, *, tool_name: str, error_type: str, message: str, suggestion: str
    ) -> str:
        return build_tool_error_result(
            tool_name=tool_name,
            error_type=error_type,
            message=message,
            retryable=True,
            suggestion=suggestion,
        )

    def _reserved_task_folder_error(
        self, *, tool_name: str, path: str
    ) -> str | None:
        violations = validate_task_write_relative_path(path)
        if not violations:
            return None
        return build_tool_error_result(
            tool_name=tool_name,
            error_type="reserved_task_folder_misuse",
            message=reserved_violation_message(violations[0]),
            retryable=True,
            suggestion=reserved_violation_suggestion(),
            extra={"violations": [item.as_dict() for item in violations]},
        )

    def _reserved_task_command_error(
        self,
        *,
        command_result: dict[str, Any],
        violations: list[ReservedTaskFolderViolation],
    ) -> str:
        return build_tool_error_result(
            tool_name="execute_command",
            error_type="reserved_task_folder_created",
            message=(
                "The command created a nested reserved folder: "
                f"{violations[0].path}. "
                f"{reserved_violation_message(violations[0])}"
            ),
            retryable=True,
            suggestion=command_reserved_violation_suggestion(),
            extra={
                "violations": [item.as_dict() for item in violations],
                "command_result": command_result,
            },
        )

    def _scan_task_workspace_for_reserved_folders(
        self,
    ) -> list[ReservedTaskFolderViolation]:
        task = self.context.current_task or self.context.refresh_task()
        if task is None:
            return []
        return scan_task_workspace_for_reserved_folders(
            Path(task.workspace_root).resolve(), auto_remove_empty=True
        )

    @staticmethod
    def _task_relative_area(relative_path: str) -> str:
        if relative_path in TASK_PACKAGE_FILES:
            if relative_path == "task.md":
                return "task_md"
            if relative_path == "plan.md":
                return "plan_md"
            return "todo_md"
        if relative_path == "work" or relative_path.startswith("work/"):
            return "work"
        if relative_path == "outputs" or relative_path.startswith("outputs/"):
            return "outputs"
        return "other"

    def _assert_lifecycle_for_todo_write(
        self, state: TaskPackageDiskState, *, tool_name: str
    ) -> str | None:
        if not state.task.valid:
            return self._lifecycle_gate_error(
                tool_name=tool_name,
                error_type="planning_required",
                message="task.md must be valid before creating or updating todo.md.",
                suggestion="Repair task.md to match the canonical structure, then write a valid plan.md and obtain plan approval.",
            )
        if not state.plan.valid:
            return self._lifecycle_gate_error(
                tool_name=tool_name,
                error_type="planning_required",
                message="plan.md must exist and be valid before todo.md.",
                suggestion="Write a valid plan.md at the task root and wait for user plan approval before todo.md.",
            )
        fp = state.plan_fingerprint
        if fp is None:
            return self._lifecycle_gate_error(
                tool_name=tool_name,
                error_type="planning_required",
                message="plan.md must be valid before todo.md.",
                suggestion="Write a valid plan.md at the task root.",
            )
        task = self._require_task()
        if not is_plan_sha256_approved(self.context.session, task.id, fp):
            return self._lifecycle_gate_error(
                tool_name=tool_name,
                error_type="plan_approval_required",
                message="The execution plan must be approved before todo.md can be created or updated.",
                suggestion="Wait for the user to approve the plan review, then retry this write with the same approved plan.md.",
            )
        return None

    def _assert_lifecycle_for_work_or_outputs(
        self, state: TaskPackageDiskState, *, tool_name: str
    ) -> str | None:
        err = self._assert_lifecycle_for_todo_write(state, tool_name=tool_name)
        if err is not None:
            return err
        if not state.todo.valid:
            return self._lifecycle_gate_error(
                tool_name=tool_name,
                error_type="todo_required",
                message="todo.md must exist and be valid before implementation work in work/ or outputs/.",
                suggestion="After plan approval, write a valid todo.md checklist, then begin work under work/ or outputs/.",
            )
        return None

    def _assert_full_task_lifecycle_for_linked_mutation(
        self, *, tool_name: str
    ) -> str | None:
        task = self._require_task()
        state = get_task_package_disk_state(Path(task.workspace_root).resolve())
        return self._assert_lifecycle_for_work_or_outputs(state, tool_name=tool_name)

    def _virtual_state_for_lifecycle(
        self, task_root: Path, *, rel_path: str, final_text: str | None, is_delete: bool
    ) -> TaskPackageDiskState:
        updates: dict[str, str | None] = {}
        if rel_path in TASK_PACKAGE_FILES:
            updates[rel_path] = None if is_delete else (final_text or "")
        if updates:
            return get_package_state_after_writes(task_root, updates=updates)
        return get_task_package_disk_state(task_root)

    def _check_lifecycle_before_task_write(
        self,
        *,
        task_root: Path,
        relative_path: str,
        final_text: str | None,
        is_delete: bool,
        tool_name: str,
    ) -> str | None:
        area = self._task_relative_area(relative_path)
        if area in ("task_md", "plan_md"):
            return None
        if area == "todo_md" and not is_delete and final_text is not None:
            state = self._virtual_state_for_lifecycle(
                task_root,
                rel_path=relative_path,
                final_text=final_text,
                is_delete=False,
            )
            return self._assert_lifecycle_for_todo_write(state, tool_name=tool_name)
        if area in ("work", "outputs"):
            return self._assert_lifecycle_for_work_or_outputs(
                get_task_package_disk_state(task_root), tool_name=tool_name
            )
        return None

    def _attach_plan_approval_extras(
        self, result: dict[str, Any], plan_text: str
    ) -> dict[str, Any]:
        task = self._require_task()
        app = ensure_plan_approval_for_revision(
            self.context.session,
            task_id=task.id,
            agent_run_id=self.context.run.id,
            tool_execution_id=self.context.current_tool_execution_id,
            plan_sha256=plan_content_fingerprint(plan_text),
        )
        if self.context.current_task is not None:
            self.context.session.refresh(self.context.current_task)
        if app is not None:
            result = {
                **result,
                "approval_id": app.id,
                "next_step": "Wait for the user to approve the plan, then create todo.md.",
            }
        return result

    def _resolve_scope_root(self, scope: str) -> tuple[Path, str | None]:
        if scope == "project":
            raise ValueError("Project scope does not have a writable workspace root.")
        if scope == "task":
            task = self._require_task()
            return Path(task.workspace_root), None
        if scope == "linked_workspace":
            task = self._require_task()
            if task.project_workspace_id is None:
                raise PermissionError("This task is not linked to a project workspace.")
            workspace = self.context.session.get(
                ProjectWorkspace, task.project_workspace_id
            )
            if (
                workspace is None
                or not workspace.access_granted
                or workspace.access_revoked_at is not None
            ):
                raise PermissionError("Linked workspace access has not been granted.")
            workspace_root = Path(workspace.root_path).resolve()
            return workspace_root, workspace.id
        raise ValueError("Unsupported workspace scope.")

    @staticmethod
    def _compile_search_pattern(
        *, query: str, case_sensitive: bool, regex: bool
    ) -> re.Pattern[str]:
        flags = 0 if case_sensitive else re.IGNORECASE
        return re.compile(query if regex else re.escape(query), flags)

    @staticmethod
    def _project_asset_matches(
        name: str, *, path: str, include_glob: str, exclude_glob: str | None
    ) -> bool:
        if path not in {"", "."}:
            if any(char in path for char in "*?[]"):
                if not fnmatch.fnmatch(name, path):
                    return False
            elif not (name == path or name.startswith(path.rstrip("/") + "/")):
                return False
        if (
            include_glob
            and include_glob != "**"
            and not fnmatch.fnmatch(name, include_glob)
        ):
            return False
        if exclude_glob and fnmatch.fnmatch(name, exclude_glob):
            return False
        return True

    def _collect_search_paths(
        self,
        *,
        base_root: Path,
        target: Path,
        include_glob: str,
        exclude_glob: str | None,
    ) -> list[Path]:
        if target.is_file():
            return [target]
        paths: list[Path] = []
        for item in target.rglob("*"):
            if not item.is_file():
                continue
            relative_name = str(item.relative_to(base_root))
            if (
                include_glob
                and include_glob != "**"
                and not fnmatch.fnmatch(relative_name, include_glob)
            ):
                continue
            if exclude_glob and fnmatch.fnmatch(relative_name, exclude_glob):
                continue
            paths.append(item)
        return paths

    @staticmethod
    def _read_project_asset_text(path: Path) -> str:
        if path.suffix.lower() == ".pdf":
            import pypdf

            with path.open("rb") as handle:
                reader = pypdf.PdfReader(handle)
                return "".join(
                    (page.extract_text() or "") + "\n" for page in reader.pages
                )
        return path.read_text(encoding="utf-8", errors="replace")

    def _build_line_range_result(
        self,
        *,
        path: str,
        content: str,
        line_start: int | None,
        line_end: int | None,
        asset_id: str | None = None,
    ) -> dict[str, Any]:
        lines = content.splitlines()
        total_lines = len(lines)
        start = line_start or 1
        end = total_lines if line_end in {None, -1} else line_end
        start_index = min(max(start, 1), total_lines + 1) - 1
        end_index = min(max(end, 0), total_lines)
        selected = lines[start_index:end_index]
        chunk = "\n".join(selected)
        if selected and content.endswith("\n") and end_index == total_lines:
            chunk += "\n"
        result = {
            "path": path,
            "content": chunk,
            "line_start": start,
            "line_end": end
            if end != total_lines or line_end not in {None, -1}
            else total_lines,
            "total_lines": total_lines,
            "more_available_before": start_index > 0,
            "more_available_after": end_index < total_lines,
        }
        if asset_id is not None:
            result["asset_id"] = asset_id
        return result

    @staticmethod
    def _sha256_text(content: str) -> str:
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    def _check_expected_sha256(self, target: Path, expected_sha256: str | None) -> None:
        if not expected_sha256:
            return
        if not target.exists():
            raise FileNotFoundError(f"'{target.name}' does not exist.")
        current = self._sha256_text(
            target.read_text(encoding="utf-8", errors="replace")
        )
        if current != expected_sha256:
            raise RuntimeError(
                "Edit conflict: file content has changed since it was last read."
            )

    @staticmethod
    def _atomic_write_text(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = path.parent / f".premchat-{path.name}.{uuid.uuid4().hex}.tmp"
        temp_path.write_text(content, encoding="utf-8")
        os.replace(temp_path, path)

    def _resolve_relative_path(
        self, base_root: Path, relative_path: str, *, allow_missing: bool
    ) -> Path:
        candidate = (base_root / relative_path).resolve()
        if not _path_within(base_root, candidate):
            raise ValueError("Path escapes the allowed workspace root.")
        if not allow_missing and not candidate.exists():
            raise FileNotFoundError(f"Workspace path '{relative_path}' does not exist.")
        return candidate

    def _resolve_command_cwd(self, scope: str, base_root: Path, cwd: str) -> Path:
        if scope == "task" and cwd in {".", ""}:
            cwd = "work"
        workdir = self._resolve_relative_path(base_root, cwd, allow_missing=False)
        if scope == "task":
            task = self._require_task()
            task_root = Path(task.workspace_root)
            work_root = (task_root / "work").resolve()
            outputs_root = (task_root / "outputs").resolve()
            if not (
                _path_within(work_root, workdir) or _path_within(outputs_root, workdir)
            ):
                raise PermissionError(
                    "Task commands may only run from work/ or outputs/."
                )
        return workdir

    def _validate_command_paths(
        self, *, scope: str, base_root: Path, workdir: Path, argv: list[str]
    ) -> str | None:
        allowed_roots = [base_root.resolve()]
        if scope == "linked_workspace" and self.context.current_task is not None:
            allowed_roots.append(
                Path(self.context.current_task.workspace_root).resolve()
            )

        for token in argv[1:]:
            if token in {"-c", "--command", "-e", "--eval"}:
                return build_tool_error_result(
                    tool_name="execute_command",
                    error_type="command_blocked",
                    message="Inline shell or inline code execution flags are blocked. Write a script file and execute that instead.",
                    retryable=False,
                )
            if token.startswith("/"):
                candidate = Path(token).resolve()
            elif "/" in token or token.startswith("."):
                candidate = (workdir / token).resolve()
            else:
                continue
            if not any(_path_within(root, candidate) for root in allowed_roots):
                return build_tool_error_result(
                    tool_name="execute_command",
                    error_type="command_blocked",
                    message=f"Command argument path '{token}' escapes the allowed workspace.",
                    retryable=False,
                )
        return None

    def _task_command_env(self) -> dict[str, str]:
        task = self._require_task()
        status = ensure_managed_python_runtime()
        if Path(task.venv_path) != status.venv_path:
            task.venv_path = str(status.venv_path)
            self.context.session.add(task)
            self.context.session.commit()
        venv_bin = status.python_path.parent
        env = dict(os.environ)
        env["VIRTUAL_ENV"] = str(status.venv_path)
        env["PATH"] = str(venv_bin) + os.pathsep + env.get("PATH", "")
        env.update(task_path_environment(Path(task.workspace_root)))
        return env

    def _normalize_python_command_argv(self, argv: list[str]) -> list[str] | str:
        if not argv:
            raise ValueError("argv must contain at least one argument.")
        head = self._command_head(argv)
        if head not in {"python", "python3", "python.exe"}:
            return build_tool_error_result(
                tool_name="execute_command",
                error_type="command_blocked",
                message="Only Python commands are supported in the Socrates managed runtime.",
                retryable=False,
                suggestion="Write a Python script in work/ and run it with argv starting with python or python3.",
            )
        status = ensure_managed_python_runtime()
        return [str(status.python_path), *argv[1:]]

    def _sync_task_outputs_if_needed(self) -> list[str]:
        task = self.context.current_task or self.context.refresh_task()
        if task is None:
            return []
        artifacts = sync_task_output_artifacts(self.context.session, task=task)
        return [artifact.relative_path for artifact in artifacts]

    def _blocked_command_reason(self, argv: list[str]) -> str | None:
        if not argv:
            return None
        head = self._command_head(argv)
        blocked_heads = {
            "rm",
            "sudo",
            "dd",
            "mkfs",
            "mount",
            "umount",
            "shutdown",
            "reboot",
            "diskutil",
            "launchctl",
            "osascript",
            "bash",
            "sh",
            "zsh",
            "fish",
        }
        if head in blocked_heads:
            return f"Command '{argv[0]}' is permanently blocked."
        if head in {"python", "python3", "node"} and any(
            flag in argv[1:] for flag in ("-c", "-e")
        ):
            return "Inline code execution flags are blocked. Write a script file in work/ and execute it instead."
        return None

    def _is_risky_command(self, argv: list[str]) -> tuple[bool, str]:
        if not argv:
            return False, "none"
        head = self._command_head(argv)
        normalized = [item.lower() for item in argv]
        joined = " ".join(normalized)
        if head in {"mv", "chmod", "chown"}:
            return True, "destructive_command"
        if head in {"curl", "wget"}:
            return True, "network_command"
        if head in {"pip", "pip3", "npm", "pnpm", "yarn"} and "install" in normalized:
            return True, "dependency_install"
        if len(normalized) >= 3 and head in {"python", "python3", "python.exe"}:
            if normalized[1:3] == ["-m", "pip"] and "install" in normalized:
                return True, "dependency_install"
        if "git clone" in joined:
            return True, "network_command"
        return False, "none"

    @staticmethod
    def _command_head(argv: list[str]) -> str:
        return Path(argv[0]).name.lower()

    def _require_approval_if_needed(
        self,
        *,
        scope: str,
        argv: list[str],
        cwd: str,
        approval_type: str | None = None,
        request_json: dict[str, Any] | None = None,
    ) -> str | None:
        task = self.context.current_task
        if task is None:
            return None
        risky, inferred_type = self._is_risky_command(argv)
        needs_approval = scope == "linked_workspace" or risky
        if not needs_approval and approval_type is None:
            return None
        final_type = approval_type or (
            "linked_workspace_command" if scope == "linked_workspace" else inferred_type
        )
        payload = request_json or {"scope": scope, "argv": argv, "cwd": cwd}
        existing = find_matching_approval(
            self.context.session,
            task_id=task.id,
            approval_type=final_type,
            request_json=payload,
        )
        if existing is not None and existing.status == "approved":
            return None
        approval = existing or create_task_approval(
            self.context.session,
            task_id=task.id,
            agent_run_id=self.context.run.id,
            tool_execution_id=self.context.current_tool_execution_id,
            approval_type=final_type,
            request_json=payload,
        )
        return json.dumps(
            {
                "ok": False,
                "tool_name": "execute_command"
                if approval_type is None
                else "linked_workspace_access",
                "error_type": "approval_required",
                "message": "This action requires user approval before Socrates may proceed.",
                "retryable": True,
                "suggestion": f"Wait for approval id {approval.id} to be approved, then retry the exact same tool call.",
                "approval_id": approval.id,
            },
            ensure_ascii=True,
            separators=(",", ":"),
        )

    def _require_task(self) -> Task:
        task = self.context.current_task or self.context.refresh_task()
        if task is None:
            raise PermissionError("Create a task before using task-scoped tools.")
        return task

    def _task_required_error(self, tool_name: str, message: str) -> str:
        return build_tool_error_result(
            tool_name=tool_name,
            error_type="task_required",
            message=message,
            retryable=True,
            suggestion="Call create_task first, then retry the task-scoped action.",
        )

    @staticmethod
    def _now():
        from datetime import datetime, timezone

        return datetime.now(timezone.utc)
