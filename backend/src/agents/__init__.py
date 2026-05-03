from .socrates import SOCRATES_BASE_PROMPT, build_socrates_system_prompt
from .worker import WORKER_SYSTEM_PROMPT, build_worker_system_prompt

__all__ = [
    "SOCRATES_BASE_PROMPT",
    "WORKER_SYSTEM_PROMPT",
    "build_socrates_system_prompt",
    "build_worker_system_prompt",
]
