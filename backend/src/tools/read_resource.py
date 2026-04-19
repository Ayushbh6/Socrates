import PyPDF2
from pathlib import Path
from sqlalchemy.orm import Session
from .utils import resolve_asset_by_id_or_name, resolve_asset_path
from ..agent.tools import build_tool_error_result

def make_read_resource(db: Session, project_id: str, uploads_dir: Path):
    def read_resource(filename: str | None = None, asset_id: str | None = None, offset: int = 0, limit: int = 10000):
        """
        Reads the content of a project resource (text or PDF).
        
        Args:
            filename: The name of the file to read.
            offset: Where to start reading in characters (Default: 0).
            limit: Maximum characters to read (Default: 10000).
        """
        asset = resolve_asset_by_id_or_name(db, project_id, asset_id=asset_id, filename=filename)
        path = resolve_asset_path(db, project_id, asset.original_name, uploads_dir) if asset else None
        if not path:
            return build_tool_error_result(
                tool_name="read_resource",
                error_type="file_not_found",
                message=f"Resource '{asset_id or filename}' not found in project resources.",
                suggestion="Use 'list_resources' to see available files."
            )

        content = ""
        try:
            if path.suffix.lower() == ".pdf":
                with open(path, "rb") as f:
                    reader = PyPDF2.PdfReader(f)
                    full_text = ""
                    for page in reader.pages:
                        full_text += page.extract_text() + "\n"
                    content = full_text[offset : offset + limit]
            else:
                # Assume text-readable for other suffixes for now
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    f.seek(offset)
                    content = f.read(limit)
            
            return {
                "filename": filename or (asset.original_name if asset else None),
                "asset_id": asset.id if asset else None,
                "content": content,
                "length": len(content),
                "total_file_size": path.stat().st_size,
                "more_available": (offset + limit) < path.stat().st_size if path.suffix.lower() != ".pdf" else len(content) == limit
            }
        except Exception as e:
            return build_tool_error_result(
                tool_name="read_resource",
                error_type="read_error",
                message=str(e),
                suggestion="Check if the file is corrupted or use a different tool."
            )

    return read_resource
