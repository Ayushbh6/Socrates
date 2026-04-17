from enum import Enum
from typing import List, Optional, Dict, Any, Union, Type
from pydantic import BaseModel, Field

class InputMode(str, Enum):
    TEXT = "text"
    VOICE = "voice"

class MessageRole(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"

class Attachment(BaseModel):
    """Represents an attached image or file."""
    mime_type: str
    content: Union[str, bytes]  # Base64 string or raw bytes
    name: Optional[str] = None

class ToolCall(BaseModel):
    """Structured tool/function call from the model."""
    id: str
    name: str
    arguments: Dict[str, Any]

class Message(BaseModel):
    """A single message in the conversation history."""
    role: MessageRole
    content: Optional[str] = None
    attachments: Optional[List[Attachment]] = None
    tool_calls: Optional[List[ToolCall]] = None
    tool_call_id: Optional[str] = None

class ToolDefinition(BaseModel):
    """The definition of a tool/function that the model can call."""
    name: str
    description: str
    parameters: Dict[str, Any]  # JSON Schema

class ThinkingLevel(str, Enum):
    OFF = "off"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"

class GenConfig(BaseModel):
    """Model generation parameters."""
    temperature: float = 0.7
    max_tokens: Optional[int] = None
    top_p: float = 1.0
    stop_sequences: Optional[List[str]] = None
    thinking: ThinkingLevel = ThinkingLevel.OFF

class LLMRequest(BaseModel):
    """The unified request object for all providers."""
    system_prompt: str
    query: str
    history: List[Message] = Field(default_factory=list)
    attachments: Optional[List[Attachment]] = None
    tools: Optional[List[ToolDefinition]] = None
    response_model: Optional[Type[BaseModel]] = None # For Structured Outputs
    input_mode: InputMode = InputMode.TEXT
    config: GenConfig = Field(default_factory=GenConfig)

class UsageStats(BaseModel):
    """Normalized token usage statistics."""
    input_tokens: int = 0
    output_tokens: int = 0
    completion_tokens: int = 0  # Specifically for the final output
    total_tokens: int = 0

class LLMResponse(BaseModel):
    """The unified response object returned to the agent."""
    content: str
    thinking: Optional[str] = None  # Intermediate reasoning/chain-of-thought
    tool_calls: List[ToolCall] = Field(default_factory=list)
    usage: UsageStats
    raw_dump: Dict[str, Any]  # Full provider response for debugging
    metadata: Dict[str, Any] = Field(default_factory=dict) # Model name, latency, etc.
    parsed: Optional[BaseModel] = None # The instantiated response_model
