from __future__ import annotations

import hashlib
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..core.settings import get_settings
from ..db.models import Asset
from .bootstrap import get_current_user
from .projects import get_project


def _safe_filename(name: str) -> str:
    return Path(name).name.replace("/", "_").replace("\\", "_")


def list_project_assets(session: Session, project_id: str) -> list[Asset]:
    get_project(session, project_id)
    return list(
        session.execute(
            select(Asset)
            .where(Asset.project_id == project_id, Asset.deleted_at.is_(None))
            .order_by(Asset.created_at.desc())
        ).scalars()
    )


def get_project_assets_by_ids(session: Session, project_id: str, asset_ids: list[str]) -> list[Asset]:
    if not asset_ids:
        return []

    assets = list(
        session.execute(
            select(Asset).where(
                Asset.project_id == project_id,
                Asset.id.in_(asset_ids),
                Asset.deleted_at.is_(None),
            )
        ).scalars()
    )
    if len(assets) != len(set(asset_ids)):
        raise LookupError("One or more assets were not found in this project.")
    return assets


def create_image_asset(
    session: Session,
    *,
    project_id: str,
    original_name: str,
    mime_type: str,
    content: bytes,
) -> Asset:
    if not mime_type.startswith("image/"):
        raise ValueError("Only image uploads are supported in this slice.")

    get_project(session, project_id)
    user = get_current_user(session)
    if user is None:
        raise LookupError("Bootstrap is required before uploading assets.")

    settings = get_settings()
    digest = hashlib.sha256(content).hexdigest()
    asset = Asset(
        project_id=project_id,
        uploaded_by_user_id=user.id,
        kind="image",
        source_type="upload",
        original_name=_safe_filename(original_name or "image"),
        mime_type=mime_type,
        storage_path="",
        size_bytes=len(content),
        sha256=digest,
        metadata_json={},
    )
    session.add(asset)
    session.flush()

    relative_path = Path(project_id) / f"{asset.id}_{asset.original_name}"
    absolute_path = settings.uploads_dir / relative_path
    absolute_path.parent.mkdir(parents=True, exist_ok=True)
    absolute_path.write_bytes(content)

    asset.storage_path = str(relative_path)
    session.commit()
    session.refresh(asset)
    return asset


def resolve_asset_bytes(asset: Asset) -> bytes:
    settings = get_settings()
    path = settings.uploads_dir / asset.storage_path
    return path.read_bytes()
