from datetime import datetime
from uuid import UUID

from app.schemas.base import APIModel


class UserResponse(APIModel):
    id: UUID
    email: str | None
    display_name: str | None
    status: str
    metadata: dict
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


class UserEnvelope(APIModel):
    user: UserResponse
