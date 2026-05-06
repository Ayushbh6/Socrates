from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Callable, Any

from sqlalchemy.orm import Session

from ..agent.tools import build_tool_error_result, normalize_tool_result
from ..core.schema import ToolCall
from ..db.models import AgentRun, ToolExecution
from .locks import GLOBAL_TOOL_LOCKS, KeyedLockRegistry
from .read_state import RunReadState, sha256_file
from .resources import ToolResourcePlan, ToolResourcePlanner

TASK_PACKAGE_FILE_NAMES = {"task.md", "plan.md", "todo.md"}


class ProjectToolBatchExecutor:
    def __init__(
        self,
        *,
        session_factory: Callable[[], Session],
        project_id: str,
        conversation_id: str,
        run_id: str,
        uploads_dir: Path,
        lock_registry: KeyedLockRegistry = GLOBAL_TOOL_LOCKS,
        registry_factory: Callable[..., Any] | None = None,
        parent_event_sink: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self.session_factory = session_factory
        self.project_id = project_id
        self.conversation_id = conversation_id
        self.run_id = run_id
        self.uploads_dir = uploads_dir
        self.lock_registry = lock_registry
        self.read_state = RunReadState()
        self.registry_factory = registry_factory
        self.parent_event_sink = parent_event_sink

    async def __call__(self, tool_calls: list[ToolCall]) -> list[str]:
        plans = self._plan_tool_calls(tool_calls)
        rejected = self._batch_policy_rejections(plans)
        lifecycle_batch = any(self._touches_task_package(plan) for plan in plans)
        results: list[str | None] = [None] * len(tool_calls)
        grouped: dict[tuple[str, ...], list[tuple[int, ToolResourcePlan]]] = {}
        tasks = []
        for index, (tool_call, plan) in enumerate(zip(tool_calls, plans)):
            rejected_result = rejected.get(tool_call.id)
            if rejected_result is not None:
                tasks.append(
                    asyncio.to_thread(
                        self._record_rejected_indexed,
                        index,
                        tool_call,
                        rejected_result,
                    )
                )
                continue
            group_key = self._group_key(plan, lifecycle_batch=lifecycle_batch)
            grouped.setdefault(group_key, []).append((index, plan))

        for group in grouped.values():
            tasks.append(asyncio.to_thread(self._execute_planned_group, group))

        for completed in await asyncio.gather(*tasks):
            for index, result in completed:
                results[index] = result
        return [result or self._missing_result(tool_call) for tool_call, result in zip(tool_calls, results)]

    def _record_rejected_indexed(
        self, index: int, tool_call: ToolCall, result: str
    ) -> list[tuple[int, str]]:
        return [(index, self._record_rejected_tool_call(tool_call, result))]

    def _execute_planned_group(
        self, group: list[tuple[int, ToolResourcePlan]]
    ) -> list[tuple[int, str]]:
        return [
            (index, self._execute_planned_call(plan))
            for index, plan in group
        ]

    @staticmethod
    def _missing_result(tool_call: ToolCall) -> str:
        return build_tool_error_result(
            tool_name=tool_call.name,
            error_type="missing_tool_result",
            message="The tool batch completed without returning a result for this call.",
            retryable=True,
        )

    def _group_key(
        self, plan: ToolResourcePlan, *, lifecycle_batch: bool
    ) -> tuple[str, ...]:
        if (
            lifecycle_batch
            and (
                plan.tool_call.arguments.get("scope") in {"task", "linked_workspace"}
                or plan.tool_call.name
                in {
                    "start_worker",
                    "update_current_todo_item",
                    "skip_todo_item",
                }
            )
        ):
            return (f"state:conversation:{self.conversation_id}:task_lifecycle_batch",)
        return tuple(sorted(plan.write_keys)) or (f"call:{plan.tool_call.id}",)

    @staticmethod
    def _touches_task_package(plan: ToolResourcePlan) -> bool:
        if plan.tool_call.arguments.get("scope") != "task":
            return False
        return any(
            resource.argument_path in TASK_PACKAGE_FILE_NAMES
            for resource in plan.write_files
        )

    def _plan_tool_calls(self, tool_calls: list[ToolCall]) -> list[ToolResourcePlan]:
        session = self.session_factory()
        try:
            run = session.get(AgentRun, self.run_id)
            if run is None:
                return [
                    ToolResourcePlan(tool_call=tool_call)
                    for tool_call in tool_calls
                ]
            if self.registry_factory is None:
                from .registry import get_tools_registry

                registry_factory = get_tools_registry
            else:
                registry_factory = self.registry_factory

            runtime = registry_factory(
                session,
                project_id=self.project_id,
                conversation_id=self.conversation_id,
                run=run,
                uploads_dir=self.uploads_dir,
                parent_event_sink=self.parent_event_sink,
            )
            planner = ToolResourcePlanner(runtime)
            return [planner.plan(tool_call) for tool_call in tool_calls]
        finally:
            session.close()

    def _batch_policy_rejections(self, plans: list[ToolResourcePlan]) -> dict[str, str]:
        rejected = self._same_batch_task_lifecycle_rejections(plans)
        rejected.update(self._same_batch_read_write_rejections(plans))
        return rejected

    def _same_batch_task_lifecycle_rejections(
        self, plans: list[ToolResourcePlan]
    ) -> dict[str, str]:
        if not any(plan.tool_call.name == "create_task" for plan in plans):
            return {}
        rejected: dict[str, str] = {}
        task_dependent_tools = {
            "edit_file",
            "write_file",
            "apply_patch",
            "execute_command",
            "update_task_status",
            "start_worker",
            "update_current_todo_item",
            "skip_todo_item",
        }
        for plan in plans:
            tool_call = plan.tool_call
            scope = tool_call.arguments.get("scope")
            depends_on_task_scope = scope in {"task", "linked_workspace"}
            if tool_call.name not in task_dependent_tools and not depends_on_task_scope:
                continue
            if tool_call.name == "create_task":
                continue
            rejected[tool_call.id] = build_tool_error_result(
                tool_name=tool_call.name,
                error_type="same_batch_task_lifecycle_conflict",
                message=(
                    "This tool call depends on task state that is being created in "
                    "the same parallel batch. The dependent call was not run."
                ),
                retryable=True,
                suggestion=(
                    "Inspect the create_task result first, then call task-scoped "
                    "tools in the next model turn."
                ),
            )
        return rejected

    def _same_batch_read_write_rejections(
        self, plans: list[ToolResourcePlan]
    ) -> dict[str, str]:
        read_keys = set()
        for plan in plans:
            if plan.tool_call.name == "read_file":
                read_keys.update(plan.read_keys)
        rejected: dict[str, str] = {}
        for plan in plans:
            overlap = read_keys & plan.write_keys
            if not overlap:
                continue
            rejected[plan.tool_call.id] = build_tool_error_result(
                tool_name=plan.tool_call.name,
                error_type="same_batch_read_write_conflict",
                message=(
                    "This tool call tried to mutate a file that is also being read "
                    "in the same parallel batch. The mutation was not run."
                ),
                retryable=True,
                suggestion=(
                    "Inspect the read_file result first, then call the mutation tool "
                    "in the next model turn with exact current text."
                ),
            )
        return rejected

    def _execute_planned_call(self, plan: ToolResourcePlan) -> str:
        with self.lock_registry.acquire(plan.lock_keys):
            prepared_call_or_error = self._prepare_call_after_lock(plan)
            if isinstance(prepared_call_or_error, str):
                return self._record_rejected_tool_call(
                    plan.tool_call, prepared_call_or_error
                )
            result = self._execute_with_fresh_runtime(prepared_call_or_error)
            self._update_read_state_after_result(plan, result)
            return result

    def _prepare_call_after_lock(self, plan: ToolResourcePlan) -> ToolCall | str:
        if not plan.prior_read_requirements:
            return plan.tool_call
        args = dict(plan.tool_call.arguments)
        expected_map = args.get("expected_sha256_map")
        expected_map = dict(expected_map) if isinstance(expected_map, dict) else {}
        for requirement in plan.prior_read_requirements:
            if requirement.expected_argument and args.get(requirement.expected_argument):
                continue
            if requirement.expected_map_key and expected_map.get(requirement.expected_map_key):
                continue
            sha256 = self.read_state.get_sha256(requirement.resource.key)
            if sha256 is None:
                return build_tool_error_result(
                    tool_name=plan.tool_call.name,
                    error_type="read_before_write_required",
                    message=(
                        f"'{requirement.resource.argument_path}' must be read before "
                        "it can be modified. The mutation was not run."
                    ),
                    retryable=True,
                    suggestion=(
                        "Call read_file for the target path first, then retry the "
                        "mutation with exact current text."
                    ),
                )
            if requirement.expected_argument:
                args[requirement.expected_argument] = sha256
            if requirement.expected_map_key:
                expected_map[requirement.expected_map_key] = sha256
                args["expected_sha256_map"] = expected_map
        return ToolCall(
            id=plan.tool_call.id,
            name=plan.tool_call.name,
            arguments=args,
        )

    def _execute_with_fresh_runtime(self, tool_call: ToolCall) -> str:
        session = self.session_factory()
        try:
            run = session.get(AgentRun, self.run_id)
            if run is None:
                return build_tool_error_result(
                    tool_name=tool_call.name,
                    error_type="missing_run",
                    message="The agent run no longer exists.",
                    retryable=False,
                )
            if self.registry_factory is None:
                from .registry import get_tools_registry

                registry_factory = get_tools_registry
            else:
                registry_factory = self.registry_factory

            runtime = registry_factory(
                session,
                project_id=self.project_id,
                conversation_id=self.conversation_id,
                run=run,
                uploads_dir=self.uploads_dir,
                parent_event_sink=self.parent_event_sink,
            )
            return normalize_tool_result(
                tool_name=tool_call.name,
                result=runtime.execute(tool_call),
            )
        except TypeError as exc:
            return build_tool_error_result(
                tool_name=tool_call.name,
                error_type="validation_error",
                message=str(exc),
                retryable=True,
                suggestion="Call the tool again with valid arguments that match the schema.",
            )
        except Exception as exc:
            return build_tool_error_result(
                tool_name=tool_call.name,
                error_type=exc.__class__.__name__,
                message=str(exc),
                retryable=False,
                suggestion="Adjust the plan or inputs before retrying this tool.",
            )
        finally:
            session.close()

    def _record_rejected_tool_call(self, tool_call: ToolCall, result: str) -> str:
        session = self.session_factory()
        try:
            run = session.get(AgentRun, self.run_id)
            if run is None:
                return result
            now = datetime.now(timezone.utc)
            try:
                payload = json.loads(result)
            except json.JSONDecodeError:
                payload = {"ok": False, "tool_name": tool_call.name, "message": result}
            execution = ToolExecution(
                agent_run_id=run.id,
                task_id=run.task_id,
                tool_call_id=tool_call.id,
                tool_name=tool_call.name,
                arguments_json=tool_call.arguments,
                status="failed",
                result_text=result,
                result_json=payload,
                error_text=payload.get("message"),
                started_at=now,
                completed_at=now,
            )
            session.add(execution)
            session.commit()
            return result
        finally:
            session.close()

    def _update_read_state_after_result(
        self, plan: ToolResourcePlan, serialized_result: str
    ) -> None:
        try:
            payload = json.loads(serialized_result)
        except json.JSONDecodeError:
            return
        if payload.get("ok") is not True:
            return
        if plan.tool_call.name == "read_file":
            data = payload.get("data")
            if not isinstance(data, dict):
                return
            sha256 = data.get("sha256")
            if not isinstance(sha256, str):
                return
            for resource in plan.read_files:
                self.read_state.record(key=resource.key, sha256=sha256)
            return
        for resource in plan.write_files:
            sha256 = sha256_file(resource.path)
            if sha256 is None:
                self.read_state.forget(resource.key)
            else:
                self.read_state.record(key=resource.key, sha256=sha256)
