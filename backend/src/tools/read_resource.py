import base64
import mimetypes
from pathlib import Path

import pandas as pd
import docx
import PyPDF2
from sqlalchemy.orm import Session

from .utils import resolve_asset_by_id_or_name, resolve_asset_path
from ..agent.tools import build_tool_error_result

def make_read_resource(db: Session, project_id: str, uploads_dir: Path):
    def read_resource(filename: str | None = None, asset_id: str | None = None, offset: int = 0, limit: int = 10000):
        """
        Reads the content of a project resource (text, document, or image).
        
        Args:
            filename: The name of the file to read.
            asset_id: The id of the asset to read.
            offset: Where to start reading in characters (Default: 0).
            limit: Maximum characters to read (or rows for CSV/Excel) (Default: 10000).
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
            suffix = path.suffix.lower()
            
            # Images
            if suffix in (".png", ".jpg", ".jpeg"):
                mime_type = mimetypes.guess_type(path.name)[0] or "image/jpeg"
                with open(path, "rb") as f:
                    encoded = base64.b64encode(f.read()).decode("utf-8")
                return {
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime_type};base64,{encoded}"}
                }
            
            # Documents & Data
            if suffix == ".pdf":
                with open(path, "rb") as f:
                    reader = PyPDF2.PdfReader(f)
                    extracted = []
                    current_char_count = 0
                    
                    for page in reader.pages:
                        page_text = page.extract_text() + "\n"
                        page_len = len(page_text)
                        
                        start_of_page = current_char_count
                        end_of_page = current_char_count + page_len
                        current_char_count += page_len
                        
                        if start_of_page >= offset + limit:
                            break  # We've read past the requested limit
                            
                        if end_of_page <= offset:
                            continue # We haven't reached the requested offset yet
                            
                        # The page overlaps the requested window.
                        # Calculate the relative start and end indices within this specific page string.
                        slice_start = max(0, offset - start_of_page)
                        slice_end = min(page_len, (offset + limit) - start_of_page)
                        
                        extracted.append(page_text[slice_start:slice_end])
                        
                    content = "".join(extracted)
            
            elif suffix == ".docx":
                doc = docx.Document(path)
                extracted = []
                current_char_count = 0
                
                for para in doc.paragraphs:
                    para_text = para.text + "\n"
                    para_len = len(para_text)
                    
                    start_of_para = current_char_count
                    end_of_para = current_char_count + para_len
                    current_char_count += para_len
                    
                    if start_of_para >= offset + limit:
                        break
                        
                    if end_of_para <= offset:
                        continue
                        
                    slice_start = max(0, offset - start_of_para)
                    slice_end = min(para_len, (offset + limit) - start_of_para)
                    
                    extracted.append(para_text[slice_start:slice_end])
                    
                content = "".join(extracted)
            
            elif suffix in (".csv", ".xlsx"):
                # Treat limit as row count, default to 50 for quick inspection
                row_limit = 50 if limit == 10000 else limit
                if suffix == ".csv":
                    df = pd.read_csv(path, nrows=row_limit)
                else:
                    df = pd.read_excel(path, nrows=row_limit)
                content = df.to_markdown()
            
            else:
                # Fallback to plain text read
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    f.seek(offset)
                    content = f.read(limit)
            
            return {
                "filename": filename or (asset.original_name if asset else None),
                "asset_id": asset.id if asset else None,
                "content": content,
                "length": len(content),
                "total_file_size": path.stat().st_size,
                "more_available": (offset + limit) < path.stat().st_size if suffix not in (".pdf", ".docx", ".csv", ".xlsx") else False
            }
        except Exception as e:
            return build_tool_error_result(
                tool_name="read_resource",
                error_type="read_error",
                message=str(e),
                suggestion="Check if the file is corrupted or use a different tool."
            )

    return read_resource
