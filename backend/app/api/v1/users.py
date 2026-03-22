from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.schemas.user import UserEnvelope
from app.schemas.serializers import serialize_user
from app.services.users import get_dev_user


router = APIRouter()


@router.get("/me", response_model=UserEnvelope)
async def get_me(session: AsyncSession = Depends(get_db_session)) -> UserEnvelope:
    user = await get_dev_user(session)
    return UserEnvelope(user=serialize_user(user))
