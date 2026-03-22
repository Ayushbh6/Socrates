from fastapi import APIRouter

from app.api.v1.conversations import router as conversations_router
from app.api.v1.models import router as models_router
from app.api.v1.users import router as users_router


api_router = APIRouter()
api_router.include_router(users_router, prefix="/users", tags=["users"])
api_router.include_router(models_router, prefix="/models", tags=["models"])
api_router.include_router(
    conversations_router,
    prefix="/conversations",
    tags=["conversations"],
)
