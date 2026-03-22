from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import DEV_USER_ID
from app.repositories.users import get_user_by_id


async def get_dev_user(session: AsyncSession):
    user = await get_user_by_id(session, DEV_USER_ID)
    if user is None:
        raise HTTPException(status_code=500, detail="Seeded dev user is missing.")
    return user
