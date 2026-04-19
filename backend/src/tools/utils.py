from pathlib import Path
from typing import Optional
from sqlalchemy.orm import Session
from ..db.models import Asset


def _path_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def resolve_asset_path(
    db: Session, 
    project_id: str, 
    filename: str, 
    uploads_dir: Path
) -> Optional[Path]:
    """
    Securely resolves a filename to an absolute storage path.
    Only returns a path if the asset belongs to the specified project.
    """
    asset = (
        db.query(Asset)
        .filter(Asset.project_id == project_id, Asset.original_name == filename, Asset.deleted_at == None)
        .first()
    )
    if not asset:
        return None
    
    # storage_path is stored relative to uploads_dir in the DB
    full_path = uploads_dir / asset.storage_path
    
    # Safety check: ensure the resolved path is still within uploads_dir
    if not _path_within(uploads_dir, full_path):
        return None
        
    return full_path if full_path.exists() else None


def resolve_asset_by_id_or_name(
    db: Session,
    project_id: str,
    *,
    asset_id: str | None = None,
    filename: str | None = None,
) -> Optional[Asset]:
    query = db.query(Asset).filter(Asset.project_id == project_id, Asset.deleted_at == None)
    if asset_id:
        return query.filter(Asset.id == asset_id).first()
    if filename:
        return query.filter(Asset.original_name == filename).first()
    return None
