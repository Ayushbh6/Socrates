import inspect
import json
from typing import Any, Awaitable, Callable, Dict, Optional

from ..core.schema import ToolCall

ToolExecutor = Callable[[ToolCall], Any]
ToolHandler = Callable[..., Any]


def _is_serialized_tool_payload(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return False
    return isinstance(payload, dict) and "ok" in payload and "tool_name" in payload


def _serialize_payload(payload: Dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":"))


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
        if _is_serialized_tool_payload(result):
            return result
        return build_tool_success_result(tool_name=tool_call.name, data=result)
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
