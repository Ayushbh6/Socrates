from fastapi import APIRouter

from .bootstrap import router as bootstrap_router
from .chat import router as chat_router
from .health import router as health_router
from .projects import router as projects_router
from .trace import router as trace_router


def build_api_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1")
    router.include_router(health_router)
    router.include_router(bootstrap_router)
    router.include_router(projects_router)
    router.include_router(chat_router)
    router.include_router(trace_router)
    return router
