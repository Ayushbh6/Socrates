from fastapi import Depends, FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.router import api_router
from app.core.config import settings
from app.db.session import get_db_session


app = FastAPI(title=settings.app_name)
app.include_router(api_router, prefix=settings.api_v1_prefix)


@app.get("/healthz")
async def healthz(session: AsyncSession = Depends(get_db_session)):
    await session.execute(text("SELECT 1"))
    result = await session.execute(
        text("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')")
    )
    return {
        "status": "ok",
        "database": "ok",
        "pgvectorEnabled": bool(result.scalar()),
    }
