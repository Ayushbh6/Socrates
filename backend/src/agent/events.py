from enum import Enum
from typing import Optional

from pydantic import BaseModel

from ..core.schema import LLMResponse, Message, ToolCall


class AgentEventType(str, Enum):
    THINKING = "thinking"
    CONTENT = "content"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    ASSISTANT_MESSAGE = "assistant_message"
    FINAL_RESPONSE = "final_response"
    ERROR = "error"


class AgentEvent(BaseModel):
    type: AgentEventType
    provider: str
    model: str
    round_index: int = 0
    response: Optional[LLMResponse] = None
    tool_call: Optional[ToolCall] = None
    tool_result: Optional[str] = None
    message: Optional[Message] = None
    error: Optional[str] = None
