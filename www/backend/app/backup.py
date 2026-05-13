"""Automated daily backup to Nextcloud via WebDAV."""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from xml.etree import ElementTree

import httpx

from .api.admin import create_backup_zip

log = logging.getLogger("backup")


async def _webdav_url(base_url: str, path: str, filename: str = "") -> str:
    """Build full WebDAV URL from base, path and optional filename."""
    base = base_url.rstrip("/")
    path = path.strip("/")
    parts = [base, path]
    if filename:
        parts.append(filename)
    return "/".join(parts)


async def _ensure_folder(client: httpx.AsyncClient, url: str) -> None:
    """Create folder via MKCOL if it doesn't exist."""
    r = await client.request("MKCOL", url)
    # 201 = created, 405 = already exists
    if r.status_code not in (201, 405):
        r.raise_for_status()


async def _list_backups(client: httpx.AsyncClient, folder_url: str) -> list[str]:
    """List .zip files in the WebDAV folder via PROPFIND."""
    r = await client.request(
        "PROPFIND",
        folder_url,
        headers={"Depth": "1"},
        content=(
            '<?xml version="1.0" encoding="utf-8"?>'
            '<d:propfind xmlns:d="DAV:">'
            "<d:prop><d:displayname/></d:prop>"
            "</d:propfind>"
        ),
    )
    r.raise_for_status()
    ns = {"d": "DAV:"}
    tree = ElementTree.fromstring(r.text)
    names: list[str] = []
    for resp in tree.findall("d:response", ns):
        href = resp.findtext("d:href", default="", namespaces=ns)
        if href.endswith(".zip"):
            # Extract filename from href
            names.append(href.rsplit("/", 1)[-1])
    names.sort()
    return names


async def _delete_file(client: httpx.AsyncClient, url: str) -> None:
    r = await client.request("DELETE", url)
    r.raise_for_status()


async def run_daily_backup(
    nextcloud_url: str,
    nextcloud_user: str,
    nextcloud_password: str,
    nextcloud_backup_path: str,
    retention_days: int,
) -> None:
    """Create a backup ZIP and upload it to Nextcloud, removing old backups."""
    # 1) Create backup ZIP in memory
    buf = await create_backup_zip()

    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"mynotes-backup-{ts}.zip"

    folder_url = await _webdav_url(nextcloud_url, nextcloud_backup_path)
    file_url = await _webdav_url(nextcloud_url, nextcloud_backup_path, filename)

    auth = httpx.BasicAuth(nextcloud_user, nextcloud_password)
    async with httpx.AsyncClient(auth=auth, timeout=300) as client:
        # 2) Ensure target folder exists
        await _ensure_folder(client, folder_url)

        # 3) Upload
        buf.seek(0)
        r = await client.put(file_url, content=buf.read())
        r.raise_for_status()
        log.info("backup uploaded: %s", filename)

        # 4) Cleanup old backups – keep last `retention_days` files
        if retention_days > 0:
            existing = await _list_backups(client, folder_url)
            to_delete = existing[: max(0, len(existing) - retention_days)]
            for old in to_delete:
                old_url = await _webdav_url(
                    nextcloud_url, nextcloud_backup_path, old
                )
                await _delete_file(client, old_url)
                log.info("deleted old backup: %s", old)
