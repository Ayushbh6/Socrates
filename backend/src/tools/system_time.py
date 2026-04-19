from datetime import datetime, timezone

def get_system_time():
    """Returns the current ISO-8601 timestamp and day of the week."""
    now = datetime.now(timezone.utc)
    return {
        "timestamp": now.isoformat(),
        "weekday": now.strftime("%A"),
        "timezone": "UTC"
    }
