import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def clear_cached_settings():
    from backend.src.core.settings import get_settings
    from backend.src.db.session import reset_database_state

    get_settings.cache_clear()
    reset_database_state()
    yield
    get_settings.cache_clear()
    reset_database_state()
