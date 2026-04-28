from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path

import magic
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import get_session
from ..deps import get_current_user
from ..models import Asset, PendingJob, User
from ..schemas import AssetOut

router = APIRouter(prefix="/assets", tags=["assets"])

ALLOWED_MIMES = {
    "image/png", "image/jpeg", "image/webp", "image/gif", "image/heic",
    "application/pdf",
}


def _path_for(sha: str) -> Path:
    base = Path(get_settings().asset_dir)
    return base / sha[:2] / sha[2:4] / sha


@router.post("", response_model=AssetOut, status_code=status.HTTP_201_CREATED)
async def upload(
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
) -> AssetOut:
    max_bytes = get_settings().upload_max_mb * 1024 * 1024
    data = await file.read()
    if len(data) > max_bytes:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "file too large")
    sha = hashlib.sha256(data).hexdigest()
    mime = magic.from_buffer(data[:4096], mime=True) or "application/octet-stream"
    if mime not in ALLOWED_MIMES:
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, f"mime {mime} not allowed")
    existing = (await session.execute(select(Asset).where(Asset.sha256 == sha))).scalar_one_or_none()
    if existing:
        return AssetOut(
            id=uuid.UUID(bytes=existing.id),
            sha256=existing.sha256, mime=existing.mime,
            size=existing.size, filename=existing.filename,
        )
    p = _path_for(sha)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)
    os.chmod(p, 0o640)
    asset = Asset(sha256=sha, mime=mime, size=len(data), filename=file.filename or sha)
    session.add(asset)
    await session.flush()
    # Bild → Vision-OCR-Job einreihen
    if mime.startswith("image/"):
        session.add(
            PendingJob(kind="vision_ocr", payload={"asset_id": uuid.UUID(bytes=asset.id).hex})
        )
    await session.commit()
    await session.refresh(asset)
    return AssetOut(
        id=uuid.UUID(bytes=asset.id),
        sha256=asset.sha256, mime=asset.mime,
        size=asset.size, filename=asset.filename,
    )


@router.get("/{asset_id}")
async def download(
    asset_id: uuid.UUID,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(get_current_user),
):
    a = await session.get(Asset, asset_id.bytes)
    if not a:
        raise HTTPException(status.HTTP_404_NOT_FOUND)
    p = _path_for(a.sha256)
    if not p.exists():
        raise HTTPException(status.HTTP_410_GONE)
    return FileResponse(p, media_type=a.mime, filename=a.filename)
