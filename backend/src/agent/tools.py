import inspect
import json
from typing import Any, Callable, Dict, Optional

from ..core.schema import ToolCall

ToolExecutor = Callable[[ToolCall], Any]
ToolHandler = Callable[..., Any]


def _json_safe(value: Any) -> Any:
    """Lazy import of `to_json_compatible` to avoid a circular import.

    `services.utils` lives under `backend.src.services`, whose `__init__`
    eagerly imports `chat`, which in turn imports from `agent`. Importing it
    at module load time here would therefore create a cycle. We only need the
    coercion while serializing tool payloads, so pulling it in on demand is
    both cheap (import is cached) and structurally safe.
    """

    from ..services.utils import to_json_compatible

    return to_json_compatible(value)


def _envelope_shape(payload: Any) -> bool:
    """Strict check: a canonical tool result envelope is a dict whose `ok` is a
    real bool and whose `tool_name` is a non-empty string. Anything else must
    be normalized before being handed to the agent loop."""

    if not isinstance(payload, dict):
        return False
    if not isinstance(payload.get("ok"), bool):
        return False
    tool_name = payload.get("tool_name")
    return isinstance(tool_name, str) and bool(tool_name)


def _is_serialized_tool_envelope(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return False
    return _envelope_shape(payload)


def _serialize_payload(payload: Dict[str, Any]) -> str:
    return json.dumps(_json_safe(payload), ensure_ascii=True, separators=(",", ":"), allow_nan=False)


def build_tool_success_result(*, tool_name: str, data: Any) -> str:
    return _serialize_payload(
        {
            "ok": True,
            "tool_name": tool_name,
            "data": data,
        }
    )


def build_tool_error_result(
    *,
    tool_name: str,
    error_type: str,
    message: str,
    retryable: bool = False,
    suggestion: Optional[str] = None,
) -> str:
    payload: Dict[str, Any] = {
        "ok": False,
        "tool_name": tool_name,
        "error_type": error_type,
        "message": message,
        "retryable": retryable,
    }
    if suggestion:
        payload["suggestion"] = suggestion
    return _serialize_payload(payload)


def _normalize_tool_result(*, tool_name: str, result: Any) -> str:
    """Coerce any handler return value into a serialized canonical envelope.

    This is the single choke point that guarantees the agent loop only ever
    sees `{"ok": bool, "tool_name": str, ...}` JSON strings. It prevents a
    misbehaving tool (returning `None`, a bare dict, a non-serializable
    object, or a JSON string with a broken shape) from being counted as an
    error and burning through `max_consecutive_failures`.
    """

    if _is_serialized_tool_envelope(result):
        return result
    if isinstance(result, dict) and _envelope_shape(result):
        normalized = dict(result)
        if normalized.get("tool_name") != tool_name:
            normalized["tool_name"] = tool_name
        return _serialize_payload(normalized)
    return build_tool_success_result(tool_name=tool_name, data=result)


async def execute_tool_call(
    tool_call: ToolCall,
    *,
    tool_executor: Optional[ToolExecutor] = None,
    tool_handlers: Optional[Dict[str, ToolHandler]] = None,
) -> str:
    if tool_executor is None and not tool_handlers:
        return build_tool_error_result(
            tool_name=tool_call.name,
            error_type="missing_tool",
            message=f"No tool executor configured for tool '{tool_call.name}'.",
            retryable=False,
            suggestion="Use a different tool or answer without this tool if possible.",
        )

    try:
        if tool_executor is not None:
            result = tool_executor(tool_call)
        else:
            handler = (tool_handlers or {}).get(tool_call.name)
            if handler is None:
                return build_tool_error_result(
                    tool_name=tool_call.name,
                    error_type="missing_tool",
                    message=f"No handler registered for tool '{tool_call.name}'.",
                    retryable=False,
                    suggestion="Call one of the available tools instead.",
                )
            result = handler(**tool_call.arguments)

        if inspect.isawaitable(result):
            result = await result
        return _normalize_tool_result(tool_name=tool_call.name, result=result)
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
