"""CLI entry point for Nextcloud backup – intended to be called via cron.

Usage:
    docker compose exec -T backend python -m app.backup_cli
"""
from __future__ import annotations

import asyncio
import logging
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("backup_cli")


async def main() -> None:
    from .app_settings import get_setting
    from .backup import run_daily_backup
    from .db import SessionLocal

    async with SessionLocal() as s:
        enabled = await get_setting(s, "backup_enabled", False)
        if not enabled:
            log.info("backup disabled – skipping")
            return
        nc_url = await get_setting(s, "nextcloud_url", "")
        nc_user = await get_setting(s, "nextcloud_user", "")
        nc_password = await get_setting(s, "nextcloud_password", "")
        nc_path = await get_setting(s, "nextcloud_backup_path", "/mynotes-backups")
        retention = int(await get_setting(s, "backup_retention_days", 7))

    if not nc_url or not nc_user or not nc_password:
        log.error("Nextcloud credentials incomplete – aborting")
        sys.exit(1)

    await run_daily_backup(nc_url, nc_user, nc_password, nc_path, retention)
    log.info("backup complete")


if __name__ == "__main__":
    asyncio.run(main())
