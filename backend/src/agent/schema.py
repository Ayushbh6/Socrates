from typing import Any, Dict, List, Optional, Type

from pydantic import BaseModel, Field

from ..core.schema import (
    Attachment,
    GenConfig,
    InputMode,
    LLMResponse,
    Message,
    ToolCall,
    ToolDefinition,
    UsageStats,
)


class AgentConfig(BaseModel):
    stream: bool = True
    emit_thinking: bool = True
    emit_tool_results: bool = True
    stop_on_first_parsed_output: bool = True
    max_tool_rounds: int = 100
    max_consecutive_failures: int = 5
    max_parallel_tool_calls: int = 6
    force_structured_output_final_pass: bool = True


class AgentRequest(BaseModel):
    model: str
    system_prompt: str
    query: str
    history: List[Message] = Field(default_factory=list)
    attachments: Optional[List[Attachment]] = None
    tools: Optional[List[ToolDefinition]] = None
    response_model: Optional[Type[BaseModel]] = None
    input_mode: InputMode = InputMode.TEXT
    config: GenConfig = Field(default_factory=GenConfig)
    agent: AgentConfig = Field(default_factory=AgentConfig)
    provider_kwargs: Dict[str, Any] = Field(default_factory=dict)


class AgentTurnTelemetry(BaseModel):
    round_index: int
    phase: str
    elapsed_ms: float
    usage: UsageStats = Field(default_factory=UsageStats)
    tool_call_count: int = 0
    parsed_output: bool = False
    had_thinking: bool = False


class AgentResult(BaseModel):
    final_response: LLMResponse
    tool_rounds: int = 0
    tools_called: List[ToolCall] = Field(default_factory=list)
    final_history: List[Message] = Field(default_factory=list)
    provider: str
    model: str
    usage: UsageStats = Field(default_factory=UsageStats)
    elapsed_ms: float = 0.0
    turns: List[AgentTurnTelemetry] = Field(default_factory=list)
