from sqlalchemy.orm import Session
from ..db.models import Asset

def make_list_resources(db: Session, project_id: str):
    def list_resources():
        """Lists all files (PDFs, images, resources) currently anchored to the project."""
        assets = (
            db.query(Asset)
            .filter(Asset.project_id == project_id, Asset.deleted_at == None)
            .all()
        )
        return [
            {
                "asset_id": a.id,
                "filename": a.original_name,
                "kind": a.kind,
                "mime_type": a.mime_type,
                "size_bytes": a.size_bytes,
                "created_at": a.created_at.isoformat() if a.created_at else None
            }
            for a in assets
        ]
    return list_resources
