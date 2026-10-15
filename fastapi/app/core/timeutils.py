"""
Time helpers. All timestamps are stored as timezone-aware UTC; the business timezone (Asia/Manila by default) is only
used to decide what "today" means and to format times for people.
"""
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional, Tuple
from zoneinfo import ZoneInfo

from app.core.config import BUSINESS_TIMEZONE

BUSINESS_TZ = ZoneInfo(BUSINESS_TIMEZONE)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(value: Optional[datetime]) -> Optional[datetime]:
    """Treat naive datetimes as UTC (legacy rows) and return an aware UTC datetime."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def to_business(value: Optional[datetime]) -> Optional[datetime]:
    value = as_utc(value)
    return value.astimezone(BUSINESS_TZ) if value else None


def business_today(now: Optional[datetime] = None) -> date:
    return (as_utc(now) or utcnow()).astimezone(BUSINESS_TZ).date()


def business_day_bounds_utc(day: Optional[date] = None) -> Tuple[datetime, datetime]:
    """[start, end) of a business-timezone calendar day, expressed in UTC."""
    day = day or business_today()
    start_local = datetime.combine(day, time.min, tzinfo=BUSINESS_TZ)
    end_local = datetime.combine(day + timedelta(days=1), time.min, tzinfo=BUSINESS_TZ)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def isoformat_utc(value: Optional[datetime]) -> Optional[str]:
    value = as_utc(value)
    return value.isoformat() if value else None
