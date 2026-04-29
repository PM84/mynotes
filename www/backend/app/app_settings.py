"""Helpers für persistente, zur Laufzeit veränderbare Einstellungen."""
from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from .models import AppSetting

# 4 Wochen ohne Refresh = 4 * 7 * 24 * 60 Minuten
DEFAULT_SESSION_LIFETIME_MINUTES = 4 * 7 * 24 * 60
MIN_SESSION_LIFETIME_MINUTES = 5
MAX_SESSION_LIFETIME_MINUTES = 525_600  # 1 Jahr


async def get_setting(session: AsyncSession, name: str, default: Any) -> Any:
    row = await session.get(AppSetting, name)
    return default if row is None else row.value


async def set_setting(session: AsyncSession, name: str, value: Any) -> None:
    row = await session.get(AppSetting, name)
    if row is None:
        session.add(AppSetting(name=name, value=value))
    else:
        row.value = value
    await session.commit()


async def get_session_lifetime_minutes(session: AsyncSession) -> int:
    val = await get_setting(
        session, "session_lifetime_minutes", DEFAULT_SESSION_LIFETIME_MINUTES
    )
    try:
        m = int(val)
    except (TypeError, ValueError):
        m = DEFAULT_SESSION_LIFETIME_MINUTES
    return max(MIN_SESSION_LIFETIME_MINUTES, min(m, MAX_SESSION_LIFETIME_MINUTES))
