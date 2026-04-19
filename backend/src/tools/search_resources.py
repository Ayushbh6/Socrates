import re
import PyPDF2
from pathlib import Path
from sqlalchemy.orm import Session
from ..db.models import Asset
from ..agent.tools import build_tool_error_result
from .utils import _path_within

def make_search_resources(db: Session, project_id: str, uploads_dir: Path):
    def search_resources(query: str, file_pattern: str = "*", max_matches: int = 50, context_lines: int = 2):
        """
        Searches for a regex or text pattern across all project resources.
        
        Args:
            query: The regex or text to search for.
            file_pattern: Glob pattern to filter files (e.g., "*.txt").
            max_matches: Maximum number of matches to return (Default: 50).
            context_lines: Number of lines of context to show around each match.
        """
        assets = (
            db.query(Asset)
            .filter(Asset.project_id == project_id, Asset.deleted_at == None)
            .all()
        )
        
        # Filter assets by glob pattern
        import fnmatch
        filtered_assets = [a for a in assets if fnmatch.fnmatch(a.original_name, file_pattern)]
        
        matches = []
        try:
            pattern = re.compile(query, re.IGNORECASE)
            
            for asset in filtered_assets:
                if len(matches) >= max_matches:
                    break
                    
                path = uploads_dir / asset.storage_path
                if not path.exists() or not _path_within(uploads_dir, path):
                    continue
                
                text = ""
                if path.suffix.lower() == ".pdf":
                    with open(path, "rb") as f:
                        reader = PyPDF2.PdfReader(f)
                        for page in reader.pages:
                            text += page.extract_text() + "\n"
                else:
                    with open(path, "r", encoding="utf-8", errors="replace") as f:
                        text = f.read()
                
                lines = text.splitlines()
                for i, line in enumerate(lines):
                    if pattern.search(line):
                        start = max(0, i - context_lines)
                        end = min(len(lines), i + context_lines + 1)
                        context = lines[start:end]
                        matches.append({
                            "asset_id": asset.id,
                            "filename": asset.original_name,
                            "line_no": i + 1,
                            "match": line.strip(),
                            "context": context
                        })
                        if len(matches) >= max_matches:
                            break
            
            return {
                "query": query,
                "match_count": len(matches),
                "matches": matches,
                "truncated": len(matches) == max_matches
            }
        except Exception as e:
            return build_tool_error_result(
                tool_name="search_resources",
                error_type="search_error",
                message=str(e),
                suggestion="Verify your regex syntax or try a simpler search string."
            )

    return search_resources
